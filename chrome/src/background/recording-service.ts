import {
  clipBody,
  findPartner,
  mergeRequests,
  mergesWith,
  redactHeaders,
  redactUrl,
  type RecordedRequest,
  type RecordedStep,
  type RecordingSession,
  type StepAction,
  webRequestType
} from "../shared/recording";
import { isRecordMessage, RECORD_CHANGED_MESSAGE, type RecordMessage, type RecordResponse } from "../shared/recording-messages";
import * as store from "../shared/recording-store";

// 录制的后台部分：在被录的标签页里注入记录脚本、把动作写成步骤、用 chrome.webRequest 记请求（只观察，不拦截，
// 不用调试器）、每步截一张可视区、工具栏图标上显示 REC。DevTools 页面开着时会把带响应体的记录送过来，在这里合并。
// service worker 随时会被回收：每个事件都直接写 IndexedDB（recording-store），醒来时读回当前录制；
// 还没读回时到的 webRequest 事件先排队，读回后再处理。

const RECORDER_FILE = "inject/recorder.js";
// 和拾取共用 captureVisibleTab 每秒 2 次的上限：录制最多每 1.1 秒一张。
const SHOT_INTERVAL_MS = 1100;
const SHOT_DELAY_MS = 450;
const MAX_SHOTS = 200;
const SHOT_WIDTH = 1280;
const RECENT_LIMIT = 400;
const INFLIGHT_LIMIT = 3000;

type BodyDetails = chrome.webRequest.WebRequestBodyDetails;

