import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { RecordingImportResponse } from "../shared/omem-client";
import { planUpload, type RecordedStep, type RecordingSession, type StepAction } from "../shared/recording";
import { RECORD_CHANGED_MESSAGE, type RecordMessage, type RecordResponse, type RecordStateResponse } from "../shared/recording-messages";
import { getImage, listRequests, listSteps } from "../shared/recording-store";
import { imageForUpload } from "./image-data";
import type { OmemContext } from "./use-omem";

export interface RecordedItem {
  step: RecordedStep;
  thumbUrl: string | null;
}

export interface TabChoice {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

/** 侧栏的录制：读后台的状态和库里的步骤、开始停止、加标记、删步骤、上传给 omem。 */
export function useRecording() {
  const session = ref<RecordingSession | null>(null);
  const items = shallowRef<RecordedItem[]>([]);
  const loading = ref(true);
  const notice = ref("");
  const needsPermission = ref(false);
  const pointing = ref(false);
  const pointed = ref<StepAction | null>(null);
  const now = ref(Date.now());
  const thumbs = new Map<string, string>();
  let loadSeq = 0;
  let clock = 0;
  let keepalive = 0;

  const isRecording = computed(() => session.value?.status === "recording");

  async function send(message: RecordMessage): Promise<RecordResponse | null> {
    return (await chrome.runtime.sendMessage(message).catch(() => null)) as RecordResponse | null;
  }

  /** 读状态和步骤；截图缩略图按步骤缓存，只给新出现的截图读一次库。 */
  async function reload(): Promise<void> {
    const seq = ++loadSeq;
    const state = (await send({ type: "omem-record:state" })) as RecordStateResponse | null;
    const steps = state?.session ? await listSteps().catch(() => [] as RecordedStep[]) : [];
    if (seq !== loadSeq) return;
    session.value = state?.session ?? null;
    const next: RecordedItem[] = [];
    for (const step of steps) {
      if (step.screenshot && !thumbs.has(step.id)) {
        const blob = await getImage(step.id).catch(() => null);
        if (blob) thumbs.set(step.id, URL.createObjectURL(blob));
      }
      next.push({ step, thumbUrl: thumbs.get(step.id) ?? null });
    }
    if (seq !== loadSeq) return;
    for (const [id, url] of thumbs) {
      if (!steps.some((step) => step.id === id)) {
        URL.revokeObjectURL(url);
        thumbs.delete(id);
      }
    }
    items.value = next;
    loading.value = false;
  }

  const onMessage = (message: unknown) => {
    const type = (message as { type?: string } | null)?.type;
    if (type === RECORD_CHANGED_MESSAGE) void reload();
    // 页面里的记录脚本直接发到扩展的每个页面：本人指了一个元素（或按 Esc 取消）
    if (type === "omem-record:pointed") {
      pointing.value = false;
      const element = (message as { element?: StepAction | null }).element;
      if (element) pointed.value = element;
    }
  };

  onMounted(async () => {
    chrome.runtime.onMessage.addListener(onMessage);
    clock = window.setInterval(() => (now.value = Date.now()), 1000);
    // service worker 闲置 30 秒会被回收；录制时侧栏开着就隔一会儿叫醒它（状态都在库里，回收了也不丢）。
    keepalive = window.setInterval(() => {
      if (isRecording.value) void send({ type: "omem-record:keepalive" });
    }, 20_000);
    await reload();
  });

  onBeforeUnmount(() => {
    chrome.runtime.onMessage.removeListener(onMessage);
    clearInterval(clock);
    clearInterval(keepalive);
    for (const url of thumbs.values()) URL.revokeObjectURL(url);
    thumbs.clear();
  });

  async function tabs(): Promise<TabChoice[]> {
    const list = await chrome.tabs.query({ currentWindow: true });
    return list
      .filter((tab) => typeof tab.id === "number" && /^(https?|file):/.test(tab.url ?? ""))
      .map((tab) => ({ id: tab.id!, title: tab.title || tab.url || "", url: tab.url ?? "", active: !!tab.active }));
  }

  function report(response: RecordResponse | null, fallback: string): boolean {
    if (response?.ok) {
      notice.value = "";
      needsPermission.value = false;
      return true;
    }
    const failed = response as { error?: string; needsPermission?: boolean } | null;
    notice.value = failed?.error || fallback;
    needsPermission.value = !!failed?.needsPermission;
    return false;
  }

  /**
   * 开始录制。录制要在被录的页面里注入脚本、看所有请求、截图（captureVisibleTab 只认 activeTab 或 <all_urls>），
   * 所以要所有网站的权限；申请必须在点击里直接发起，所以它是这个函数里第一个 await。
   */
  async function start(goal: string, tabId: number): Promise<boolean> {
    const granted = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
    if (!granted) {
      notice.value = "录制要读页面和请求、给每步截图，需要授权所有网站。";
      needsPermission.value = true;
      return false;
    }
    pointed.value = null;
    return report(await send({ type: "omem-record:start", goal: goal.trim(), tabId }), "没能开始录制。");
  }

  const stop = async () => report(await send({ type: "omem-record:stop" }), "没能停止录制。");
  const resume = async () => report(await send({ type: "omem-record:resume" }), "没能继续录制。");
  const addTab = async (tabId: number) => report(await send({ type: "omem-record:add-tab", tabId }), "这个标签页不能录制。");
  const setGoal = async (goal: string) => void (await send({ type: "omem-record:set-goal", goal }));
  const deleteStep = async (id: string) => void (await send({ type: "omem-record:delete-step", id }));

  async function discard(): Promise<void> {
    await send({ type: "omem-record:discard" });
    pointed.value = null;
    await reload();
  }

  async function point(): Promise<void> {
    pointing.value = report(await send({ type: "omem-record:point" }), "没能在页面上指出元素。");
  }

  async function mark(note: string): Promise<boolean> {
    const ok = report(await send({ type: "omem-record:mark", note, element: pointed.value }), "没能加上标记。");
    if (ok) pointed.value = null;
    return ok;
  }

  /** 上传：读库里的步骤、请求和要带的截图，交给 omem；成功后清掉这次录制。 */
  async function upload(omem: OmemContext, options: { organize: boolean; contextId?: string; itemId?: string; demoId?: string }): Promise<RecordingImportResponse> {
    const current = session.value;
    if (!current) throw new Error("没有录制");
    const [steps, requests] = await Promise.all([listSteps(), listRequests()]);
    const plan = planUpload(current, steps, requests);
    const images: Array<{ key: string; data: string }> = [];
    for (const key of plan.imageKeys) {
      const blob = await getImage(key).catch(() => null);
      if (blob) images.push({ key, data: await imageForUpload(blob) });
    }
    const result = await omem.importRecording({
      ...plan.body,
      images,
      organize: options.organize,
      ...(options.contextId ? { contextId: options.contextId } : {}),
      ...(options.itemId ? { itemId: options.itemId } : {}),
      ...(options.demoId ? { demoId: options.demoId } : {})
    });
    await discard();
    return result;
  }

  return {
    addTab,
    deleteStep,
    discard,
    isRecording,
    items,
    loading,
    mark,
    needsPermission,
    notice,
    now,
    point,
    pointed,
    pointing,
    reload,
    resume,
    session,
    setGoal,
    start,
    stop,
    tabs,
    upload
  };
}

export type RecordingContext = ReturnType<typeof useRecording>;
