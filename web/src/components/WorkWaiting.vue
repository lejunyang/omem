<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { post, type Ask } from "../api";
import AskCard from "./AskCard.vue";
import Icon from "./Icon.vue";
import SideSheet from "./SideSheet.vue";
import { itemKindLabel, relTime, toast } from "../store";
import { duration } from "../lib/flow";
import { plainLine } from "../lib/markdown";
import { changeTone, changeTypeLabel, type ChangeLite, type GateLite, type ItemLite } from "../lib/work";

/**
 * Everything waiting for the owner, in one place (GET /api/work `waiting`): questions and approvals,
 * flow stages at a gate or on the owner's own step, changes not settled yet, items the assistant made
 * on its own, and reply drafts waiting in Feishu. The rail is a list to scan — a line or two each;
 * a question opens beside the page to be answered, so thirty of them do not make thirty forms.
 */
export type Waiting = { total: number; asks: Ask[]; gates: GateLite[]; candidates: ItemLite[]; changes: ChangeLite[]; drafts: number };
/** One thing waiting for the owner, whatever kind it is (src/items/pending.ts). */
export type PendingAction = { id: string; via: string; group: string; label: string; title: string; href: string; count?: number; createdAt: string; lineTitle?: string };
const props = defineProps<{ waiting: Waiting; pending?: PendingAction[] }>();
/** What waits on another page (metrics to confirm, proposed changes to a profile, skill drafts): a line each, leading there. */
const elsewhere = computed(() => (props.pending ?? []).filter((p) => ["metric", "profile", "skill", "item-update"].includes(p.via)));
const emit = defineEmits<{ changed: []; change: [c: ChangeLite] }>();
const askIds = computed(() => new Set(props.waiting.asks.map((a) => a.id)));
/** A gate whose card is already among the questions is answered there. */
const gates = computed(() => props.waiting.gates.filter((g) => !g.askId || !askIds.value.has(g.askId)));
/** Changes with a pending card are answered on the card (item-follow); the rest are listed. */
const changes = computed(() => (props.waiting.asks.some((a) => a.handler === "item-follow") ? [] : props.waiting.changes));

// ---- what a question is, in the owner's words
type Group = "ask" | "approve" | "propose" | "work";
const HANDLERS: Record<string, { label: string; group: Group }> = {
  "flow-stage": { label: "流程", group: "work" },
  "item-follow": { label: "变化", group: "work" },
  "study-plan": { label: "课题", group: "work" },
  "design-confirm": { label: "方案", group: "work" },
  "review-done": { label: "评审", group: "work" },
  "review-plan": { label: "评审", group: "work" },
  "review-retry": { label: "评审", group: "work" },
  "review-escalation": { label: "评审", group: "work" },
  "code-task": { label: "编码", group: "work" },
  "code-sync": { label: "编码", group: "work" },
  "work-deliver": { label: "交付", group: "work" },
  "commit-claim": { label: "提交", group: "work" },
  today: { label: "今天", group: "propose" },
  "line-propose": { label: "工作线", group: "propose" },
  "line-next": { label: "下一步", group: "propose" },
  "line-end": { label: "收尾", group: "propose" },
  "wiki-questions": { label: "Wiki", group: "propose" },
  "rule-enable": { label: "规则", group: "propose" },
  "flow-save": { label: "流程定义", group: "propose" },
  "reply-promote": { label: "以后自动", group: "propose" },
  "approval-promote": { label: "以后自动", group: "propose" },
  "flow-gate-promote": { label: "以后自动", group: "propose" },
  "command-gate": { label: "命令", group: "approve" },
  // The owner's assistant asking a member how one of the owner's lines is going (src/items/member-progress.ts).
  "member-progress": { label: "问进展", group: "ask" },
};
function kindOf(a: Ask): { label: string; group: Group } {
  const known = a.handler ? HANDLERS[a.handler] : undefined;
  if (known) return known;
  if (a.kind === "approval") return { label: a.tool ? "操作" : "审批", group: "approve" };
  return { label: a.askedBy ? "同事的助手" : "提问", group: "ask" };
}
const GROUPS: { value: Group; label: string }[] = [
  { value: "ask", label: "提问" },
  { value: "approve", label: "审批" },
  { value: "work", label: "流程与编码" },
  { value: "propose", label: "提议" },
];
const rows = computed(() => props.waiting.asks.map((a) => ({ ask: a, ...kindOf(a), lead: plainLine(a.question, 150) || "（没有文字）", picks: a.ui?.fields?.length ?? 0 })));
const counts = computed(() => Object.fromEntries(GROUPS.map((g) => [g.value, rows.value.filter((r) => r.group === g.value).length])) as Record<Group, number>);
const filter = ref<Group | "">("");
const shown = computed(() => (filter.value ? rows.value.filter((r) => r.group === filter.value) : rows.value));
const FIRST = 8;
const more = ref(false);
watch(filter, () => (more.value = false));
const listed = computed(() => (more.value ? shown.value : shown.value.slice(0, FIRST)));

