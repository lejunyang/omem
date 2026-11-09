import { afterEach, expect, test, vi } from "vitest";
import { createDeviceSimulatorService } from "./device-simulator-service";
import { DEFAULT_DEVICE_PROFILES } from "../shared/device-emulation";

afterEach(() => vi.unstubAllGlobals());

// 用不同 frame 和 tab 验证策略作用域，避免“能打开页面”掩盖全站策略被放开的错误。
test("only the simulator's direct document frame may drop embedding restrictions", async () => {
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: vi.fn().mockResolvedValue({}) } });
  const send = vi.fn(async (_tab: number, method: string) => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "shell" } } } : {});
  const service = createDeviceSimulatorService({ attachDebugger: vi.fn(), sendDebuggerCommand: send as never });
  await service.configure({ tab: { id: 1 }, url: "chrome-extension://test/simulator.html?url=https://example.com" } as chrome.runtime.MessageSender, { profile: DEFAULT_DEVICE_PROFILES[0] });
  service.handleEvent(1, undefined, "Page.frameAttached", { frameId: "phone", parentFrameId: "shell" });
  service.handleEvent(1, undefined, "Page.frameAttached", { frameId: "nested", parentFrameId: "phone" });
  const event = { frameId: "phone", resourceType: "Document", responseHeaders: [{ name: "X-Frame-Options", value: "DENY" }] };
  expect(await service.responseHeaders(1, event)).toEqual([]);
  expect(await service.responseHeaders(2, event)).toBeUndefined();
  expect(await service.responseHeaders(1, { ...event, frameId: "nested" })).toBeUndefined();
  expect(await service.responseHeaders(1, { ...event, resourceType: "XHR" })).toBeUndefined();
  service.clear(1);
  expect(await service.responseHeaders(1, event)).toBeUndefined();
});

test("rejects configuration from another extension page before attaching", async () => {
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } });
  const attachDebugger = vi.fn();
  const service = createDeviceSimulatorService({ attachDebugger, sendDebuggerCommand: vi.fn() });
  await expect(service.configure({ tab: { id: 1 }, url: "https://example.com/" } as chrome.runtime.MessageSender, { profile: DEFAULT_DEVICE_PROFILES[0] })).rejects.toThrow("只能在设备模拟器");
  expect(attachDebugger).not.toHaveBeenCalled();
});
