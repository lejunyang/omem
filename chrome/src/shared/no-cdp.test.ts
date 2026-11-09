import { describe, expect, it } from "vitest";
import { webOriginPatterns } from "../background/page-hook-registration";
import { buildSimulatorRules, simulatorRuleIds } from "../background/simulator-fallback";
import { createCdpDisabledError, isCdpDisabledError, normalizeCdpMode } from "./cdp-mode";
import { parseSimulatorFrameName, simulatorFrameName } from "./device-simulator";
import { applyStaticMock } from "./mock-response";
import { createBlankMockRule } from "./mock-rules";
import { initiatorFromStack, parseV8Stack } from "./page-hook-protocol";

describe("CDP 开关", () => {
  it("只有 on 算开启，缺失和旧数据都算关闭", () => {
    expect(normalizeCdpMode("on")).toBe("on");
    expect(normalizeCdpMode(undefined)).toBe("off");
    expect(normalizeCdpMode(true)).toBe("off");
    expect(normalizeCdpMode("ON")).toBe("off");
  });

  it("关闭时的错误可以被识别", () => {
    const error = createCdpDisabledError("禁用缓存");
    expect(isCdpDisabledError(error)).toBe(true);
    expect(error.message).toBe("禁用缓存需要「CDP 增强」。");
    expect(isCdpDisabledError(new Error("x"))).toBe(false);
  });
});

describe("parseV8Stack", () => {
  const stack = [
    "Error",
    "    at remember (chrome-extension://abc/inject/page-hook.js:1:200)",
    "    at window.fetch (chrome-extension://abc/inject/page-hook.js:1:900)",
    "    at async loadOrders (https://shop.example.com/assets/app.js:120:15)",
    "    at https://shop.example.com/assets/vendor.js:3:44",
    "    at <anonymous>",
    "    at new Promise (<anonymous>)"
  ].join("\n");

  it("解析出函数名、URL 和 0 起的行列号，跳过匿名帧", () => {
    const frames = parseV8Stack(stack).filter((frame) => !frame.url.startsWith("chrome-extension://"));
    expect(frames).toEqual([
      { functionName: "loadOrders", url: "https://shop.example.com/assets/app.js", lineNumber: 119, columnNumber: 14 },
      { functionName: "(anonymous)", url: "https://shop.example.com/assets/vendor.js", lineNumber: 2, columnNumber: 43 }
    ]);
    expect(initiatorFromStack(frames)).toMatchObject({ type: "script", url: "https://shop.example.com/assets/app.js", lineNumber: 119 });
  });

  it("空栈返回空数组", () => {
    expect(parseV8Stack(undefined)).toEqual([]);
    expect(initiatorFromStack([])).toMatchObject({ url: "", lineNumber: null });
  });
});

describe("页面钩子注册范围", () => {
  it("只保留网页匹配模式，<all_urls> 展开成 http / https", () => {
    expect(webOriginPatterns(["https://shop.example.com/*", "file:///*", "<all_urls>", "chrome://*/*"])).toEqual([
      "http://*/*",
      "https://*/*",
      "https://shop.example.com/*"
    ]);
    expect(webOriginPatterns(undefined)).toEqual([]);
  });
});

describe("模拟器的 DNR 规则", () => {
  it("只作用于模拟器标签页：子 frame 去掉禁止嵌入的头，所有请求换 UA", () => {
    const [uaId, frameId] = simulatorRuleIds(42);
    const rules = buildSimulatorRules(42, "Mozilla/5.0 (iPhone)");
    expect(rules.map((rule) => rule.id).sort()).toEqual([uaId, frameId].sort());
    for (const rule of rules) expect(rule.condition.tabIds).toEqual([42]);
    const frame = rules.find((rule) => rule.id === frameId)!;
    expect(frame.condition.resourceTypes).toEqual(["sub_frame"]);
    expect(frame.action.responseHeaders?.map((header) => header.header)).toEqual(["x-frame-options", "content-security-policy"]);
    expect(rules.find((rule) => rule.id === uaId)?.action.requestHeaders).toEqual([{ header: "user-agent", operation: "set", value: "Mozilla/5.0 (iPhone)" }]);
  });

  it("UA 为空时不加改 UA 的规则；不同标签页的规则 id 不冲突", () => {
    expect(buildSimulatorRules(7, "")).toHaveLength(1);
    expect(simulatorRuleIds(7)).not.toEqual(simulatorRuleIds(8));
    expect(new Set([...simulatorRuleIds(7), ...simulatorRuleIds(8)]).size).toBe(4);
  });

  it("frame 名带参数能还原，普通名字返回 null", () => {
    const params = {
      environment: { width: 393, height: 852, deviceScaleFactor: 3, touchEnabled: true, maxTouchPoints: 5, landscape: false },
      userAgent: "UA",
      platform: "iPhone"
    };
    expect(parseSimulatorFrameName(simulatorFrameName(params))).toEqual(params);
    expect(parseSimulatorFrameName(simulatorFrameName(null))).toBeNull();
    expect(parseSimulatorFrameName("advanced-network-device-frame:{bad")).toBeNull();
    expect(parseSimulatorFrameName("other")).toBeNull();
  });
});

describe("静态 Mock 计算", () => {
  const input = {
    request: { method: "GET", url: "", origin: "", protocol: "", host: "", hostname: "", port: "", pathname: "", search: "", queryString: "", query: {}, headers: {}, body: "" },
    response: { status: 200, headers: { "content-length": "10", "x-a": "1" }, body: "original" }
  };

  it("替换响应头保留原正文，去掉 content-length", () => {
    const rule = { ...createBlankMockRule({ id: "r", groupId: "default", now: 0 }), action: "replace-headers" as const };
    const output = applyStaticMock(rule, input);
    expect(output.body).toBe("original");
    expect(output.headers["x-mock"]).toBe("1");
    expect(output.headers["content-length"]).toBeUndefined();
  });

  it("替换响应体用规则里的正文", () => {
    const rule = { ...createBlankMockRule({ id: "r", groupId: "default", now: 0 }), action: "replace-body" as const, responseBody: '{"ok":true}' };
    expect(applyStaticMock(rule, input).body).toBe('{"ok":true}');
  });
});
