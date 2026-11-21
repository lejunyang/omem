import { describe, expect, it } from "vitest";
import {
  embeddingDraft, embeddingPatch, embeddingProblem, embeddingStatusLine, isModelChange, modelChangeMessage, rerankDraft, rerankPatch,
  rerankProblem, rerankScoresText, sameValue, spacesLine, type EmbeddingStatus,
} from "../web/src/lib/search-settings.ts";
import { effectiveText, levelOf, withSource } from "../web/src/lib/accept-work.ts";
import { accessText, lateText, placeLabel, remoteHref, whoLabel } from "../web/src/lib/progress.ts";

describe("the vector and rerank cards (web/src/lib/search-settings.ts)", () => {
  it("reads a cloud configuration into a draft and writes the same back", () => {
    const cfg = { provider: "api", model: "embed-small", url: "https://api.example.com/v1", keyRef: "demo", apiKeyEnv: "OPENAI_API_KEY", dimensions: 512, batch: 16, timeoutMs: 8000 };
    const d = embeddingDraft(cfg);
    expect(d.source).toBe("api");
    expect(embeddingPatch(d)).toEqual({ provider: "api", model: "embed-small", url: "https://api.example.com/v1", keyRef: "demo", apiKeyEnv: "OPENAI_API_KEY", dimensions: 512, batch: 16, timeoutMs: 8000 });
  });

  it("sends cleared fields as null so the server drops them", () => {
    const d = { ...embeddingDraft({ provider: "api", model: "m", url: "https://api.example.com/v1", keyRef: "demo" }), url: "", key: "", dimensions: "" };
    expect(embeddingPatch(d)).toMatchObject({ url: null, keyRef: null, dimensions: null });
  });

  it("keeps the local model and the cloud model apart when switching", () => {
    const d = embeddingDraft({ provider: "local", model: "Xenova/bge-m3" });
    expect(embeddingPatch({ ...d, source: "api" }).model).toBe("");
    expect(embeddingPatch(d)).toEqual({ provider: "local", model: "Xenova/bge-m3" });
    expect(embeddingProblem({ ...d, source: "api" })).toBe("填模型名");
  });

  it("picks the first plugin provider by default and sends its id as the provider", () => {
    const d = embeddingDraft({ provider: "none" }, [{ id: "plugin:library:vec", name: "示例向量", plugin: "library" }]);
    expect(embeddingPatch({ ...d, source: "plugin" })).toEqual({ provider: "plugin:library:vec" });
    expect(embeddingPatch(d)).toEqual({ provider: "none" });
  });

  it("only takes a draft as unchanged when what it would send is the same", () => {
    const saved = embeddingDraft({ provider: "local", model: "Xenova/bge-small-zh-v1.5" });
    expect(sameValue(embeddingPatch({ ...saved, url: "https://elsewhere.example.com" }), embeddingPatch(saved))).toBe(true);
    expect(sameValue(embeddingPatch({ ...saved, source: "none" }), embeddingPatch(saved))).toBe(false);
  });

  it("says how many vectors go and how many are recomputed", () => {
    const change = { confirmation: "embedding-model", pending: 3, clear: 1200, rebuild: 1350, token: "t" };
    expect(isModelChange(change)).toBe(true);
    expect(isModelChange({ error: "x" })).toBe(false);
    expect(modelChangeMessage(change)).toBe("会清掉现有的 1,200 个向量，再按新模型重算 1,350 条。重算完之前向量检索用不了，全文检索照常。");
    expect(modelChangeMessage({ clear: 0, rebuild: 40 }, true)).toContain("现在还没有向量，再按新模型重算 40 条（只算这个提供者获准的空间）");
  });

  it("writes the status in one line, a failure in red", () => {
    const base: EmbeddingStatus = { provider: "api", kind: "api", model: "embed-small", dimensions: 512, plugin: null, name: null, lastMs: 120, lastError: null, pending: 0, excludedSpaces: [], excludedReason: null, state: "ready" };
    expect(embeddingStatusLine(base)).toEqual({ text: "在用 embed-small · 512 维，上一次 120 ms", bad: false });
    expect(embeddingStatusLine({ ...base, state: "failed", lastError: "HTTP 401", pending: 20 }).text).toBe("最近一次调用出错：HTTP 401，还有 20 条没算向量，后台在补");
    expect(embeddingStatusLine({ ...base, state: "off" }).text).toBe("");
    expect(spacesLine(["shop", "x"], new Map([["shop", "示例商城"]]))).toBe("只用于这些空间：示例商城、x");
    expect(spacesLine([], new Map())).toBe("");
  });

  it("replaces the whole rerank api object and leaves out what is empty", () => {
    const d = rerankDraft({ enabled: true, provider: "local", model: "m", top: 20 });
    expect(rerankPatch(d)).toEqual({ provider: "local" });
    expect(rerankPatch({ ...d, source: "api", model: "rank-1", timeoutSec: 3 })).toEqual({ provider: "api", api: { model: "rank-1", apiKeyEnv: "OPENAI_API_KEY", timeoutMs: 3000 } });
    expect(rerankProblem({ ...d, source: "api", url: "ftp://x" , model: "m" })).toBe("接口地址要以 http:// 或 https:// 开头");
    expect(rerankDraft({ enabled: true, provider: "local", model: "m", top: 20 }, [{ id: "library:rank", label: "示例", plugin: "library", lastMs: null, lastError: null }]).plugin).toBe("plugin:library:rank");
    expect(rerankScoresText([{ index: 0, score: 0.93 }, { index: 2, score: 0.1 }])).toBe("返回 2 个分数，最高 0.930（检测句里的第 1 句）、最低 0.100");
  });
});

describe("accepting work from other devices (web/src/lib/accept-work.ts)", () => {
  it("sets or removes one source and keeps the others", () => {
    expect(withSource({ a: "off" }, "b", "write")).toEqual({ a: "off", b: "write" });
    expect(withSource({ a: "off", b: "read" }, "b", "inherit")).toEqual({ a: "off" });
    expect(withSource(undefined, "a", "read")).toEqual({ a: "read" });
    expect(levelOf(undefined)).toBe("off");
    expect(effectiveText("read", undefined)).toBe("跟随：只接只读");
    expect(effectiveText("read", "off")).toBe("不接");
  });
});

describe("where a board attempt ran (web/src/lib/progress.ts)", () => {
  it("names the other device and the way, and nothing for this machine", () => {
    expect(placeLabel({ mode: "remote", deviceName: "lab-mac", local: false })).toBe("在 lab-mac 跑");
    expect(placeLabel({ mode: "borrow", device: "lab-mac" })).toBe("借 lab-mac 的后端");
    expect(placeLabel({ local: true, deviceName: "本机" })).toBe("");
    expect(whoLabel({ who: { model: "m", local: false, device: "lab-mac", deviceName: "lab-mac", mode: "borrow" } })).toBe("m · 借 lab-mac 的后端");
    expect(lateText({ lateAt: "2026-11-22T01:00:00Z" })).toBe("过了期限才回来，没采用");
    expect(accessText({ mode: "remote", access: "write" })).toBe("可写");
    expect(remoteHref({ remoteUrl: "http://192.0.2.20:4317/#/runs/r1" })).toBe("http://192.0.2.20:4317/#/runs/r1");
    expect(remoteHref({ remoteUrl: "javascript:alert(1)" })).toBeNull();
  });
});
