import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { getStorageItems, setStorageItems } from "../shared/extension-storage";
import { draftToMarkdown, normalizeDraft, PICK_DRAFT_STORAGE_KEY, type PickDraftSegment, type PickRecord } from "../shared/pick";
import type { PickResponse, PickStartMode } from "../shared/pick-messages";
import { clearPickRecords, deletePickRecords, listPickRecords, PICK_CHANGED_MESSAGE, updatePickNote } from "../shared/pick-store";

export interface BasketItem {
  record: PickRecord;
  thumbUrl: string;
}

/** 拾取篮的数据和操作：读 IndexedDB、监听后台的变化通知、草稿存 chrome.storage.local。 */
export function usePickBasket() {
  const items = shallowRef<BasketItem[]>([]);
  const loading = ref(true);
  const draft = ref<PickDraftSegment[]>([]);
  const draftLoaded = ref(false);
  const notice = ref("");
  const needsPermission = ref(false);
  let draftTimer = 0;
  let loadSeq = 0;

  const byId = computed(() => new Map(items.value.map((item) => [item.record.id, item.record])));

  async function reload(): Promise<void> {
    const seq = ++loadSeq;
    const records = await listPickRecords().catch(() => [] as PickRecord[]);
    // 连续变化时只采用最新一次读取，旧的结果直接丢弃并释放缩略图。
    if (seq !== loadSeq) return;
    for (const item of items.value) URL.revokeObjectURL(item.thumbUrl);
    items.value = records.map((record) => ({ record, thumbUrl: URL.createObjectURL(record.thumb) }));
    loading.value = false;
  }

  const onMessage = (message: unknown) => {
    if ((message as { type?: string } | null)?.type === PICK_CHANGED_MESSAGE) void reload();
  };

  onMounted(async () => {
    chrome.runtime.onMessage.addListener(onMessage);
    await reload();
    const stored = await getStorageItems(chrome.storage.local, [PICK_DRAFT_STORAGE_KEY]).catch(() => ({}) as Record<string, unknown>);
    draft.value = normalizeDraft(stored[PICK_DRAFT_STORAGE_KEY]);
    draftLoaded.value = true;
  });

  onBeforeUnmount(() => {
    chrome.runtime.onMessage.removeListener(onMessage);
    for (const item of items.value) URL.revokeObjectURL(item.thumbUrl);
    flushDraft();
  });

  function setDraft(next: PickDraftSegment[]): void {
    draft.value = next;
    clearTimeout(draftTimer);
    draftTimer = window.setTimeout(flushDraft, 400);
  }

  function flushDraft(): void {
    clearTimeout(draftTimer);
    // 响应式数组直接存会变成 {"0": …} 这样的对象，先转成普通数组。
    const plain = JSON.parse(JSON.stringify(draft.value)) as PickDraftSegment[];
    void setStorageItems(chrome.storage.local, { [PICK_DRAFT_STORAGE_KEY]: plain }).catch(() => undefined);
  }

  async function start(mode: PickStartMode): Promise<void> {
    notice.value = "";
    needsPermission.value = false;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = (await chrome.runtime.sendMessage({ type: "omem-pick:start", mode, tabId: tab?.id })) as PickResponse | undefined;
    if (response?.ok) return;
    needsPermission.value = Boolean(response?.needsPermission);
    notice.value = response?.needsPermission
      ? "从侧栏开始需要页面权限。可以点工具栏的 omem 图标或按 Alt+Shift+X 开始（会自动获得当前页权限），或者授权在所有网站上拾取。"
      : response?.error || "无法在这个页面上拾取。";
  }

  /** 截图（captureVisibleTab）只认 activeTab 或 <all_urls>，单个站点的权限不够，所以这里申请的是 <all_urls>。 */
  async function grantAllSites(): Promise<void> {
    const granted = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
    if (granted) {
      needsPermission.value = false;
      notice.value = "已授权，可以直接从侧栏开始拾取。";
    }
  }

  async function saveNote(id: string, note: string): Promise<void> {
    await updatePickNote(id, note);
    const item = items.value.find((entry) => entry.record.id === id);
    if (item) item.record.note = note;
  }

  async function remove(ids: string[]): Promise<void> {
    await deletePickRecords(ids);
    await reload();
  }

  async function clearAll(): Promise<void> {
    await clearPickRecords();
    setDraft([]);
    await reload();
  }

  function markdown(): string {
    return draftToMarkdown(draft.value, items.value.map((item) => item.record));
  }

  return {
    byId,
    clearAll,
    draft,
    draftLoaded,
    grantAllSites,
    items,
    loading,
    markdown,
    needsPermission,
    notice,
    reload,
    remove,
    saveNote,
    setDraft,
    start
  };
}
