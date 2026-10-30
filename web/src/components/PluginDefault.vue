<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, onServerEvent, post } from "../api";
import { toast } from "../store";
import { renderBlock, type BlockView } from "@omem/plugin-sdk/blocks";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";

/**
 * The page of a plugin without one of its own (docs/v2/plugins.md): sessions with the plugin's
 * agent, its replies, and the host's blocks (forms, charts) drawn by @omem/plugin-sdk (packages/plugin-sdk/blocks.ts).
 */
type Info = { id: string; name: string; description: string; agents: { name: string; description: string }[]; page: { title: string } | null; settings: boolean };
type Message = { id: string; role: "user" | "assistant"; text: string; runId: string | null; createdAt: string; submission: string | null };
type Block = BlockView & { runId: string | null; createdAt: string };
type Session = { id: string; title: string; messages: Message[]; blocks: Block[]; busy: string | null };

const props = defineProps<{ info: Info }>();
const emit = defineEmits<{ settings: [] }>();
const route = useRoute();
const router = useRouter();
const base = `/api/plugins/${props.info.id}`;
const sessions = ref<{ id: string; title: string; updatedAt: string }[] | null>(null);
const current = ref<Session | null>(null);
const draft = ref("");
const sending = ref(false);

const entries = computed(() => {
  const s = current.value;
  if (!s) return [];
  // A turn's reply is stored when it ends, after the blocks it handed in: blocks go right after it.
  const replyAt = new Map(s.messages.filter((m) => m.role === "assistant" && m.runId).map((m) => [m.runId!, m.createdAt]));
  return [
    ...s.messages.map((m) => ({ key: m.id, at: m.createdAt, message: m, block: null as Block | null })),
    ...s.blocks.map((b) => ({ key: b.id, at: b.runId && replyAt.has(b.runId) ? `${replyAt.get(b.runId)}~` : b.createdAt, message: null as Message | null, block: b })),
  ].sort((a, b) => a.at.localeCompare(b.at));
});

async function open(id: string | null) {
  current.value = id ? await get<Session>(`${base}/sessions/${id}`) : null;
  if (id && route.query.session !== id) void router.replace({ query: { ...route.query, session: id } });
  await nextTick();
  document.querySelector(".plugin-default .timeline > :last-child")?.scrollIntoView({ block: "end" });
}
async function refresh() {
  if (current.value) current.value = await get<Session>(`${base}/sessions/${current.value.id}`);
}

async function say() {
  const text = draft.value.trim();
  if (!text) return;
  sending.value = true;
  try {
    let id = current.value?.id;
    if (!id) {
      id = (await post<{ id: string }>(`${base}/sessions`, { title: text.slice(0, 40) })).id;
      // Events can be missed (a reconnect); while a turn is under way, look again now and then.
  poll = setInterval(() => current.value?.busy && void refresh().catch(() => {}), 4000);
  sessions.value = await get(`${base}/sessions`);
    }
    await post(`${base}/sessions/${id}/messages`, { text });
    draft.value = "";
    await open(id);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    sending.value = false;
  }
}

// Blocks are drawn into their own elements by the framework-free renderer; redraw only when one changes.
const drawn = new Map<string, string>();
function mount(el: Element | null, b: Block) {
  if (!el) return;
  const sig = `${b.status}:${JSON.stringify(b.result)}`;
  if (drawn.get(b.id) === sig && el.childElementCount) return;
  drawn.set(b.id, sig);
  const ok = renderBlock(el as HTMLElement, b, {
    submit: async (answers) => {
      await post(`${base}/blocks/${b.id}/submit`, { answers });
      await refresh();
    },
  });
  if (!ok) el.textContent = `这个内容块（${b.kind}）要在插件自己的页面里看。`;
}

