import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boot } from "../src/main.ts";
import { categoryStatus, defaultFor, findAnthropicUrl, keyEnv, listModelEntries, modelChoices, noteModelAccess, tryBackendModel, newestOf, readKeys, refreshModels, setKey, setModelListFetchForTests, testProvider, useKeyHome } from "../src/core/ai-keys.ts";
import { allProfiles, configSchema, keyedProfiles } from "../src/core/config.ts";
import { backendAvailable } from "../src/agents/availability.ts";
import { backendHosts } from "../src/agents/egress-policy.ts";
import { probeProfile } from "../src/agents/probe.ts";

const servers: { close(): Promise<unknown> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

const withProviders = (providers: unknown[], ai: Record<string, unknown> = {}) => configSchema.parse({ ai: { providers, ...ai } });

describe("API-key providers", () => {
  it("generates Codex / Claude Code backends that run with the key and keep their own quota", () => {
    const config = withProviders([
      { id: "team", name: "团队", kind: "openai", backends: ["codex", "codex-cli"] },
      { id: "mine", kind: "anthropic", baseUrl: "https://proxy.example.com", backends: ["claude", "codex"] },
    ]);
    const keyed = keyedProfiles(config);
    // codex is not an Anthropic backend: left out.
    expect(keyed.map((p) => p.id)).toEqual(["codex@team", "codex-cli@team", "claude@mine"]);
    expect(keyed[0]).toMatchObject({ transport: "acp", command: "codex-acp", keyRef: "team", source: "key:team", name: "Codex (ACP · 团队)" });
    expect(keyed[2].env).toMatchObject({ ANTHROPIC_BASE_URL: "https://proxy.example.com" });
    expect(allProfiles(config).some((p) => p.id === "claude@mine")).toBe(true);
    // The key itself is never part of a profile: only the names of the variables it goes in.
    expect(keyed.every((p) => !Object.keys(p.env).some((k) => /KEY|TOKEN/.test(k)))).toBe(true);
    expect(keyed[2].keyVars).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("runs Codex, Claude Code and OpenCode on a third party's key, its addresses and model", () => {
    const home = mkdtempSync(join(tmpdir(), "omem-keys-"));
    useKeyHome(home);
    setKey(home, "ark", "ark-key-1");
    const providers = [{ id: "ark", name: "方舟", kind: "openai-compatible", baseUrl: "https://ark.example.com/api/v3/", model: "ep-123", backends: ["codex", "codex-cli", "claude", "claude-cli", "opencode"] }];
    // No Anthropic address yet: Claude Code is not made.
    expect(keyedProfiles(withProviders(providers)).map((p) => p.id)).toEqual(["codex@ark", "codex-cli@ark", "opencode@ark"]);
    const keyed = keyedProfiles(withProviders([{ ...providers[0], anthropicUrl: "https://ark.example.com/api/compatible" }]));
    const by = Object.fromEntries(keyed.map((p) => [p.id, p]));
    expect(Object.keys(by)).toEqual(["codex@ark", "codex-cli@ark", "claude@ark", "claude-cli@ark", "opencode@ark"]);
    // Codex no longer reads OPENAI_BASE_URL: a model provider of its own, the key in its env_key.
    expect(by["codex@ark"].model).toBe("ep-123");
    expect(by["codex@ark"].env.MODEL_PROVIDER).toBe("omem-key");
    expect(JSON.parse(by["codex@ark"].env.CODEX_CONFIG)).toEqual({ model_provider: "omem-key", model_providers: { "omem-key": { name: "方舟", base_url: "https://ark.example.com/api/v3", env_key: "OMEM_AI_KEY", wire_api: "responses" } } });
    expect(by["codex-cli@ark"].args).toEqual(expect.arrayContaining(["-c", 'model_provider="omem-key"', 'model_providers.omem-key={name="方舟",base_url="https://ark.example.com/api/v3",env_key="OMEM_AI_KEY",wire_api="responses"}']));
    expect(keyEnv(by["codex@ark"])).toEqual({ OMEM_AI_KEY: "ark-key-1" });
    // Claude Code: Bearer token, the model for every tier.
    expect(by["claude@ark"].env).toMatchObject({ ANTHROPIC_BASE_URL: "https://ark.example.com/api/compatible", ANTHROPIC_MODEL: "ep-123", ANTHROPIC_DEFAULT_SONNET_MODEL: "ep-123", CLAUDE_CODE_SUBAGENT_MODEL: "ep-123" });
    expect(keyEnv(by["claude@ark"])).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "ark-key-1", ANTHROPIC_MODEL: "ep-123" });
    // OpenCode: an inline config naming the key by variable, not the key.
    const oc = JSON.parse(by["opencode@ark"].env.OPENCODE_CONFIG_CONTENT);
    expect(oc).toEqual({ model: "omem-key/ep-123", provider: { "omem-key": { npm: "@ai-sdk/openai-compatible", name: "方舟", options: { baseURL: "https://ark.example.com/api/v3", apiKey: "{env:OMEM_AI_KEY}" }, models: { "ep-123": {} } } } });
    expect([...backendHosts(by["opencode@ark"])]).toContain("ark.example.com");
    expect([...backendHosts(by["codex@ark"])]).toContain("ark.example.com");
    // An OpenAI key at another address goes the same way; at the official one, Codex's own key variables.
    const [custom, official] = keyedProfiles(withProviders([{ id: "p", kind: "openai", baseUrl: "https://proxy.example.com/v1", backends: ["codex"] }, { id: "o", kind: "openai", backends: ["codex"] }]));
    expect(custom.env.MODEL_PROVIDER).toBe("omem-key");
    expect(custom.keyVars).toEqual(["OMEM_AI_KEY"]);
    expect(official.keyVars).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    expect(official.env.CODEX_CONFIG).toBeUndefined();
  });

  it("takes a third party's backend models from the key: the named ones, else the listing's that suit", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-keys-"));
    useKeyHome(home);
    setKey(home, "ark", "k");
    mkdirSync(join(home, "cache"), { recursive: true });
    writeFileSync(join(home, "cache", "ai-models.json"), JSON.stringify({ ark: { at: Date.now(), models: ["chat-only", "glm-5", "plain", "seedream"], info: {
      "glm-5": { formats: ["chat", "responses", "anthropic"], type: "LLM", tools: true, efforts: ["minimal", "low", "high"] },
      "chat-only": { formats: ["chat"], type: "LLM" },
      seedream: { type: "ImageGeneration" },
    } } }));
    const pr = { id: "ark", name: "", kind: "ark", backends: ["codex", "claude", "opencode"] };
    let by = Object.fromEntries(keyedProfiles(withProviders([pr])).map((p) => [p.id, p]));
    // Nothing named: the listing's text models that take the backend's format; never the agent's own vendor model.
    expect(by["codex@ark"].keyModels).toEqual(["glm-5", "plain"]);
    expect(by["codex@ark"].model).toBe("glm-5");
    expect(by["opencode@ark"].keyModels).toEqual(["chat-only", "glm-5", "plain"]);
    expect(by["claude@ark"].keyModels).toEqual(["glm-5", "plain"]);
    // Named (several): those only, the first the default; a default picked on the general page counts while it is one of them.
    const cfg = withProviders([{ ...pr, models: ["ep-1", "ep-2"] }]);
    cfg.agents.profiles = [{ ...by["codex@ark"], model: "ep-2" }, { ...by["claude@ark"], model: "gpt-6.1-sol" }] as never;
    by = Object.fromEntries(allProfiles(cfg).filter((p) => p.keyRef).map((p) => [p.id, p]));
    expect(by["codex@ark"]).toMatchObject({ keyModels: ["ep-1", "ep-2"], model: "ep-2" });
    expect(by["claude@ark"].model).toBe("ep-1");
    // A run on another of them gets it at launch.
    expect(keyEnv({ ...by["claude@ark"], model: "ep-2" })).toMatchObject({ ANTHROPIC_MODEL: "ep-2", CLAUDE_CODE_SUBAGENT_MODEL: "ep-2" });
    expect(JSON.parse(keyEnv({ ...by["opencode@ark"], model: "ep-2" }).OPENCODE_CONFIG_CONTENT).model).toBe("omem-key/ep-2");
    // “检测模型” on the general page lists the key's models without starting the agent.
    expect((await probeProfile(by["codex@ark"])).models).toEqual(["ep-1", "ep-2"]);
    // Each model's thinking levels are what the listing says; an endpoint ID it does not name gets none.
    const listedOnly = keyedProfiles(withProviders([pr])).find((p) => p.id === "codex@ark")!;
    expect(await probeProfile(listedOnly)).toMatchObject({ models: ["glm-5", "plain"], effortsByModel: { "glm-5": ["minimal", "low", "high"], plain: [] }, efforts: ["minimal", "low", "high"] });
    // A key that takes endpoint IDs only: nothing from the listing; an endpoint gets the levels of the model it answered as.
    noteModelAccess(home, "ark", { endpointOnly: true, served: [["ep-9", "glm-5-260101"]] });
    expect(keyedProfiles(withProviders([pr])).find((p) => p.id === "codex@ark")!.keyModels).toEqual([]);
    const ep = keyedProfiles(withProviders([{ ...pr, models: ["ep-9"] }])).find((p) => p.id === "codex@ark")!;
    expect(await probeProfile(ep)).toMatchObject({ models: ["ep-9"], effortsByModel: { "ep-9": ["minimal", "low", "high"] } });
  });

  it("reads what a listing says about each model, finds the Anthropic address and calls the model once", async () => {
    const p = { id: "ark", name: "", kind: "openai-compatible" as const, baseUrl: "https://ark.example.com/api/v3", backends: [] };
    const listing = (async () => Response.json({ data: [
      { id: "glm-5", domain: "LLM", api_supported: { "chat/completions": true, responses: true, messages: true }, features: { tools: { function_calling: true } }, effort: { default_level: "high", supported_levels: ["low", "medium", "high", "minimal"] } },
      { id: "seedream", domain: "ImageGeneration" },
      { id: "plain" },
    ] })) as unknown as typeof fetch;
    expect(await listModelEntries(p, "k", listing)).toEqual({ models: ["glm-5", "plain", "seedream"], info: { "glm-5": { formats: ["chat", "responses", "anthropic"], type: "LLM", tools: true, efforts: ["minimal", "low", "medium", "high"] }, seedream: { type: "ImageGeneration" } } });
    const asked: string[] = [];
    const probe = (async (url: string, init: { headers: Record<string, string> }) => {
      asked.push(url);
      expect(init.headers.authorization).toBe("Bearer k");
      return url === "https://ark.example.com/api/compatible/v1/models" ? Response.json({ data: [] }) : new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await findAnthropicUrl(p.baseUrl, "k", probe)).toBe("https://ark.example.com/api/compatible");
    expect(asked[0]).toBe("https://ark.example.com/api/compatible/v1/models");
    expect(await findAnthropicUrl("https://other.example.com/v1", "k", (async () => new Response("", { status: 404 })) as unknown as typeof fetch)).toBeNull();
    const refuse = (async () => Response.json({ error: { code: "ModelIDAccessDisabled", message: "use an endpoint ID. Request id: 42" } }, { status: 404 })) as unknown as typeof fetch;
    // Model names refused: the key takes endpoint IDs only.
    expect(await tryBackendModel({ ...p, model: "glm-5" }, "k", refuse)).toEqual({ ok: false, detail: "模型 glm-5 调不通（OpenAI 格式：这个 key 不能直接用模型名，只能用接入点 ID）", endpointOnly: true });
    // An endpoint answers as the model behind it.
    expect(await tryBackendModel({ ...p, model: "ep-1", anthropicUrl: "https://ark.example.com/api/compatible" }, "k", (async () => Response.json({ model: "glm-5-260101" })) as unknown as typeof fetch)).toEqual({ ok: true, detail: "模型 ep-1 可以调用（背后是 glm-5-260101）", served: "glm-5-260101" });
    expect(await tryBackendModel({ ...p, model: "x" }, "k", (async () => Response.json({ error: { code: "ModelNotOpen", message: "not open" } }, { status: 404 })) as unknown as typeof fetch)).toMatchObject({ ok: false, detail: "模型 x 调不通（OpenAI 格式 404：ModelNotOpen：not open（模型或接入点不对））" });
  });

  it("adds the key at launch and refuses a keyed profile without one", () => {
    const home = mkdtempSync(join(tmpdir(), "omem-keys-"));
    useKeyHome(home);
    const [codex, claude] = keyedProfiles(withProviders([
      { id: "o", kind: "openai", backends: ["codex"] },
      { id: "a", kind: "anthropic", backends: ["claude-cli"] },
    ]));
    expect(() => keyEnv(codex)).toThrow(/还没有填写/);
    expect(backendAvailable(codex, home)).toBe(false);
    setKey(home, "o", "sk-openai-1234");
    setKey(home, "a", "sk-ant-5678");
    expect(keyEnv(codex)).toEqual({ CODEX_API_KEY: "sk-openai-1234", OPENAI_API_KEY: "sk-openai-1234" });
    expect(keyEnv(claude)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-5678" });
    expect(keyEnv({ id: "codex", command: "codex-acp" })).toEqual({});
    setKey(home, "o", null);
    expect(readKeys(home)).toEqual({ a: "sk-ant-5678" });
  });

  it("says whether each category is usable", () => {
    const home = mkdtempSync(join(tmpdir(), "omem-keys-"));
    const config = withProviders([{ id: "o", kind: "openai" }, { id: "j", kind: "typesafe" }, { id: "c", kind: "anthropic" }], {
      voice: { provider: "o" },
      decision: { provider: "j" },
      image: { provider: "c" },
    });
    expect(categoryStatus(config, "voice", home)).toMatchObject({ ready: false, detail: expect.stringMatching(/API key/) });
    setKey(home, "o", "k1");
    setKey(home, "j", "k2");
    setKey(home, "c", "k3");
    expect(categoryStatus(config, "voice", home)).toMatchObject({ ready: true, model: "gpt-live-1" });
    expect(categoryStatus(config, "decision", home)).toMatchObject({ ready: true, model: "jev-latest" });
    // Anthropic has no image model.
    expect(categoryStatus(config, "image", home)).toMatchObject({ ready: false, detail: expect.stringMatching(/不提供/) });
    config.ai.voice.api = "realtime";
    expect(categoryStatus(config, "voice", home).model).toBe("gpt-realtime-2.1");
    config.ai.decision.provider = "startlux";
    expect(categoryStatus(config, "decision", home).ready).toBe(false);
  });

  it("checks a key without spending anything", async () => {
    const calls: [string, Record<string, string>][] = [];
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push([url, init.headers]);
      return new Response("bad key", { status: url.includes("anthropic") ? 401 : 200 });
    }) as unknown as typeof fetch;
    expect(await testProvider({ id: "o", name: "", kind: "openai", backends: [] }, "k", fake)).toEqual({ ok: true, detail: "可用" });
    expect((await testProvider({ id: "a", name: "", kind: "anthropic", backends: [] }, "k", fake)).ok).toBe(false);
    expect(calls[0][0]).toBe("https://api.openai.com/v1/models");
    expect(calls[1]).toEqual(["https://api.anthropic.com/v1/models", { "x-api-key": "k", "anthropic-version": "2023-06-01" }]);
    expect((await testProvider({ id: "x", name: "", kind: "openai", backends: [] }, "", fake)).ok).toBe(false);
    expect((await testProvider({ id: "c", name: "", kind: "cloudflare", backends: [] }, "k", fake)).detail).toMatch(/账号 ID/);
    expect((await testProvider({ id: "c", name: "", kind: "cloudflare", accountId: "0123456789abcdef0123456789abcdef", backends: [] }, "k", fake)).ok).toBe(true);
    expect(calls[2]).toEqual(["https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/models/search?search=clef&per_page=1", { authorization: "Bearer k" }]);
  });

  it("reads the models an account lists, and an empty field takes the newest of the default's family", async () => {
    expect(newestOf(["gpt-image-2.5-sunburst", "gpt-image-2.6-sunburst", "gpt-image-2.6-flare", "gpt-image-2.7-flare-2026-12-01"], "gpt-image-2.6-flare")).toBe("gpt-image-2.6-flare");
    expect(newestOf(["gpt-image-2.5-flare", "gpt-image-2.7-sunburst"], "gpt-image-2.6-flare")).toBe("gpt-image-2.7-sunburst");
    expect(newestOf(["gpt-live-1", "gpt-live-1.5", "gpt-live-mini"], "gpt-live-1")).toBe("gpt-live-1.5");
    expect(newestOf(["clef", "clef-flash", "clef-omni"], "clef-flash")).toBe("clef-flash");
    expect(newestOf([], "gpt-transcribe")).toBe("gpt-transcribe");
    const home = mkdtempSync(join(tmpdir(), "omem-models-"));
    setKey(home, "o", "k");
    const listed = ["gpt-6-luna", "gpt-6.1-sol", "gpt-image-2.5-flare", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-live-1", "gpt-live-1.1", "gpt-realtime-2.1", "gpt-realtime-whisper", "gpt-realtime-translate", "gpt-transcribe", "text-embedding-3-large"];
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(init.headers.authorization).toBe("Bearer k");
      return Response.json({ data: listed.map((id) => ({ id })) });
    }) as unknown as typeof fetch;
    const p = { id: "o", name: "", kind: "openai" as const, backends: [] };
    await refreshModels(home, p, fake);
    expect(modelChoices(home, p, "image")).toEqual({ default: "gpt-image-2.6-flare", models: ["gpt-image-2.5-flare", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"] });
    expect(modelChoices(home, p, "voice.live").default).toBe("gpt-live-1.1");
    expect(modelChoices(home, p, "voice.realtime").models).toEqual(["gpt-realtime-2.1"]);
    expect(modelChoices(home, p, "voice.transcribe")).toEqual({ default: "gpt-transcribe", models: ["gpt-realtime-whisper", "gpt-transcribe"] });
    // The Decisions API takes gpt-6-luna only: the other text models are not offered.
    expect(modelChoices(home, p, "decision")).toEqual({ default: "gpt-6-luna", models: ["gpt-6-luna"] });
    const config = configSchema.parse({ ai: { providers: [p], image: { provider: "o" }, voice: { provider: "o" } } });
    expect(categoryStatus(config, "image", home)).toMatchObject({ ready: true, model: "gpt-image-2.6-flare" });
    expect(categoryStatus(config, "voice", home).model).toBe("gpt-live-1.1");
    expect(defaultFor(config, home, "voice.transcribe")).toBe("gpt-transcribe");
    // A failed refresh keeps the old list and says why.
    await refreshModels(home, p, (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch);
    expect(modelChoices(home, p, "image").default).toBe("gpt-image-2.6-flare");
  });

  it("keeps keys out of config and settings, and drops a removed provider's key", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-keys-"));
    const b = await boot(home, { port: 0, quiet: true, background: false });
    servers.push(b.server);
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(`${b.app.baseUrl}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect((await api("/api/ai/keys/o", "PUT", { key: "sk-x" })).status).toBe(404);
    await api("/api/settings", "PUT", { ai: { ...b.app.config.ai, providers: [{ id: "o", name: "个人", kind: "openai", backends: ["codex"] }] } });
    setModelListFetchForTests((async () => Response.json({ data: [{ id: "gpt-image-2.6-flare" }, { id: "gpt-6-luna" }] })) as unknown as typeof fetch);
    const v = await api("/api/ai/keys/o", "PUT", { key: "sk-secret-abcd" });
    setModelListFetchForTests(null);
    expect(v.body.providers[0]).toMatchObject({ id: "o", hasKey: true, keyHint: "…abcd", listed: { count: 2 } });
    expect(v.body.choices.o.image).toEqual({ default: "gpt-image-2.6-flare", models: ["gpt-image-2.6-flare"] });
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("sk-secret");
    const settings = await api("/api/settings");
    expect(JSON.stringify(settings.body)).not.toContain("sk-secret");
    expect(settings.body.agents.some((p: { id: string }) => p.id === "codex@o")).toBe(true);
    await api("/api/settings", "PUT", { ai: { ...b.app.config.ai, providers: [] } });
    expect(readKeys(home)).toEqual({});
    expect(existsSync(join(home, "secrets", "ai-keys.json"))).toBe(true);
  });
});
