import { installSimulatorEnvironment } from "../shared/simulator-environment";
import { getOrientedDeviceSize, normalizeDeviceProfile, toUserAgentOverrideParams, type DeviceProfile } from "../shared/device-emulation";
import { allowSimulatorEmbedding } from "../shared/device-simulator";

interface Dependencies {
  attachDebugger: (tabId: number) => Promise<void>;
  sendDebuggerCommand: <T = unknown>(tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<T>;
}
interface FrameTree { frame: { id: string }; childFrames?: FrameTree[] }

// 独立模拟器复用现有 debugger 连接，但不覆盖原页面的设备状态，也不增加全站访问权限。
export function createDeviceSimulatorService(deps: Dependencies) {
  const tabs = new Map<number, { profile: DeviceProfile; sessions: Map<string, string>; orientation: "portrait" | "landscape"; rootFrame: string; frames: Set<string> }>();
  const { attachDebugger, sendDebuggerCommand: send } = deps;

  // 必须由模拟器自身发起；sender.tab.id 是真实目标，绝不信任消息中传来的任意 tabId。
  async function configure(sender: chrome.runtime.MessageSender, message: { profile?: unknown; orientation?: unknown }) {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number" || sender.url?.split("?")[0] !== chrome.runtime.getURL("simulator.html")) {
      throw new Error("只能在设备模拟器页面中应用此设置。");
    }
    const profile = normalizeDeviceProfile(message.profile);
    if (!profile) throw new Error("设备配置无效。");
    await attachDebugger(tabId);
    await send(tabId, "Page.enable");
    const { frameTree } = await send<{ frameTree: FrameTree }>(tabId, "Page.getFrameTree");
    tabs.set(tabId, { profile, orientation: message.orientation === "landscape" ? "landscape" : "portrait", sessions: tabs.get(tabId)?.sessions ?? new Map(), rootFrame: frameTree.frame.id, frames: new Set(frameTree.childFrames?.map((child) => child.frame.id)) });
    await send(tabId, "Network.enable");
    // 外壳保持桌面原生坐标系，避免顶层触摸代理在 OOPIF 中产生错位或吞掉鼠标事件。
    await send(tabId, "Emulation.setUserAgentOverride", { ...toUserAgentOverrideParams(profile) });
    // 使用同样的 Response 拦截范围，避免与用户在模拟器 tab 中开启 Mock 时互相覆盖 Fetch patterns。
    await send(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
    // 跨域 iframe 会进入独立 renderer；在首个脚本执行前配置子 session，否则 UA/touch 只作用于外壳。
    await send(tabId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe", exclude: false }, { exclude: true }] });
    return { ok: true };
  }

  // 仅直接子 frame 的文档响应允许嵌入。普通请求、原 tab、页面里的第三方 iframe 均保持原策略。
  async function responseHeaders(tabId: number, event: {
    frameId?: string; resourceType?: string; responseHeaders?: Array<{ name: string; value: string }>;
  }, sessionId?: string) {
    if (!tabs.has(tabId) || event.resourceType !== "Document" || !event.frameId) return undefined;
    if (sessionId) {
      if (tabs.get(tabId)?.sessions.get(sessionId) !== event.frameId) return undefined;
      return changedEmbeddingHeaders(event.responseHeaders ?? []);
    }
    // 首次导航的 Response 阶段 getFrameTree 可能还不包含新 frame；用 frameAttached 的父子关系判定。
    if (!tabs.get(tabId)?.frames.has(event.frameId)) return undefined;
    return changedEmbeddingHeaders(event.responseHeaders ?? []);
  }

  // 只监听外壳直接附加的子目标，不递归放开网页内第三方 frame 的嵌入限制。
  function handleEvent(tabId: number, parentSession: string | undefined, method: string, params: unknown) {
    const state = tabs.get(tabId);
    if (!state || parentSession) return;
    const event = params as { sessionId?: string; targetInfo?: { targetId: string }; frameId?: string; parentFrameId?: string; reason?: string };
    if (method === "Page.frameAttached" && event.frameId && event.parentFrameId === state.rootFrame) state.frames.add(event.frameId);
    if (method === "Page.frameDetached" && event.frameId && event.reason !== "swap") state.frames.delete(event.frameId);
    if (method === "Target.detachedFromTarget" && event.sessionId) state.sessions.delete(event.sessionId);
    if (method !== "Target.attachedToTarget" || !event.sessionId || !event.targetInfo) return;
    const sessionId = event.sessionId;
    if (!state.frames.has(event.targetInfo.targetId)) {
      void send(tabId, "Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      return;
    }
    state.sessions.set(sessionId, event.targetInfo.targetId);
    void (async () => {
      try {
        // 必须先启用 Page：否则 OOPIF 上 addScript 会返回成功却不执行，不能只检查命令回执。
        await send(tabId, "Page.enable", {}, sessionId);
        await send(tabId, "Runtime.enable", {}, sessionId);
        await send(tabId, "Network.enable", {}, sessionId);
        await send(tabId, "Emulation.setUserAgentOverride", { ...toUserAgentOverrideParams(state.profile) }, sessionId);
        const size = getOrientedDeviceSize(state.profile, state.orientation);
        const source = `(${installSimulatorEnvironment.toString()})(${JSON.stringify({ ...size, deviceScaleFactor: state.profile.deviceScaleFactor, touchEnabled: state.profile.touchEnabled, maxTouchPoints: state.profile.maxTouchPoints, landscape: state.orientation === "landscape" })})`;
        await send(tabId, "Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true }, sessionId);
        await send(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] }, sessionId);
      } catch (error) {
        void chrome.runtime.sendMessage({ type: "advanced-network:simulator-error", tabId, error: String(error) }).catch(() => undefined);
      } finally {
        // 即使某个实验命令不支持也必须解除暂停，不能让目标网页永久挂起。
        await send(tabId, "Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      }
    })();
  }

  return { configure, responseHeaders, handleEvent, has: (tabId: number) => tabs.has(tabId), clear: (tabId: number) => tabs.delete(tabId) };
}

// 无需修改的文档继续正常流式加载，避免大页面无意义地进入正文缓冲路径。
function changedEmbeddingHeaders(headers: Array<{ name: string; value: string }>) {
  const next = allowSimulatorEmbedding(headers);
  return JSON.stringify(next) === JSON.stringify(headers) ? undefined : next;
}
