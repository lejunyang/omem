<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { buildClip } from "../shared/pick-clip";
import type { PickStartMode } from "../shared/pick-messages";
import { imageForUpload } from "./image-data";
import OmemConnections from "./OmemConnections.vue";
import PickComposer from "./PickComposer.vue";
import PickRecordDetail from "./PickRecordDetail.vue";
import { useOmem } from "./use-omem";
import { usePickBasket } from "./use-pick-basket";

const basket = usePickBasket();
const omem = useOmem();
const { status: omemStatus, active: omemActive, spaces: omemSpaces, space: omemSpace } = omem;
const showConnections = ref(false);

/** 发送的状态：发出去以后问答要等助手回答，这里轮询对话把回答显示出来。 */
type SendState =
  | { phase: "sending"; mode: "ask" | "source" }
  | { phase: "error"; mode: "ask" | "source"; message: string }
  | { phase: "done"; mode: "ask"; conversationId: string; link: string | null; reply: string | null; waiting: boolean }
  | { phase: "done"; mode: "source"; sourceId: string; link: string | null };
const sendState = ref<SendState | null>(null);
let pollTimer = 0;
onBeforeUnmount(() => clearTimeout(pollTimer));
const { items, loading, draft, draftLoaded, notice, needsPermission } = basket;
const expandedId = ref<string | null>(null);
const flashId = ref<string | null>(null);
const confirmClear = ref(false);
const confirmRemove = ref<string | null>(null);
const copyState = ref("");
const composer = ref<InstanceType<typeof PickComposer>>();

const records = computed(() => items.value.map((item) => item.record));
const citedCount = computed(() => new Set(draft.value.filter((segment) => segment.type === "ref").map((segment) => (segment as { id: string }).id)).size);
const hasDraft = computed(() => draft.value.some((segment) => segment.type === "ref" || segment.text.trim()));

const modes: Array<{ mode: PickStartMode; label: string }> = [
  { mode: "element", label: "元素" },
  { mode: "region", label: "区域" },
  { mode: "viewport", label: "可视区" },
  { mode: "page", label: "整页" }
];

function toggle(id: string): void {
  expandedId.value = expandedId.value === id ? null : id;
  confirmRemove.value = null;
}

function cite(id: string): void {
  composer.value?.insertRef(id);
}

