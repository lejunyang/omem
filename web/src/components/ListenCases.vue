<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { put } from "../api";
import { fmtTime, relTime, toast } from "../store";
import { caseOutcome, corrected, unanswered, VERDICT_LABEL, type ListenCase, type Verdict } from "../lib/listen";

/**
 * A 关注's cases (or a group's): who asked what where, what the assistant did and why, what the owner
 * wrote there themselves, and the owner's correction (该回 / 不该回 / 回得不对 with a line), which
 * listen-coach reads the next time it writes the lessons.
 */
const props = defineProps<{
  cases: ListenCase[];
  /** 关注 names by id, to say which one a case belongs to (a group's page). */
  contexts?: Record<string, string>;
  /** The group whose page this is: its name is not a link to itself. */
  here?: string;
}>();

type Filter = "all" | "corrected" | "unanswered" | "own";
const filter = ref<Filter>("all");
/** Corrections made here, over the rows as loaded. */
const over = reactive<Record<string, { verdict: Verdict | null; note: string | null }>>({});
const rows = computed(() => props.cases.map((c) => (over[c.id] ? { ...c, ...over[c.id] } : c)));
const tests: Record<Filter, (c: ListenCase) => boolean> = { all: () => true, corrected, unanswered, own: (c) => !!c.owner_reply };
const filters = computed(() =>
  ([["all", "全部"], ["corrected", "我纠正过的"], ["unanswered", "没回的"], ["own", "我自己回的"]] as [Filter, string][]).map(([value, label]) => ({ value, label, n: rows.value.filter(tests[value]).length })),
);
const shown = computed(() => rows.value.filter(tests[filter.value]));
const VERDICTS = Object.entries(VERDICT_LABEL) as [Verdict, string][];

