import { cropBox, MAX_CANVAS_SIDE, type PickRecord, pickTitle } from "../shared/pick";
import { isPickMessageType, type PickCommitPayload, type PickMessage, type PickResponse, type PickStartMode } from "../shared/pick-messages";
import { addPickRecord, broadcastPickChanged } from "../shared/pick-store";

// 拾取的后台部分：注入页面界面、截图（captureVisibleTab 或 CDP）、裁剪 / 拼接、存进 IndexedDB。

interface Dependencies {
  attachDebugger: (tabId: number) => Promise<void>;
  sendDebuggerCommand: <T = unknown>(tabId: number, method: string, params?: Record<string, unknown>) => Promise<T>;
  isCdpEnabled: () => boolean;
  /** 整页截图用完 CDP 后按需断开（没有其他功能在用时） */
  releaseDebugger?: (tabId: number) => Promise<void>;
}

const OVERLAY_FILE = "inject/pick-overlay.js";
// Chrome 限制每秒最多 2 次 captureVisibleTab，留一点余量。
const CAPTURE_INTERVAL_MS = 560;
const THUMB_WIDTH = 360;

export const PICK_COMMAND_ELEMENT = "pick-element";
export const PICK_COMMAND_BASKET = "open-pick-basket";

export function createPickService(deps: Dependencies) {
  const frames = new Map<number, Array<{ scrollY: number; dataUrl: string }>>();
  let lastCapture = 0;

  async function captureVisible(windowId: number): Promise<string> {
    const wait = lastCapture + CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCapture = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  }

  async function start(mode: PickStartMode, tabId?: number): Promise<PickResponse> {
    const tab = typeof tabId === "number" ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (typeof tab?.id !== "number") return { ok: false, error: "没有找到当前标签页。" };
    if (tab.url && !/^(https?|file):/.test(tab.url)) return { ok: false, error: "浏览器内置页面和扩展商店不能拾取。" };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [OVERLAY_FILE] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (startMode: string) => (window as unknown as { __omemPick?: { activate(mode: string): void } }).__omemPick?.activate(startMode),
        args: [mode]
      });
      return { ok: true };
    } catch {
      // 从侧栏发起时没有 activeTab：需要用户授权，或改用工具栏图标 / 快捷键。
      return { ok: false, needsPermission: true, error: "没有这个页面的访问权限。" };
    }
  }

  async function commit(payload: PickCommitPayload, sender: chrome.runtime.MessageSender): Promise<PickResponse> {
    const tab = sender.tab;
    if (typeof tab?.id !== "number" || typeof tab.windowId !== "number") return { ok: false, error: "只能从页面里提交。" };
    let image: Blob;
    let notice = payload.page?.truncated ? `页面太长，只截了前 ${payload.page.height}px。` : undefined;
    if (payload.kind === "page") {
      const buffered = frames.get(tab.id) ?? [];
      frames.delete(tab.id);
      image = buffered.length ? await stitch(buffered, payload) : await capturePageWithCdp(tab.id, payload);
      if (buffered.length > 1) notice = [notice, "逐屏拼接：固定定位的元素只保留在第一屏。"].filter(Boolean).join(" ");
    } else {
      const dataUrl = await captureVisible(tab.windowId);
      image = await crop(dataUrl, payload);
    }
    const bitmap = await createImageBitmap(image);
    const thumb = await scaleTo(bitmap, THUMB_WIDTH);
    const record: Omit<PickRecord, "seq"> = {
      id: crypto.randomUUID(),
      kind: payload.kind,
      title: pickTitle(payload.kind, payload.kind === "element" ? payload.elements[0]?.rect ?? payload.rect : payload.rect, payload.elements[0]),
      note: "",
      pageUrl: payload.pageUrl,
      pageTitle: payload.pageTitle,
      createdAt: Date.now(),
      rect: payload.rect,
      image,
      thumb,
      imageSize: { width: bitmap.width, height: bitmap.height },
      elements: payload.elements,
      spacings: payload.spacings,
      ...(notice ? { notice } : {})
    };
    bitmap.close();
    const saved = await addPickRecord(record);
    broadcastPickChanged();
    return { ok: true, seq: saved.seq, id: saved.id };
  }

  async function capturePageWithCdp(tabId: number, payload: PickCommitPayload): Promise<Blob> {
    const page = payload.page ?? { width: payload.viewport.width, height: payload.viewport.height, truncated: false };
    await deps.attachDebugger(tabId);
    try {
      const result = await deps.sendDebuggerCommand<{ data: string }>(tabId, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: page.width, height: page.height, scale: 1 }
      });
      return await (await fetch(`data:image/png;base64,${result.data}`)).blob();
    } finally {
      await deps.releaseDebugger?.(tabId).catch(() => undefined);
    }
  }

  async function handleMessage(message: PickMessage, sender: chrome.runtime.MessageSender): Promise<PickResponse | { ok: boolean; cdp?: boolean }> {
    switch (message.type) {
      case "omem-pick:start":
        return start(message.mode, message.tabId);
      case "omem-pick:open-basket": {
        const windowId = message.windowId ?? sender.tab?.windowId;
        if (typeof windowId !== "number") return { ok: false, error: "没有找到窗口。" };
        // 需要用户手势：从页面里的按钮转过来时可能被拒，界面会提示改用快捷键。
        return chrome.sidePanel.open({ windowId }).then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error: String(error) })
        );
      }
      case "omem-pick:grab-begin":
        if (typeof sender.tab?.id === "number") frames.set(sender.tab.id, []);
        return { ok: true, cdp: deps.isCdpEnabled() };
      case "omem-pick:grab": {
        const tab = sender.tab;
        if (typeof tab?.id !== "number" || typeof tab.windowId !== "number") return { ok: false, error: "只能从页面里截图。" };
        const dataUrl = await captureVisible(tab.windowId);
        frames.get(tab.id)?.push({ scrollY: message.scrollY, dataUrl });
        return { ok: true };
      }
      case "omem-pick:commit":
        return commit(message.payload, sender);
      default:
        return { ok: false, error: "未知的拾取消息。" };
    }
  }

  async function handleCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
    if (command === PICK_COMMAND_BASKET && typeof tab?.windowId === "number") {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    }
    if (command === PICK_COMMAND_ELEMENT) await start("element", tab?.id);
  }

  return {
    handleCommand,
    handleMessage: (message: unknown, sender: chrome.runtime.MessageSender) => handleMessage(message as PickMessage, sender),
    isPickMessage: (message: unknown) => isPickMessageType((message as { type?: unknown } | null)?.type),
    clearTab: (tabId: number) => frames.delete(tabId)
  };
}