export function createRecordingService() {
  let session: RecordingSession | null = null;
  let loaded = false;
  const waiting: Array<() => void> = [];
  const ready = store
    .getSession()
    .then((stored) => {
      session = stored;
      if (stored?.status === "recording") void setBadge(true);
    })
    .catch(() => undefined)
    .finally(() => {
      loaded = true;
      for (const run of waiting.splice(0)) run();
    });

  const inflight = new Map<string, RecordedRequest>();
  const recent: RecordedRequest[] = [];
  const lastUrl = new Map<number, string>();
  const lastStepByTab = new Map<number, RecordedStep>();
  const visitTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let lastShot = 0;
  let shots = 0;
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const whenReady = (run: () => void) => (loaded ? run() : void waiting.push(run));
  const recording = (tabId?: number) => session?.status === "recording" && (tabId === undefined || session.tabIds.includes(tabId));

  /** 通知侧栏刷新；连续的变化 300 毫秒内只发一次。 */
  function changed(): void {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = undefined;
      void chrome.runtime.sendMessage({ type: RECORD_CHANGED_MESSAGE }).catch(() => undefined);
    }, 300);
  }

  /** 计数随请求变化很频繁：攒一下再写。 */
  function saveSoon(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (session) void store.putSession(session).catch(() => undefined);
    }, 800);
  }

  async function setBadge(on: boolean): Promise<void> {
    await chrome.action.setBadgeText({ text: on ? "REC" : "" }).catch(() => undefined);
    if (on) await chrome.action.setBadgeBackgroundColor({ color: "#d93025" }).catch(() => undefined);
  }

  /** 在标签页里注入记录脚本并开始记；页面每次加载完都要再来一次（注入的脚本不跨页面）。 */
  async function inject(tabId: number): Promise<boolean> {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [RECORDER_FILE] });
      await chrome.scripting.executeScript({ target: { tabId }, func: () => (window as unknown as { __omemRecorder?: { start(): void } }).__omemRecorder?.start() });
      return true;
    } catch {
      return false;
    }
  }

  async function stopIn(tabId: number): Promise<void> {
    await chrome.scripting
      .executeScript({ target: { tabId }, func: () => (window as unknown as { __omemRecorder?: { stop(): void } }).__omemRecorder?.stop() })
      .catch(() => undefined);
  }

  // ---------- 步骤 ----------

  async function addStep(tabId: number, kind: RecordedStep["kind"], action: StepAction, at: number): Promise<RecordedStep> {
    const previous = lastStepByTab.get(tabId);
    const next = { at, tabId, kind, action };
    const step: RecordedStep = mergesWith(previous, next) ? { ...previous!, at, action: { ...previous!.action, ...action } } : { id: crypto.randomUUID(), ...next };
    await store.putStep(step);
    lastStepByTab.set(tabId, step);
    changed();
    return step;
  }

  /** 截图缩到 1280 宽以内的 JPEG：一次录制几十张，原图太大。 */
  async function shrink(dataUrl: string): Promise<Blob> {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width <= SHOT_WIDTH) {
      bitmap.close();
      return blob;
    }
    const ratio = SHOT_WIDTH / bitmap.width;
    const canvas = new OffscreenCanvas(SHOT_WIDTH, Math.max(1, Math.round(bitmap.height * ratio)));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  }

  /**
   * 给一步截可视区：等页面反应一下再截；只截正在显示的标签页（captureVisibleTab 截的是窗口里显示的那个），
   * 太密时跳过（等超过 3 秒就不截了），一次录制最多 200 张。
   */
  function shootSoon(step: RecordedStep, delay = SHOT_DELAY_MS): void {
    if (shots >= MAX_SHOTS) return;
    setTimeout(() => void shoot(step.id, step.tabId).catch(() => undefined), delay);
  }

  async function shoot(stepId: string, tabId: number): Promise<void> {
    if (!recording(tabId)) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.active || typeof tab.windowId !== "number") return;
    const wait = lastShot + SHOT_INTERVAL_MS - Date.now();
    if (wait > 3000) return;
    lastShot = Math.max(Date.now(), lastShot + SHOT_INTERVAL_MS);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 72 });
    const blob = await shrink(dataUrl);
    // 截图期间这一步可能被删了
    const step = await store.getStep(stepId);
    if (!step) return;
    await store.putImage(stepId, blob);
    const updated = { ...step, screenshot: stepId };
    await store.putStep(updated);
    if (lastStepByTab.get(tabId)?.id === stepId) lastStepByTab.set(tabId, updated);
    shots += 1;
    changed();
  }

  /** 页面地址变了（跳转、前端路由）：记一步“打开页面”；同一个地址重新加载不算。 */
  function scheduleVisit(tabId: number): void {
    clearTimeout(visitTimers.get(tabId));
    visitTimers.set(
      tabId,
      setTimeout(async () => {
        visitTimers.delete(tabId);
        if (!recording(tabId)) return;
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab?.url || !/^(https?|file):/.test(tab.url)) return;
        const url = redactUrl(tab.url);
        if (lastUrl.get(tabId) === url) return;
        lastUrl.set(tabId, url);
        const step = await addStep(tabId, "action", { kind: "navigate", url, title: tab.title ?? "" }, Date.now());
        if (tab.status === "complete") shootSoon(step, 200);
      }, 700)
    );
  }

  // ---------- 请求 ----------

  function decodeBody(body: BodyDetails["requestBody"]): { requestBody?: string; requestBodyTruncated?: boolean } {
    if (!body || body.error) return {};
    let text = "";
    if (body.formData) {
      const params = new URLSearchParams();
      for (const [key, values] of Object.entries(body.formData)) for (const value of values) params.append(key, String(value));
      text = params.toString();
    } else if (body.raw?.length) {
      const bytes = body.raw.filter((part) => part.bytes).map((part) => new Uint8Array(part.bytes!));
      if (!bytes.length) return {};
      const merged = new Uint8Array(bytes.reduce((n, part) => n + part.length, 0));
      let offset = 0;
      for (const part of bytes) {
        merged.set(part, offset);
        offset += part.length;
      }
      text = new TextDecoder("utf-8", { fatal: false }).decode(merged.subarray(0, 512 * 1024));
    }
    const clipped = clipBody(text);
    return clipped.body ? { requestBody: clipped.body, requestBodyTruncated: clipped.truncated } : {};
  }

  /** 一条记录落定：先找另一边记的同一个请求合并，再写库。 */
  async function keep(incoming: RecordedRequest): Promise<void> {
    if (!session) return;
    const partner = findPartner(recent, incoming);
    let record = incoming;
    if (partner) {
      record = mergeRequests(partner, incoming);
      recent[recent.indexOf(partner)] = record;
      if (record.responseBody !== undefined && partner.responseBody === undefined) session.bodies = (session.bodies ?? 0) + 1;
    } else {
      recent.push(record);
      if (recent.length > RECENT_LIMIT) recent.shift();
      session.requests = (session.requests ?? 0) + 1;
      if (record.responseBody !== undefined) session.bodies = (session.bodies ?? 0) + 1;
    }
    await store.putRequest(record);
    saveSoon();
    changed();
  }

  function finish(requestId: string, patch: Partial<RecordedRequest>): void {
    const entry = inflight.get(requestId);
    if (!entry) return;
    inflight.delete(requestId);
    void keep({ ...entry, ...patch }).catch(() => undefined);
  }

  const onBeforeRequest = (details: BodyDetails) =>
    whenReady(() => {
      if (!recording(details.tabId) || !/^(https?|wss?):/.test(details.url)) return;
      inflight.set(details.requestId, {
        id: `wr-${details.requestId}-${Math.round(details.timeStamp)}`,
        tabId: details.tabId,
        at: details.timeStamp,
        method: details.method,
        url: redactUrl(details.url),
        type: webRequestType(details.type),
        ...decodeBody(details.requestBody),
        source: "webRequest"
      });
      if (inflight.size > INFLIGHT_LIMIT) inflight.delete(inflight.keys().next().value!);
    });

  const onSendHeaders = (details: chrome.webRequest.WebRequestHeadersDetails) =>
    whenReady(() => {
      const entry = inflight.get(details.requestId);
      if (entry) entry.requestHeaders = redactHeaders(details.requestHeaders);
    });

  const responsePatch = (details: chrome.webRequest.WebResponseCacheDetails) => {
    const entry = inflight.get(details.requestId);
    const contentType = details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
    return { status: details.statusCode, durationMs: entry ? Math.round(details.timeStamp - entry.at) : null, mimeType: contentType.split(";")[0], responseHeaders: redactHeaders(details.responseHeaders) };
  };

  // 重定向的每一跳各算一个请求：同一个 requestId 接着会再走一次 onBeforeRequest。
  const onBeforeRedirect = (details: chrome.webRequest.WebRedirectionResponseDetails) => whenReady(() => finish(details.requestId, responsePatch(details)));
  const onCompleted = (details: chrome.webRequest.WebResponseCacheDetails) => whenReady(() => finish(details.requestId, responsePatch(details)));
  const onErrorOccurred = (details: chrome.webRequest.WebResponseErrorDetails) =>
    whenReady(() => {
      const entry = inflight.get(details.requestId);
      finish(details.requestId, { error: details.error, durationMs: entry ? Math.round(details.timeStamp - entry.at) : null });
    });

  /** DevTools 页面送来的记录（带响应体）：和 webRequest 记的同一个请求合并，没有对应的就单独记。 */
  async function takeHar(tabId: number, entries: RecordedRequest[]): Promise<void> {
    if (!recording(tabId)) return;
    for (const entry of entries) await keep({ ...entry, tabId, source: "devtools" });
  }

  // ---------- 消息 ----------

  async function start(goal: string, tabId: number): Promise<RecordResponse> {
    if (session?.status === "recording") return { ok: false, error: "已经在录制。" };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url || !/^(https?|file):/.test(tab.url)) return { ok: false, error: "浏览器内置页面和扩展商店不能录制，先切到要录的网页。" };
    if (!(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) return { ok: false, needsPermission: true, error: "录制要读页面和请求，需要授权所有网站。" };
    await store.clearRecording();
    session = { id: crypto.randomUUID(), goal, tabIds: [tabId], startedAt: Date.now(), status: "recording", startUrl: redactUrl(tab.url), startTitle: tab.title ?? "", requests: 0, bodies: 0 };
    await store.putSession(session);
    inflight.clear();
    recent.length = 0;
    lastStepByTab.clear();
    lastUrl.clear();
    lastUrl.set(tabId, redactUrl(tab.url));
    shots = 0;
    if (!(await inject(tabId))) {
      await store.clearRecording();
      session = null;
      return { ok: false, needsPermission: true, error: "没能在这个页面里开始记录：确认已授权所有网站，或刷新页面后再试。" };
    }
    await setBadge(true);
    changed();
    return { ok: true };
  }

  async function addTab(tabId: number): Promise<RecordResponse> {
    if (!session || session.status !== "recording") return { ok: false, error: "没有在录制。" };
    if (!session.tabIds.includes(tabId)) {
      session.tabIds = [...session.tabIds, tabId];
      await store.putSession(session);
    }
    const ok = await inject(tabId);
    scheduleVisit(tabId);
    changed();
    return ok ? { ok: true } : { ok: false, error: "这个标签页不能录制（浏览器内置页面或没有权限）。" };
  }

  async function stop(): Promise<RecordResponse> {
    if (!session) return { ok: false, error: "没有在录制。" };
    session.status = "stopped";
    session.stoppedAt = Date.now();
    inflight.clear();
    await store.putSession(session);
    await Promise.all(session.tabIds.map(stopIn));
    await setBadge(false);
    changed();
    return { ok: true };
  }

  async function resume(): Promise<RecordResponse> {
    if (!session) return { ok: false, error: "没有可以继续的录制。" };
    session.status = "recording";
    session.stoppedAt = undefined;
    await store.putSession(session);
    await Promise.all(session.tabIds.map(inject));
    await setBadge(true);
    changed();
    return { ok: true };
  }

  async function discard(): Promise<RecordResponse> {
    const tabs = session?.tabIds ?? [];
    session = null;
    inflight.clear();
    recent.length = 0;
    lastStepByTab.clear();
    await store.clearRecording();
    await Promise.all(tabs.map(stopIn));
    await setBadge(false);
    changed();
    return { ok: true };
  }

  /** 标记用的标签页：指定的、当前显示的被录标签页，或第一个被录的。 */
  async function markTab(tabId?: number): Promise<number | null> {
    if (!session) return null;
    if (typeof tabId === "number" && session.tabIds.includes(tabId)) return tabId;
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return typeof active?.id === "number" && session.tabIds.includes(active.id) ? active.id : session.tabIds[0] ?? null;
  }

  async function point(tabId?: number): Promise<RecordResponse> {
    const target = await markTab(tabId);
    if (target === null || !recording()) return { ok: false, error: "录制中才能指出元素。" };
    if (!(await inject(target))) return { ok: false, error: "这个页面不能指出元素。" };
    await chrome.tabs.update(target, { active: true }).catch(() => undefined);
    await chrome.scripting
      .executeScript({ target: { tabId: target }, func: () => (window as unknown as { __omemRecorder?: { point(): void } }).__omemRecorder?.point() })
      .catch(() => undefined);
    return { ok: true };
  }

  async function mark(note: string, element: StepAction | null, tabId?: number): Promise<RecordResponse> {
    const target = await markTab(tabId);
    if (target === null || !recording()) return { ok: false, error: "录制中才能加标记。" };
    const tab = await chrome.tabs.get(target).catch(() => null);
    const action: StepAction = { ...(element ?? {}), kind: "mark", note: note.trim().slice(0, 2000), url: element?.url ? redactUrl(element.url) : tab?.url ? redactUrl(tab.url) : undefined, title: element?.title ?? tab?.title };
    const step = await addStep(target, "mark", action, Date.now());
    shootSoon(step, 50);
    return { ok: true };
  }

  async function deleteStep(id: string): Promise<RecordResponse> {
    await store.deleteStep(id);
    for (const [tabId, step] of lastStepByTab) if (step.id === id) lastStepByTab.delete(tabId);
    changed();
    return { ok: true };
  }

  async function handleMessage(message: RecordMessage, sender: chrome.runtime.MessageSender): Promise<RecordResponse> {
    await ready;
    switch (message.type) {
      case "omem-record:state":
        return { ok: true, session };
      case "omem-record:start":
        return start(message.goal, message.tabId);
      case "omem-record:add-tab":
        return addTab(message.tabId);
      case "omem-record:stop":
        return stop();
      case "omem-record:resume":
        return resume();
      case "omem-record:discard":
        return discard();
      case "omem-record:set-goal":
        if (session) {
          session.goal = message.goal.slice(0, 2000);
          await store.putSession(session);
        }
        return { ok: true };
      case "omem-record:point":
        return point(message.tabId);
      case "omem-record:mark":
        return mark(message.note, message.element, message.tabId);
      case "omem-record:delete-step":
        return deleteStep(message.id);
      case "omem-record:keepalive":
        return { ok: true };
      case "omem-record:event": {
        const tabId = sender.tab?.id;
        // 只认被录的标签页的顶层页面
        if (typeof tabId !== "number" || !recording(tabId) || sender.frameId) return { ok: false };
        const { at, ...action } = message.event;
        const step = await addStep(tabId, "action", { ...action, url: action.url ? redactUrl(action.url) : undefined }, at);
        if (action.kind !== "input") shootSoon(step);
        return { ok: true };
      }
      case "omem-record:pointed":
        // 侧栏直接收这条消息（内容脚本的消息会发到扩展的每个页面），后台不用转
        return { ok: true };
      case "omem-record:har":
        await takeHar(message.tabId, message.entries);
        return { ok: true };
      default:
        return { ok: false, error: "未知的录制消息。" };
    }
  }

  /** 监听必须在 service worker 启动时同步注册，醒来时第一个事件才不会丢。 */
  function install(): void {
    const filter = { urls: ["<all_urls>"] };
    chrome.webRequest?.onBeforeRequest.addListener(onBeforeRequest, filter, ["requestBody"]);
    chrome.webRequest?.onSendHeaders.addListener(onSendHeaders, filter, ["requestHeaders"]);
    chrome.webRequest?.onBeforeRedirect.addListener(onBeforeRedirect, filter, ["responseHeaders"]);
    chrome.webRequest?.onCompleted.addListener(onCompleted, filter, ["responseHeaders"]);
    chrome.webRequest?.onErrorOccurred.addListener(onErrorOccurred, filter);
    chrome.tabs.onUpdated.addListener((tabId, info) =>
      whenReady(() => {
        if (!recording(tabId)) return;
        // 新页面加载完：注入的脚本不跨页面，再注入一次
        if (info.status === "complete") void inject(tabId);
        if (info.url || info.status === "complete" || info.title) scheduleVisit(tabId);
      })
    );
    // 从被录的页面打开的新标签页（新窗口、target=_blank）一起录
    chrome.tabs.onCreated.addListener((tab) =>
      whenReady(() => {
        if (!session || !recording() || typeof tab.id !== "number" || typeof tab.openerTabId !== "number" || !session.tabIds.includes(tab.openerTabId)) return;
        session.tabIds = [...session.tabIds, tab.id];
        void store.putSession(session).catch(() => undefined);
        changed();
      })
    );
  }

  return {
    install,
    isMessage: isRecordMessage,
    handleMessage: (message: unknown, sender: chrome.runtime.MessageSender) => handleMessage(message as RecordMessage, sender)
  };
}