let off: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
onMounted(async () => {
  off = onServerEvent((e) => {
    if (!current.value) return;
    if ((e.type === "plugin" && e.plugin === props.info.id && e.conversationId === current.value.id) || (e.type === "run" && current.value.busy)) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh().catch(() => {}), 250);
    }
  });
  sessions.value = await get(`${base}/sessions`);
  const wanted = typeof route.query.session === "string" ? route.query.session : sessions.value?.[0]?.id ?? null;
  await open(wanted).catch(() => open(null));
});
watch(() => route.query.session, (id) => typeof id === "string" && id !== current.value?.id && void open(id).catch(() => {}));
onBeforeUnmount(() => {
  off?.();
  if (poll) clearInterval(poll);
});
</script>

<template>
  <div class="page plugin-default">
    <header class="row wrap head">
      <h1>{{ info.page?.title ?? info.name }}</h1>
      <span class="spacer" />
      <button v-if="info.settings" class="btn ghost sm" @click="emit('settings')"><Icon name="settings" :size="15" />设置</button>
      <button class="btn sm" :disabled="!current" @click="open(null)"><Icon name="plus" :size="15" />新会话</button>
    </header>
    <p v-if="info.description" class="muted">{{ info.description }}</p>
    <div class="layout" :class="{ split: !!sessions?.length }">
      <main class="stack main">
        <Skeleton v-if="!sessions" variant="text" :rows="5" />
        <div v-else-if="!current" class="card pad stack">
          <p>和 <span class="mono">{{ info.agents[0]?.name ?? "插件的 Agent" }}</span> 说第一句话开始。{{ info.agents[0]?.description }}</p>
        </div>
        <div v-else class="timeline">
          <template v-for="e in entries" :key="e.key">
            <div v-if="e.block" :ref="(el) => mount(el as Element | null, e.block!)" class="block" />
            <p v-else-if="e.message!.submission" class="note muted small">已提交</p>
            <Markdown v-else-if="e.message!.role === 'assistant'" class="bot" :source="e.message!.text" />
            <p v-else class="me">{{ e.message!.text }}</p>
          </template>
          <p v-if="current.busy" class="note muted small" aria-live="polite">正在回复…</p>
        </div>
        <form class="composer" @submit.prevent="say">
          <textarea v-model="draft" class="textarea" rows="2" :placeholder="`和 ${info.agents[0]?.name ?? 'Agent'} 说（Ctrl+Enter 发送）`" aria-label="消息" @keydown.enter.ctrl.prevent="say" @keydown.enter.meta.prevent="say" />
          <button class="btn primary" type="submit" :disabled="sending || !draft.trim()">发送</button>
        </form>
      </main>
      <aside v-if="sessions?.length" class="history card pad">
        <div class="muted small">会话</div>
        <button v-for="s in sessions" :key="s.id" class="li" :class="{ on: current?.id === s.id }" @click="open(s.id)">
          <span class="ellipsis">{{ s.title || "会话" }}</span><span class="muted small">{{ s.updatedAt.slice(5, 16).replace("T", " ") }}</span>
        </button>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.head h1 {
  font-size: 22px;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 760px);
  gap: 20px;
  align-items: start;
}
.layout.split {
  grid-template-columns: minmax(0, 760px) 240px;
}
.main {
  min-width: 0;
}
.timeline {
  display: grid;
  gap: 14px;
}
.me {
  justify-self: end;
  max-width: 85%;
  background: var(--accent-soft);
  border-radius: 12px 12px 4px 12px;
  padding: 7px 12px;
  overflow-wrap: anywhere;
}
.note {
  text-align: center;
}
.composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  position: sticky;
  bottom: 0;
  padding: 10px 0 4px;
  background: var(--bg);
}
.composer .textarea {
  flex: 1;
}
.history {
  display: grid;
  gap: 2px;
  position: sticky;
  top: 16px;
}
.li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  background: none;
  text-align: left;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  color: inherit;
  min-width: 0;
}
.li:hover,
.li.on {
  background: var(--hover);
}
@media (max-width: 960px) {
  .layout.split {
    grid-template-columns: minmax(0, 1fr);
  }
  .history {
    position: static;
    order: -1;
  }
}
</style>