async function focusRecord(id: string): Promise<void> {
  expandedId.value = id;
  flashId.value = id;
  await nextTick();
  document.querySelector(`[data-record="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  setTimeout(() => (flashId.value = null), 1200);
}

async function remove(id: string): Promise<void> {
  // 删除前在按钮上再确认一次，不弹系统对话框。
  if (confirmRemove.value !== id) {
    confirmRemove.value = id;
    return;
  }
  confirmRemove.value = null;
  expandedId.value = null;
  await basket.remove([id]);
}

async function clearAll(): Promise<void> {
  if (!confirmClear.value) {
    confirmClear.value = true;
    setTimeout(() => (confirmClear.value = false), 3000);
    return;
  }
  confirmClear.value = false;
  composer.value?.clear();
  await basket.clearAll();
}

async function copyMarkdown(): Promise<void> {
  const clip = buildClip(draft.value, records.value);
  if (!clip) return;
  const titles = new Map(clip.images.map((image) => [image.key, image.title]));
  await navigator.clipboard.writeText(clip.text.replace(/\{\{image:([\w-]+)\}\}/g, (_, key: string) => `［截图：${titles.get(key) ?? key}］`));
  copyState.value = "已复制";
  setTimeout(() => (copyState.value = ""), 1800);
}

const canSend = computed(() => hasDraft.value && omemStatus.value.state === "ok" && !!omemSpace.value && sendState.value?.phase !== "sending");
const sendHint = computed(() => {
  if (!omemActive.value) return "先连接 omem";
  if (omemStatus.value.state === "error") return omemStatus.value.message;
  if (omemStatus.value.state !== "ok") return "正在连接 omem";
  if (!omemSpace.value) return "这个账号没有可以写入的空间";
  return hasDraft.value ? "" : "先写点什么，或引用一条记录";
});

/** 问 omem：作为一条消息发到问答（新对话）；存为原件：存成一篇笔记。截图都会变成图片原件。 */
async function send(mode: "ask" | "source"): Promise<void> {
  const clip = buildClip(draft.value, records.value);
  if (!clip) return;
  clearTimeout(pollTimer);
  sendState.value = { phase: "sending", mode };
  try {
    const byId = new Map(records.value.map((record) => [record.id, record]));
    const images = await Promise.all(
      clip.images.map(async (image) => ({ key: image.key, title: image.title, data: await imageForUpload(byId.get(image.recordId)!.image) }))
    );
    const result = await omem.send({ mode, title: clip.title, text: clip.text, pageUrl: clip.pageUrl, images });
    if (result.mode === "source") {
      sendState.value = { phase: "done", mode: "source", sourceId: result.sourceId, link: omem.webUrl(`/sources/${result.sourceId}`) };
      return;
    }
    sendState.value = { phase: "done", mode: "ask", conversationId: result.conversationId, link: omem.webUrl(`/ask/${result.conversationId}`), reply: null, waiting: true };
    pollReply(result.conversationId, Date.now() + 5 * 60_000);
  } catch (error) {
    sendState.value = { phase: "error", mode, message: (error as Error).message };
  }
}

/** 每 3 秒看一次对话里有没有助手的回答，最多等 5 分钟；之后去 omem 里看。 */
function pollReply(conversationId: string, deadline: number): void {
  pollTimer = window.setTimeout(async () => {
    const state = sendState.value;
    if (state?.phase !== "done" || state.mode !== "ask" || state.conversationId !== conversationId) return;
    const messages = await omem.conversation(conversationId).catch(() => []);
    const reply = [...messages].reverse().find((message) => message.role === "assistant");
    if (reply) {
      sendState.value = { ...state, reply: reply.text, waiting: false };
      return;
    }
    if (Date.now() > deadline) {
      sendState.value = { ...state, waiting: false };
      return;
    }
    pollReply(conversationId, deadline);
  }, 3000);
}

function clearAfterSend(): void {
  composer.value?.clear();
  sendState.value = null;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function time(value: number): string {
  const date = new Date(value);
  const today = new Date();
  const hm = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === today.toDateString() ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}
</script>

<template>
  <main class="basket">
    <header class="basket-header">
      <div class="basket-title">
        <strong>拾取篮</strong>
        <span v-if="items.length" class="muted">{{ items.length }} 条</span>
      </div>
      <div class="basket-start" role="group" aria-label="开始拾取">
        <button
          v-for="item in modes"
          :key="item.mode"
          class="button"
          type="button"
          :data-testid="`basket-start-${item.mode}`"
          @click="basket.start(item.mode)"
        >
          {{ item.label }}
        </button>
      </div>
    </header>
    <div class="omem-bar">
      <button class="omem-chip" type="button" data-testid="omem-connection" :title="omemActive ? '切换或管理连接' : '连接 omem'" @click="showConnections = true">
        <i class="omem-dot" :class="`is-${omemStatus.state}`" aria-hidden="true" />
        <span>{{ omemActive ? omemActive.name : "连接 omem" }}</span>
        <small v-if="omemStatus.state === 'ok'" class="muted">{{ omemStatus.me.name }}</small>
      </button>
      <select
        v-if="omemSpaces.length"
        class="preset-select omem-space"
        :value="omemSpace"
        title="发送到哪个空间"
        aria-label="空间"
        @change="omem.setSpace(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="item in omemSpaces" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
      <button v-if="omemStatus.state === 'error'" class="button button-ghost" type="button" @click="omemStatus.relogin && omemActive ? omem.login(omemActive.id) : omem.check()">
        {{ omemStatus.relogin ? "登录" : "重试" }}
      </button>
    </div>
    <OmemConnections v-if="showConnections" :omem="omem" @close="showConnections = false" />

    <p v-if="notice" class="basket-notice">
      <span>{{ notice }}</span>
      <button v-if="needsPermission" class="button" type="button" @click="basket.grantAllSites()">授权所有网站</button>
    </p>

    <section class="basket-list" aria-label="记录">
      <div v-if="loading" class="basket-skeleton" aria-hidden="true"><i /><i /><i /></div>
      <div v-else-if="!items.length" class="basket-empty">
        <strong>还没有记录</strong>
        <p>在页面上选元素、框区域或截整页，「记下」后会出现在这里。快捷键 Alt+Shift+X 开始选元素。</p>
        <button class="button button-primary" type="button" @click="basket.start('element')">开始拾取</button>
      </div>
      <article
        v-for="item in items"
        v-else
        :key="item.record.id"
        class="record-card"
        :data-record="item.record.id"
        :class="{ 'is-open': expandedId === item.record.id, 'is-flash': flashId === item.record.id }"
      >
        <div class="record-row" role="button" tabindex="0" :aria-expanded="expandedId === item.record.id" @click="toggle(item.record.id)" @keydown.enter.space.prevent="toggle(item.record.id)">
          <img class="record-thumb" :src="item.thumbUrl" alt="" />
          <div class="record-meta">
            <div class="record-name"><b>#{{ item.record.seq }}</b><span :title="item.record.title">{{ item.record.title }}</span></div>
            <div class="record-sub muted">{{ host(item.record.pageUrl) }} · {{ time(item.record.createdAt) }}</div>
            <div v-if="item.record.note" class="record-note-preview">{{ item.record.note }}</div>
          </div>
          <button class="button button-ghost record-cite" type="button" title="引用到输入框" @click.stop="cite(item.record.id)">引用</button>
        </div>
        <PickRecordDetail
          v-if="expandedId === item.record.id"
          :record="item.record"
          @save-note="(note) => basket.saveNote(item.record.id, note)"
          @cite="cite(item.record.id)"
          @remove="remove(item.record.id)"
        />
        <p v-if="confirmRemove === item.record.id" class="record-confirm">再点一次「删除」确认，删除后不能恢复。</p>
      </article>
    </section>

    <footer class="composer">
      <PickComposer
        ref="composer"
        :segments="draft"
        :ready="draftLoaded"
        :records="records"
        @change="basket.setDraft"
        @focus-record="focusRecord"
      />
      <div v-if="sendState" class="send-result" :class="`is-${sendState.phase}`" role="status" data-testid="send-result">
        <template v-if="sendState.phase === 'sending'">{{ sendState.mode === "ask" ? "正在发给 omem…" : "正在保存为原件…" }}</template>
        <template v-else-if="sendState.phase === 'error'">发送失败：{{ sendState.message }}</template>
        <template v-else-if="sendState.mode === 'source'">
          <span>已保存为原件，omem 会接着整理。</span>
          <a v-if="sendState.link" :href="sendState.link" target="_blank" rel="noreferrer">在 omem 中查看</a>
          <button class="button button-ghost" type="button" @click="clearAfterSend">清空输入框</button>
        </template>
        <template v-else>
          <span>{{ sendState.waiting ? "已发送，等助手回答…" : sendState.reply ? "助手的回答：" : "已发送，回答会出现在 omem 的对话里。" }}</span>
          <p v-if="sendState.reply" class="send-reply">{{ sendState.reply.length > 600 ? `${sendState.reply.slice(0, 600)}…` : sendState.reply }}</p>
          <a v-if="sendState.link" :href="sendState.link" target="_blank" rel="noreferrer">在 omem 中继续</a>
          <button class="button button-ghost" type="button" @click="clearAfterSend">清空输入框</button>
        </template>
      </div>
      <div class="composer-actions">
        <span class="muted">{{ citedCount ? `引用 ${citedCount} 条` : "" }}</span>
        <span class="grow" />
        <button v-if="items.length" class="button button-ghost" type="button" :class="{ 'button-danger': confirmClear }" @click="clearAll">
          {{ confirmClear ? "确认清空全部" : "清空" }}
        </button>
        <button class="button button-ghost" type="button" :disabled="!hasDraft" data-testid="pick-copy-markdown" @click="copyMarkdown">{{ copyState || "复制 Markdown" }}</button>
      </div>
      <div class="composer-actions">
        <span class="muted send-hint">{{ sendHint }}</span>
        <span class="grow" />
        <button class="button" type="button" :disabled="!canSend" data-testid="pick-save-source" title="存成 omem 的一篇笔记原件，截图一起存" @click="send('source')">存为原件</button>
        <button class="button button-primary" type="button" :disabled="!canSend" data-testid="pick-ask" title="作为问题发到 omem 的问答" @click="send('ask')">问 omem</button>
      </div>
    </footer>
  </main>
</template>