async function decode(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

async function crop(dataUrl: string, payload: PickCommitPayload): Promise<Blob> {
  const bitmap = await decode(dataUrl);
  // 截图像素 / 视口 CSS 宽度 = 设备像素比 × 页面缩放，直接用比值，不依赖页面报告的 devicePixelRatio。
  const scale = bitmap.width / payload.viewport.width;
  const { sx, sy, sw, sh } = cropBox(payload.clip, scale, bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d")!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

async function stitch(buffered: Array<{ scrollY: number; dataUrl: string }>, payload: PickCommitPayload): Promise<Blob> {
  const first = await decode(buffered[0].dataUrl);
  const scale = first.width / payload.viewport.width;
  const height = Math.min(MAX_CANVAS_SIDE, Math.round((payload.page?.height ?? payload.viewport.height) * scale));
  const canvas = new OffscreenCanvas(first.width, height);
  const context = canvas.getContext("2d")!;
  context.drawImage(first, 0, Math.round(buffered[0].scrollY * scale));
  first.close();
  // 按顺序画，后一屏覆盖和前一屏重叠的部分（最后一屏贴底，重叠最多）。
  for (const frame of buffered.slice(1)) {
    const bitmap = await decode(frame.dataUrl);
    context.drawImage(bitmap, 0, Math.round(frame.scrollY * scale));
    bitmap.close();
  }
  return canvas.convertToBlob({ type: "image/png" });
}

async function scaleTo(bitmap: ImageBitmap, width: number): Promise<Blob> {
  const ratio = Math.min(1, width / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  // 缩略图高度封顶，整页长图只取顶部一段，列表里不会被拉得很长。
  const h = Math.max(1, Math.min(Math.round(bitmap.height * ratio), Math.round(w * 1.2)));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, bitmap.width, h / ratio, 0, 0, w, h);
  return canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
}
