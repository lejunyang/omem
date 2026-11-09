<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { type PickDraftSegment, type PickRecord, refLabel } from "../shared/pick";

// 输入框：文字和引用块混排。用 contenteditable，引用块是不可编辑的 <span data-ref>，
// 输入 # 弹出记录列表选一条；内容序列化成 PickDraftSegment[] 存草稿。
const props = defineProps<{
  segments: PickDraftSegment[];
  ready: boolean;
  records: PickRecord[];
}>();
const emit = defineEmits<{ change: [segments: PickDraftSegment[]]; focusRecord: [id: string] }>();

const editor = ref<HTMLDivElement>();
const query = ref<string | null>(null);
const activeIndex = ref(0);
const empty = ref(true);
let composing = false;
function setComposing(value: boolean): void {
  composing = value;
}

const byId = computed(() => new Map(props.records.map((record) => [record.id, record])));
const suggestions = computed(() => {
  if (query.value === null) return [];
  const q = query.value.toLowerCase();
  return props.records.filter((record) => !q || `${record.seq} ${record.title} ${record.note}`.toLowerCase().includes(q)).slice(0, 8);
});

function chip(id: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = "ref-chip";
  node.contentEditable = "false";
  node.dataset.ref = id;
  const record = byId.value.get(id);
  node.textContent = record ? refLabel(record) : "已删除的记录";
  node.classList.toggle("is-missing", !record);
  return node;
}

function renderFrom(segments: PickDraftSegment[]): void {
  const root = editor.value;
  if (!root) return;
  root.replaceChildren(...segments.map((segment) => (segment.type === "text" ? document.createTextNode(segment.text) : chip(segment.id))));
  empty.value = !segments.length;
}

function serialize(): PickDraftSegment[] {
  const out: PickDraftSegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.type === "text") last.text += text;
    else out.push({ type: "text", text });
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) return pushText(node.textContent ?? "");
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.ref) return void out.push({ type: "ref", id: node.dataset.ref });
    if (node.tagName === "BR") return pushText("\n");
    // 浏览器回车会插入 <div>，按换行处理。
    if (node.tagName === "DIV" && node !== editor.value && out.length) pushText("\n");
    node.childNodes.forEach(walk);
  };
  editor.value?.childNodes.forEach(walk);
  return out;
}

function sync(): void {
  const segments = serialize();
  empty.value = !segments.length;
  emit("change", segments);
  detectQuery();
}

/** 光标前是 #xxx 时打开建议列表。 */
function detectQuery(): void {
  const selection = getSelection();
  const node = selection?.anchorNode;
  if (!selection?.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE || !editor.value?.contains(node)) {
    query.value = null;
    return;
  }
  const before = (node.textContent ?? "").slice(0, selection.anchorOffset);
  const match = /(?:^|\s)#([^\s#]*)$/.exec(before);
  query.value = match ? match[1] : null;
  activeIndex.value = 0;
}

/** 在光标处插入引用；从 # 建议里选时先删掉 #查询词。 */
function insertRef(id: string, replaceQuery = false): void {
  const root = editor.value;
  if (!root) return;
  const selection = getSelection();
  let range: Range;
  if (selection?.rangeCount && root.contains(selection.getRangeAt(0).startContainer)) {
    range = selection.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
  }
  if (replaceQuery && query.value !== null && range.startContainer.nodeType === Node.TEXT_NODE) {
    const start = range.startOffset - query.value.length - 1;
    if (start >= 0) range.setStart(range.startContainer, start);
    range.deleteContents();
  }
  const node = chip(id);
  const space = document.createTextNode(" ");
  range.insertNode(space);
  range.insertNode(node);
  range.setStartAfter(space);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  query.value = null;
  root.focus();
  sync();
}

function onKeydown(event: KeyboardEvent): void {
  if (composing || !suggestions.value.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + suggestions.value.length) % suggestions.value.length;
  } else if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    insertRef(suggestions.value[activeIndex.value].id, true);
  } else if (event.key === "Escape") {
    query.value = null;
  }
}

function onClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-ref]");
  if (target?.dataset.ref) emit("focusRecord", target.dataset.ref);
}

// 粘贴只取纯文本，避免把网页上的样式和图片带进来。
function onPaste(event: ClipboardEvent): void {
  event.preventDefault();
  document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
}

onMounted(() => {
  if (props.ready) renderFrom(props.segments);
});
watch(
  () => props.ready,
  (ready) => ready && nextTick(() => renderFrom(props.segments))
);
// 记录改名或删除时刷新引用块上的文字。
watch(byId, () => {
  editor.value?.querySelectorAll<HTMLElement>("[data-ref]").forEach((node) => {
    const record = byId.value.get(node.dataset.ref ?? "");
    node.textContent = record ? refLabel(record) : "已删除的记录";
    node.classList.toggle("is-missing", !record);
  });
});

defineExpose({
  insertRef: (id: string) => insertRef(id),
  clear: () => {
    renderFrom([]);
    sync();
  }
});
</script>

<template>
  <div class="composer-editor-wrap">
    <div
      ref="editor"
      class="composer-editor"
      contenteditable="true"
      role="textbox"
      aria-multiline="true"
      aria-label="描述"
      data-testid="pick-composer"
      @input="sync"
      @keyup="detectQuery"
      @keydown="onKeydown"
      @click="onClick"
      @paste="onPaste"
      @compositionstart="setComposing(true)"
      @compositionend="setComposing(false)"
    />
    <div v-if="empty" class="composer-placeholder" aria-hidden="true">描述问题或需求，输入 # 引用记录，或点记录上的「引用」</div>
    <ul v-if="suggestions.length" class="composer-suggest" role="listbox">
      <li
        v-for="(record, index) in suggestions"
        :key="record.id"
        role="option"
        :aria-selected="index === activeIndex"
        :class="{ 'is-active': index === activeIndex }"
        @mousedown.prevent="insertRef(record.id, true)"
      >
        <b>#{{ record.seq }}</b>
        <span>{{ record.title }}</span>
      </li>
    </ul>
  </div>
</template>