// ---- one question opened beside the page
const openId = ref<string | null>(null);
const opened = computed(() => rows.value.find((r) => r.ask.id === openId.value) ?? null);
watch(opened, (r) => { if (!r) openId.value = null; });
function answered() {
  openId.value = null;
  emit("changed");
}
async function dismiss(a: Ask) {
  await post(`/api/asks/${a.id}/dismiss`, {}).catch(() => null);
  openId.value = null;
  emit("changed");
}

const deciding = ref<string | null>(null);
async function decide(i: ItemLite, keep: boolean) {
  deciding.value = i.id;
  try {
    await post(`/api/items/${i.id}/candidate`, { keep });
    toast(keep ? `已留下「${i.title}」` : `不要了「${i.title}」`, "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    deciding.value = null;
  }
}
const nothing = computed(() => !props.waiting.asks.length && !gates.value.length && !changes.value.length && !props.waiting.candidates.length && !props.waiting.drafts && !elsewhere.value.length);
</script>

<template>
  <section id="work-waiting" class="waiting" aria-labelledby="waiting-title">
    <h2 id="waiting-title" class="head">
      <span>需要你处理</span>
      <span v-if="waiting.total" class="pill">共 {{ waiting.total }} 条</span>
    </h2>
    <div v-if="nothing" class="calm"><Icon name="check" :size="16" /><span>没有等你的。</span></div>

    <div v-if="rows.length" class="group">
      <div v-if="rows.length > FIRST" class="filters" role="group" aria-label="只看一类">
        <button type="button" class="chip" :class="{ on: !filter }" :aria-pressed="!filter" @click="filter = ''">全部 {{ rows.length }}</button>
        <template v-for="g in GROUPS" :key="g.value">
          <button v-if="counts[g.value]" type="button" class="chip" :class="{ on: filter === g.value }" :aria-pressed="filter === g.value" @click="filter = filter === g.value ? '' : g.value">{{ g.label }} {{ counts[g.value] }}</button>
        </template>
      </div>
      <button v-for="r in listed" :key="r.ask.id" type="button" class="li" :aria-haspopup="'dialog'" @click="openId = r.ask.id">
        <span class="dot" :class="r.group === 'approve' ? 'warn' : 'accent'" />
        <span class="grow">
          <span class="t clamp">{{ r.lead }}</span>
          <span class="m"><b>{{ r.label }}</b><template v-if="r.picks > 1"> · {{ r.picks }} 项待选</template> · {{ relTime(r.ask.createdAt) }}</span>
        </span>
        <Icon name="right" :size="14" class="go" />
      </button>
      <button v-if="shown.length > listed.length" type="button" class="lnk small more" @click="more = true">再看 {{ shown.length - listed.length }} 条</button>
    </div>

    <div v-if="gates.length" class="group">
      <h3>流程里等你的</h3>
      <router-link v-for="g in gates" :key="`${g.itemId}-${g.stage.id}`" :to="`/work/${g.itemId}`" class="li">
        <Icon :name="g.stage.state === 'blocked' ? 'alert' : 'flag'" :size="15" class="warn" />
        <span class="grow"><span class="t clamp">{{ g.title }}</span><span class="m">{{ g.flowName }} · {{ g.stage.name }} · {{ g.stage.state === "blocked" ? "卡住" : "等你" }} {{ duration(g.since) }}</span></span>
      </router-link>
    </div>

    <div v-if="changes.length" class="group">
      <h3>没定的变化</h3>
      <button v-for="c in changes" :key="c.id" type="button" class="li" @click="emit('change', c)">
        <span class="dot" :class="changeTone(c.type)" />
        <span class="grow"><span class="t clamp">{{ c.summary }}</span><span class="m">{{ changeTypeLabel[c.type] ?? c.type }} · {{ c.lineTitle }} · {{ relTime(c.at) }}</span></span>
      </button>
    </div>

    <div v-if="waiting.candidates.length" class="group">
      <h3>可能要跟的</h3>
      <div v-for="i in waiting.candidates" :key="i.id" class="cand">
        <span class="grow">
          <router-link :to="`/items/${i.id}`" class="t clamp">{{ i.title }}</router-link>
          <span class="m">{{ itemKindLabel[i.kind] ?? i.kind }} · {{ relTime(i.updatedAt) }}</span>
        </span>
        <span class="acts">
          <button class="btn sm" :disabled="deciding === i.id" @click="decide(i, true)">留下</button>
          <button class="btn sm ghost" :disabled="deciding === i.id" @click="decide(i, false)">不要</button>
        </span>
      </div>
    </div>

    <div v-if="elsewhere.length" class="group">
      <h3>在别的页面等你确认</h3>
      <a v-for="p in elsewhere" :key="p.id" :href="p.href" class="li">
        <span class="dot accent" />
        <span class="grow"><span class="t clamp">{{ p.title }}</span><span class="m"><b>{{ p.label }}</b><template v-if="p.lineTitle"> · {{ p.lineTitle }}</template> · {{ relTime(p.createdAt) }}</span></span>
        <Icon name="right" :size="14" class="go" />
      </a>
    </div>

    <p v-if="waiting.drafts" class="drafts small"><Icon name="send" :size="14" />{{ waiting.drafts }} 条回复草稿在飞书里等你点发送</p>

    <SideSheet v-if="opened" :label="`需要你处理：${opened.lead}`" :tag="opened.label" :tone="opened.group === 'approve' ? 'warn' : 'accent'" @close="openId = null">
      <template #head><span class="muted small">{{ relTime(opened.ask.createdAt) }}</span></template>
      <AskCard :ask="opened.ask" compact full @answered="answered" />
      <template #foot>
        <router-link v-if="opened.ask.conversationId" :to="`/ask/${opened.ask.conversationId}`" class="btn ghost sm">打开对话</router-link>
        <router-link v-if="opened.ask.runId" :to="`/runs/${opened.ask.runId}`" class="btn ghost sm">看这次运行</router-link>
        <span class="spacer" />
        <button v-if="!opened.ask.handler" type="button" class="btn ghost sm" @click="dismiss(opened.ask)">不用了</button>
      </template>
    </SideSheet>
  </section>
</template>

<style scoped>
.waiting { display: grid; gap: 14px; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.head { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 650; }
.pill { font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--warn-soft); color: var(--warn); }
.calm { display: flex; gap: 8px; align-items: flex-start; color: var(--muted); font-size: 13px; }
.calm :deep(svg) { color: var(--ok); flex: none; margin-top: 2px; }
.group { display: grid; gap: 1px; min-width: 0; }
h3 { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 2px; }
.filters { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.chip { all: unset; box-sizing: border-box; cursor: pointer; font-size: 12px; line-height: 20px; padding: 0 8px; border-radius: 999px; color: var(--ink-2); background: var(--sunken); white-space: nowrap; }
.chip:hover { background-image: linear-gradient(var(--hover), var(--hover)); }
.chip.on { background: var(--ink); color: var(--bg); }
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.li { all: unset; box-sizing: border-box; display: flex; gap: 8px; align-items: flex-start; padding: 7px 8px; margin: 0 -8px; border-radius: 8px; cursor: pointer; color: inherit; min-width: 0; text-decoration: none; }
.li:hover { background: var(--hover); text-decoration: none; }
.li:focus-visible { outline: 2px solid var(--accent); }
.li :deep(svg) { flex: none; margin-top: 2px; }
.go { color: var(--line-strong); margin-top: 3px; }
.li:hover .go { color: var(--muted); }
.grow { flex: 1; min-width: 0; display: grid; gap: 1px; }
.t { font-size: 13.5px; line-height: 1.45; color: var(--ink); overflow-wrap: anywhere; }
.clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
.m { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.m b { font-weight: 600; color: var(--ink-2); }
.warn { color: var(--warn); }
.dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; border: 2px solid var(--muted); }
.dot.warn { border-color: var(--warn); }
.dot.accent { border-color: var(--accent); }
.dot.ok { border-color: var(--ok); }
.more { justify-self: start; padding: 4px 0; }
.cand { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.cand:last-child { border-bottom: 0; }
.cand .t { color: var(--ink); }
.acts { display: flex; gap: 4px; flex: none; }
.drafts { display: flex; gap: 6px; align-items: center; color: var(--ink-2); margin: 0; }
.spacer { flex: 1; }
</style>