/** Clearing the verdict clears its note too (the server keeps only what is sent). */
async function mark(c: ListenCase, verdict: Verdict | null, note: string | null) {
  try {
    const r = await put<{ verdict: Verdict | null; note: string | null }>(`/api/cases/${encodeURIComponent(c.id)}`, { verdict, ...(verdict && note?.trim() ? { note: note.trim() } : {}) });
    over[c.id] = { verdict: r.verdict, note: r.note };
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const pick = (c: ListenCase, v: Verdict) => mark(c, c.verdict === v ? null : v, c.verdict === v ? null : c.note);
function saveNote(c: ListenCase, text: string) {
  if (!c.verdict) return;
  if ((c.note ?? "") === text.trim()) return;
  void mark(c, c.verdict, text).then(() => toast("已记下这句", "ok"));
}
const where = (c: ListenCase) => (c.chat_kind === "p2p" ? "私聊" : c.chat_name || c.chat_id);
</script>

<template>
  <div class="listen-cases">
    <div class="filters row wrap" role="group" aria-label="筛选案例">
      <button v-for="f in filters" :key="f.value" type="button" class="fchip" :class="{ on: filter === f.value }" :aria-pressed="filter === f.value" @click="filter = f.value">
        {{ f.label }}<span class="n">{{ f.n }}</span>
      </button>
    </div>
    <p v-if="!cases.length" class="muted small empty-line">还没有案例。它在群里拟过草稿、直接回过或看了没回之后，这里会记下每一次，你可以标“该回 / 不该回 / 回得不对”。</p>
    <p v-else-if="!shown.length" class="muted small empty-line">没有符合的案例。</p>
    <article v-for="c in shown" :key="c.id" class="case">
      <div class="who small">
        <strong>{{ c.asker_name || "有人" }}</strong>
        <span class="muted">在</span>
        <router-link v-if="c.chat_kind !== 'p2p' && c.chat_id !== here" :to="`/lark/chats/${encodeURIComponent(c.chat_id)}`" class="place">{{ where(c) }}</router-link>
        <span v-else class="place">{{ where(c) }}</span>
        <span class="muted" :title="fmtTime(c.created_at)">· {{ relTime(c.created_at) }}</span>
        <span v-if="c.scene" class="badge" title="整理经验时归的场景">{{ c.scene }}</span>
        <span v-if="contexts && c.context_id && contexts[c.context_id]" class="badge">{{ contexts[c.context_id] }}</span>
      </div>
      <p class="ask">{{ c.ask }}</p>

      <div class="did small">
        <span class="badge" :class="caseOutcome(c).tone">{{ caseOutcome(c).label }}</span>
        <span v-if="caseOutcome(c).why" class="muted">{{ c.decision === "quiet" ? "" : "原因：" }}{{ caseOutcome(c).why }}</span>
        <router-link v-if="c.handle_run" :to="`/runs/${c.handle_run}`" class="muted">看这次处理</router-link>
      </div>
      <div v-if="c.decision === 'edited' && c.draft" class="text-block">
        <span class="label">原稿</span>
        <p class="draft struck">{{ c.draft }}</p>
        <span class="label">发出的</span>
        <p class="draft">{{ c.final }}</p>
      </div>
      <div v-else-if="c.final || c.draft" class="text-block">
        <span class="label">{{ c.final ? "发出的" : "拟的回复" }}</span>
        <p class="draft">{{ c.final || c.draft }}</p>
      </div>
      <p v-if="c.checked" class="small muted checked"><span class="label">查了什么</span>{{ c.checked }}</p>
      <div v-if="c.owner_reply" class="text-block own">
        <span class="label">你自己回了</span>
        <p class="draft">{{ c.owner_reply }}</p>
      </div>

      <div class="verdict">
        <span class="small muted">你看：</span>
        <div class="row wrap vbtns">
          <button
            v-for="[v, label] in VERDICTS"
            :key="v"
            type="button"
            class="btn sm"
            :class="{ picked: c.verdict === v, [v]: true }"
            :aria-pressed="c.verdict === v"
            :title="c.verdict === v ? '再点一次清除' : undefined"
            @click="pick(c, v)"
          >{{ label }}</button>
        </div>
        <input
          v-if="c.verdict"
          :key="`${c.id}-${c.verdict}`"
          class="input sm note"
          :value="c.note ?? ''"
          placeholder="为什么（可选，回车保存）"
          :aria-label="`对这条的说明：${c.ask.slice(0, 20)}`"
          maxlength="1000"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @change="saveNote(c, ($event.target as HTMLInputElement).value)"
        />
      </div>
    </article>
  </div>
</template>

<style scoped>
.listen-cases {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.filters {
  gap: 6px;
}
.fchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.fchip:hover {
  background-image: linear-gradient(var(--hover), var(--hover));
}
.fchip.on {
  border-color: var(--ink);
  color: var(--ink);
  font-weight: 550;
}
.fchip .n {
  font-size: 11.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.empty-line {
  margin: 0;
}
.case {
  display: grid;
  gap: 8px;
  padding: 14px 0 16px;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.who {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}
.place {
  overflow-wrap: anywhere;
}
.ask {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.65;
}
.did {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}
.text-block {
  display: grid;
  gap: 2px;
  padding-left: 12px;
  border-left: 2px solid var(--line-strong);
}
.text-block.own {
  border-left-color: var(--ok);
}
.label {
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0.04em;
  margin-right: 8px;
}
.draft {
  margin: 0 0 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink-2);
}
.draft.struck {
  color: var(--muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--muted) 60%, transparent);
}
.checked {
  margin: 0;
  overflow-wrap: anywhere;
}
.verdict {
  display: grid;
  gap: 6px;
  margin-top: 2px;
}
.vbtns {
  gap: 6px;
}
.btn.picked {
  font-weight: 600;
}
.btn.picked.should-reply {
  background: var(--ok-soft);
  border-color: var(--ok);
  color: var(--ok);
}
.btn.picked.should-not {
  background: var(--warn-soft);
  border-color: var(--warn);
  color: var(--warn);
}
.btn.picked.wrong {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: var(--danger);
}
.note {
  max-width: 520px;
}
.input.sm {
  height: 30px;
  padding: 4px 10px;
  font-size: 13px;
}
</style>
