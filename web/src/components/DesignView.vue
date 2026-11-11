<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, onServerResync, post } from "../api";
import DesignConcerns from "./DesignConcerns.vue";
import DiffFile from "./DiffFile.vue";
import DiffName from "./DiffName.vue";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { promptDialog } from "../lib/dialog";
import { diffLayout, diffLayoutOptions } from "../lib/diffLayout";
import { refAction } from "../lib/refs";
import { parsePatches } from "../lib/reviews";
import {
  changeLine, concernTally, countParts, DECISION_FIELDS, DONE_LABELS, draftingText, hasChange, KIND_CLS, KIND_LABELS, ORIGIN_LABELS, statusText, STATUS_CLS,
  type Concern, type ConcernState, type Decision, type DesignDetail, type Table,
} from "../lib/designs";
import { fmtTime, openCitation, relTime, state, toast } from "../store";

/**
 * One design (docs/v2/coding-plan.md §5): the facts, the overall table, the gaps and the concerns on
 * the whole first; then the requirement points on the left and the decision cards on the right. A
 * card shows one line per field until it is opened; opened it has the contract snippets, the tables,
 * the rejected approaches, the question, the concerns and, after coding or a branch review, where it
 * landed. The same component on its own page (#/design/:id), in a delegation's “方案” tab and from an
 * item. `embedded`: inside another page (no page title, no link back to the work).
 */
const props = defineProps<{ designId: string; embedded?: boolean }>();
const emit = defineEmits<{ loaded: [detail: DesignDetail] }>();
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

// ---- data ---------------------------------------------------------------------------------------
const detail = ref<DesignDetail | null>(null);
const loading = ref(true);
const failed = ref("");
/** The version shown; null: the current one. */
const revision = ref<number | null>(null);
let seq = 0;
async function load() {
  const request = ++seq, id = props.designId;
  try {
    const d = await get<DesignDetail>(`/api/designs/${encodeURIComponent(id)}${revision.value ? `?revision=${revision.value}` : ""}`);
    if (request !== seq) return;
    detail.value = d;
    failed.value = "";
    emit("loaded", d);
  } catch (e) {
    if (request !== seq) return;
    detail.value = null;
    failed.value = (e as Error).message;
  } finally {
    if (request === seq) loading.value = false;
  }
}

watch(revision, () => void load());
const current = computed(() => !!detail.value && (revision.value === null || revision.value === latestRevision.value));
const latestRevision = computed(() => detail.value?.revisions.at(-1)?.revision ?? detail.value?.revision ?? 0);

// The run writing it ends, or someone changes it elsewhere: read it again.
let timer: ReturnType<typeof setTimeout> | undefined;
const runIds = computed(() => new Set([detail.value?.runId, ...(detail.value?.revisions.map((r) => r.runId) ?? [])].filter(Boolean)));
const off = onServerEvent((e) => {
  const d = detail.value;
  const mine = (e.type === "run" && (runIds.value.has(e.runId) || (d?.status === "drafting" && e.status !== "running" && e.status !== "queued")))
    || (e.type === "changed" && ((e as { entity?: string }).entity === "design" || (e as { entity?: string }).entity === "code-task"));
  if (!mine) return;
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 600);
});
const offResync = onServerResync(() => void load());
onBeforeUnmount(() => { ++seq; off(); offResync(); clearTimeout(timer); });

const body = computed(() => detail.value?.body ?? null);
const counts = computed(() => (detail.value ? countParts(detail.value.counts) : null));
const drafting = computed(() => detail.value?.status === "drafting");
const writingRun = computed(() => detail.value?.runId ?? null);
const revisionOptions = computed(() => [...(detail.value?.revisions ?? [])].reverse().map((r) => ({ value: r.revision as number | null, label: `第 ${r.revision} 版${r.revision === latestRevision.value ? "（最新）" : ""}`, hint: `${fmtTime(r.at)}${r.note ? ` · ${r.note}` : ""}` })));
const shownRevision = computed<number | null>({ get: () => revision.value ?? latestRevision.value, set: (v) => (revision.value = v === latestRevision.value ? null : v) });

// ---- references ---------------------------------------------------------------------------------
/** A design document: `src:` opens in the citation drawer, a link opens in a new tab. */
function sourceLabel(s: string) {
  if (/^https?:\/\//.test(s)) return s.replace(/^https?:\/\//, "").slice(0, 60);
  return s;
}
const workRun = computed(() => detail.value?.work?.rootId);
const refOpen = (r: string) => refAction(r, workRun.value);

// ---- requirement points: picking one highlights its decisions ----------------------------------
const activeReq = ref<string | null>(null);
const reqList = computed(() => {
  const d = detail.value;
  if (!d) return [];
  const known = d.reqs.map((r) => ({ key: r.id, title: r.title, link: `/reqs/${r.id}` as string | null }));
  const ids = new Set(known.map((r) => r.key));
  const loose = [...new Set(d.body.decisions.flatMap((x) => x.reqs).filter((r) => !ids.has(r)))].map((r) => ({ key: r, title: r, link: null }));
  return [...known, ...loose].map((r) => ({ ...r, n: d.body.decisions.filter((x) => x.reqs.includes(r.key)).length }));
});
const reqTitle = (key: string) => reqList.value.find((r) => r.key === key)?.title ?? key;
const dimmed = (d: Decision) => !!activeReq.value && !d.reqs.includes(activeReq.value);

// ---- decision cards -----------------------------------------------------------------------------
const open = ref(new Set<string>());
const toggle = (id: string) => {
  const next = new Set(open.value);
  next.has(id) ? next.delete(id) : next.add(id);
  open.value = next;
};
const MANY = 20;
const showAll = ref(false);
const decisions = computed(() => body.value?.decisions ?? []);
const visibleDecisions = computed(() => (showAll.value || decisions.value.length <= MANY + 5 ? decisions.value : decisions.value.slice(0, MANY)));
const fieldsOf = (d: Decision) => DECISION_FIELDS[d.kind].map((f) => ({ ...f, value: d.fields[f.key] })).filter((f) => f.value || detail.value?.origin === "external");
const changeOf = (d: Decision) => detail.value?.changes.find((c) => c.decision === d.id);
const hasAfter = (d: Decision) => !!d.after && !!(d.after.deviation || d.after.simpler || d.after.done);
const fence = (code: string, lang?: string) => {
  const ticks = code.includes("```") ? "````" : "```";
  return `${ticks}${lang ?? ""}\n${code}\n${ticks}`;
};
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
function tableMd(t: Table) {
  const width = Math.max(t.head.length, ...t.rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")].map(cell);
  return [`| ${pad(t.head).join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`, ...t.rows.map((r) => `| ${pad(r).join(" | ")} |`)].join("\n");
}

// ---- questions: the owner's answers go along with the decision ----------------------------------
const answers = ref<Record<string, string>>({});
const custom = ref<Record<string, string>>({});
const deciding = computed(() => detail.value?.origin === "own" && detail.value.status === "review" && current.value);
const pending = (d: Decision) => !!d.question && !d.question.answer?.trim();
const answerOf = (d: Decision) => answers.value[d.id] ?? "";
function pick(d: Decision, option: string) {
  answers.value = { ...answers.value, [d.id]: option };
  custom.value = { ...custom.value, [d.id]: "" };
}
function typeAnswer(d: Decision, text: string) {
  custom.value = { ...custom.value, [d.id]: text };
  const next = { ...answers.value };
  if (text.trim()) next[d.id] = text.trim();
  else if (!d.question?.options.includes(next[d.id] ?? "")) delete next[d.id];
  answers.value = next;
}
const unanswered = computed(() => decisions.value.filter((d) => pending(d) && !answers.value[d.id]?.trim()));
const givenAnswers = computed(() => Object.fromEntries(Object.entries(answers.value).filter(([id, v]) => v.trim() && decisions.value.some((d) => d.id === id && pending(d)))));

// ---- assessing someone else's design again (its document changed) -------------------------------
async function reassess() {
  const d = detail.value;
  if (!d || working.value) return;
  const said = await promptDialog("重新评估", {
    message: "方案文档更新后用：重新提取决定、核对代码，上一版的每条意见都会给出现在的状态，写成新的一版。",
    placeholder: "这次要特别看什么（可不填）",
    okText: "开始评估",
  });
  if (said === null) return;
  working.value = true;
  try {
    await post("/api/designs", { title: d.title, sources: d.sources, repos: d.repos, author: d.author ?? undefined, note: said.trim() || undefined, designId: d.id });
    toast("已开始重新评估，完成后这里换成新的一版", "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    working.value = false;
  }
}

// ---- deciding on an own design ------------------------------------------------------------------
const working = ref(false);
async function decide(action: "approve" | "comment" | "rethink") {
  const d = detail.value;
  if (!d || working.value) return;
  let text: string | undefined;
  if (action !== "approve") {
    const said = await promptDialog(action === "comment" ? "提意见" : "换个思路", {
      message: action === "comment" ? "写给写方案的 AI：哪里要改、为什么。它会在同一个会话里改出下一版，再请你确认。" : "说一句想换成什么方向（或者为什么现在的不行）。它会重新调查，写一份新的方案。",
      placeholder: action === "comment" ? "如：D2 运费按件数退，和售后规则一致" : "如：不要在网关里算，放到订单服务",
      okText: action === "comment" ? "发出意见" : "重写",
    });
    if (said === null) return;
    text = said.trim();
    if (!text && (action === "rethink" || !Object.keys(givenAnswers.value).length)) return toast("写一句再发", "error");
  }
  working.value = true;
  try {
    await post(`/api/designs/${d.id}/decide`, { action, text, answers: Object.keys(givenAnswers.value).length ? givenAnswers.value : undefined });
    toast(action === "approve" ? "方案已通过，按它开始编码" : action === "comment" ? "意见已发出，改好后再请你确认" : "已让它换个思路重写", "ok");
    answers.value = {};
    custom.value = {};
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    working.value = false;
  }
}

// ---- concerns: the owner marks them ------------------------------------------------------------
async function markConcern(c: Concern, to: ConcernState) {
  const d = detail.value;
  if (!d) return;
  const note = await promptDialog(to === "open" ? "重新打开这条意见" : to === "resolved" ? "标为已解决" : "标为不采纳", {
    message: `${c.id} ${c.text.slice(0, 120)}${c.text.length > 120 ? "…" : ""}\n\n写一句说明（可以不写）：${to === "resolved" ? "怎么解决的" : to === "dropped" ? "为什么不采纳" : "为什么还要看"}。`,
    okText: to === "open" ? "重新打开" : to === "resolved" ? "已解决" : "不采纳",
  });
  if (note === null) return;
  try {
    await post(`/api/designs/${d.id}/concerns/${encodeURIComponent(c.id)}`, { state: to, note: note.trim() || undefined });
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ---- diffs of one decision (or of what is outside them) ------------------------------------------
type Shown = { key: string; title: string; loading: boolean; files: ReturnType<typeof parsePatches>; missing: boolean };
const shown = ref<Shown | null>(null);
const openFiles = ref(new Set<string>());
async function showDiff(key: string, title: string) {
  const d = detail.value;
  if (!d) return;
  if (shown.value?.key === key) return void (shown.value = null);
  shown.value = { key, title, loading: true, files: [], missing: false };
  openFiles.value = new Set();
  try {
    const r = await get<{ patches: { space: string; patch: string }[] }>(`/api/designs/${d.id}/diff?decision=${encodeURIComponent(key)}`);
    if (shown.value?.key !== key) return;
    const files = parsePatches(r.patches ?? []);
    shown.value = { key, title, loading: false, files, missing: !files.some((f) => f.files.length) };
  } catch (e) {
    if (shown.value?.key !== key) return;
    const msg = (e as Error).message;
    if (/404|没有关联|没有决定/.test(msg)) shown.value = { key, title, loading: false, files: [], missing: true };
    else { shown.value = null; toast(msg, "error"); }
  }
}
const toggleFile = (k: string) => { const n = new Set(openFiles.value); n.has(k) ? n.delete(k) : n.add(k); openFiles.value = n; };
const fileCount = (s: Shown) => s.files.reduce((n, d) => n + d.files.length, 0);
const outsideStat = computed(() => {
  const o = detail.value?.outside ?? [];
  const add = o.reduce((n, f) => n + f.add, 0), del = o.reduce((n, f) => n + f.del, 0);
  return `${o.length} 个文件${add || del ? ` +${add} −${del}` : ""}`;
});
// Another design (or the first): start over. Last, after every piece of state it resets.
watch(() => props.designId, () => {
  detail.value = null;
  loading.value = true;
  revision.value = null;
  open.value = new Set();
  answers.value = {};
  custom.value = {};
  activeReq.value = null;
  shown.value = null;
  showAll.value = false;
  void load();
}, { immediate: true });const fileLabel = (f: { space: string; path: string }) => ((detail.value?.repos.length ?? 0) > 1 && f.space ? `${spaceName(f.space)} · ${f.path}` : f.path);
</script>

<template>
  <div class="design" :class="{ embedded }">
    <Skeleton v-if="loading && !detail" variant="text" :rows="8" />
    <p v-else-if="!detail" class="muted small">打不开这份方案{{ failed ? `：${failed}` : "" }}。</p>
    <template v-else>
      <!-- head: what it is, where it comes from, where it stands -->
      <header class="dh">
        <component :is="embedded ? 'h2' : 'h1'" class="dtitle">{{ detail.title }}</component>
        <div class="row wrap meta small">
          <span class="badge">{{ ORIGIN_LABELS[detail.origin] }}<template v-if="detail.origin === 'external' && detail.author"> · {{ detail.author }}</template></span>
          <span class="badge" :class="STATUS_CLS[detail.status]">{{ statusText(detail) }}</span>
          <UiSelect v-if="detail.revisions.length > 1" v-model="shownRevision" size="sm" width="auto" aria-label="看哪一版" :options="revisionOptions" />
          <span v-else-if="detail.revision" class="muted">第 {{ detail.revision }} 版</span>
          <span class="muted">{{ spaceName(detail.spaceId) }} · {{ relTime(detail.updatedAt) }}更新</span>
          <button v-if="detail.origin === 'external' && detail.status === 'assessed' && current" class="lnk" :disabled="working" @click="reassess">重新评估</button>
        </div>
        <div v-if="counts && detail.revision" class="row wrap small tally">
          <span>{{ counts.head }}</span>
          <span v-for="l in counts.levels" :key="l.level" class="badge" :class="l.cls">{{ l.label }} {{ l.n }}</span>
          <span v-if="!counts.levels.length && detail.origin === 'external'" class="muted">没有未解决的意见</span>
        </div>
        <div v-if="detail.sources.length || detail.item || (detail.work && !embedded) || detail.repos.length" class="row wrap small links">
          <template v-for="s in detail.sources" :key="s">
            <a v-if="/^https?:\/\//.test(s)" :href="s" target="_blank" rel="noopener" class="link ellipsis" :title="s"><Icon name="file" :size="13" />{{ sourceLabel(s) }}</a>
            <a v-else-if="refOpen(s)" href="#" class="link ellipsis" :title="s" @click.prevent="refOpen(s)!()"><Icon name="file" :size="13" />方案文档 <span class="mono muted">{{ s }}</span></a>
            <span v-else class="mono muted">{{ s }}</span>
          </template>
          <router-link v-if="detail.item" :to="`/items/${detail.item.id}`" class="link ellipsis" :title="detail.item.title">事项：{{ detail.item.title }}</router-link>
          <router-link v-if="detail.work && !embedded" :to="`/runs/${detail.work.rootId}`" class="link ellipsis" :title="detail.work.title">{{ detail.work.branchReview ? "分支评审" : "交办" }}：{{ detail.work.title }}</router-link>
          <span v-if="detail.repos.length" class="muted">仓库：{{ detail.repos.map(spaceName).join("、") }}</span>
        </div>
      </header>

      <div v-if="drafting" class="note row wrap small" role="status">
        <span class="spinner" aria-hidden="true" />
        <span>{{ draftingText(detail.origin) }}{{ detail.revision ? `：下面是第 ${detail.revision} 版，新的一版写好后会替换` : "，写好后这里显示决定" }}。</span>
        <router-link v-if="writingRun" :to="`/runs/${writingRun}`" class="link">看过程</router-link>
        <router-link v-else-if="detail.work && !embedded" :to="`/runs/${detail.work.rootId}`" class="link">看交办</router-link>
      </div>
      <p v-if="!current" class="note small">这是第 {{ revision }} 版，不是最新的。<button class="lnk" @click="revision = null">看最新的第 {{ latestRevision }} 版</button></p>

      <template v-if="body && detail.revision">
        <!-- before the decisions -->
        <section v-if="body.facts.length" class="block">
          <div class="section-title">影响方案的事实</div>
          <ul class="facts">
            <li v-for="(f, i) in body.facts" :key="i">
              <Markdown class="inline-md" :source="f.text" :space="detail.spaceId" :run-id="workRun" />
              <span v-if="f.refs?.length" class="refs small">
                <template v-for="r in f.refs" :key="r"><a v-if="refOpen(r)" href="#" class="mono" @click.prevent="refOpen(r)!()">{{ r }}</a><span v-else class="mono muted">{{ r }}</span></template>
              </span>
            </li>
          </ul>
        </section>
        <section v-if="body.matrix" class="block">
          <div class="section-title">整体的行为表<template v-if="body.matrix.title">：{{ body.matrix.title }}</template></div>
          <Markdown :source="tableMd(body.matrix)" :space="detail.spaceId" />
        </section>
        <section v-if="body.gaps?.length" class="block">
          <div class="section-title">和要求不一致的地方</div>
          <ul class="facts"><li v-for="(g, i) in body.gaps" :key="i"><Markdown class="inline-md" :source="g" :space="detail.spaceId" /></li></ul>
        </section>
        <section v-if="body.concerns?.length" class="block">
          <div class="section-title">整份方案的意见</div>
          <DesignConcerns :concerns="body.concerns!" :editable="current" :space="detail.spaceId" :run-id="workRun" @mark="markConcern" />
        </section>

        <!-- requirement points | decisions -->
        <div class="main" :class="{ 'with-reqs': reqList.length }">
          <aside v-if="reqList.length" class="reqs" aria-label="需求点">
            <div class="section-title">需求点</div>
            <button v-for="r in reqList" :key="r.key" type="button" class="req" :class="{ on: activeReq === r.key }" :aria-pressed="activeReq === r.key" :title="r.title" @click="activeReq = activeReq === r.key ? null : r.key">
              <span class="ellipsis grow">{{ r.title }}</span><span class="muted small">{{ r.n }}</span>
            </button>
            <p v-if="activeReq" class="muted small">只亮出挂在它下面的决定。<button class="lnk" @click="activeReq = null">全部</button></p>
          </aside>

          <div class="cards">
            <div class="row wrap cards-head">
              <span class="section-title">决定 · {{ decisions.length }}</span>
              <span class="spacer" />
              <button v-if="decisions.length" class="btn ghost sm" @click="open = open.size ? new Set() : new Set(visibleDecisions.map((d) => d.id))">{{ open.size ? "全部收起" : "全部展开" }}</button>
            </div>
            <article v-for="d in visibleDecisions" :key="d.id" class="card dcard" :class="{ on: open.has(d.id), dim: dimmed(d) }" :data-ask-label="`${d.id} ${d.title}`">
              <button type="button" class="dhead" :aria-expanded="open.has(d.id)" @click="toggle(d.id)">
                <span class="did mono">{{ d.id }}</span>
                <span class="badge" :class="KIND_CLS[d.kind]">{{ KIND_LABELS[d.kind] }}</span>
                <span class="dt">{{ d.title }}</span>
                <span class="tags">
                  <span v-if="pending(d)" class="badge warn">要你定</span>
                  <span v-if="d.stated === false" class="badge" title="方案文档里没有，实现时必须定，是读代码推断出来的">文档没写，推断出来的</span>
                  <span v-for="t in concernTally(d)" :key="t.level" class="badge" :class="t.cls">{{ t.label }} {{ t.n }}</span>
                  <span v-if="d.after?.done" class="badge" :class="DONE_LABELS[d.after.done].cls">{{ DONE_LABELS[d.after.done].text }}</span>
                </span>
                <Icon name="down" :size="14" class="caret" :class="{ flip: open.has(d.id) }" />
              </button>

              <!-- collapsed: one line per field -->
              <dl v-if="!open.has(d.id)" class="brief small" @click="toggle(d.id)">
                <template v-for="f in fieldsOf(d)" :key="f.key">
                  <dt>{{ f.label }}</dt>
                  <dd :class="{ muted: !f.value }">{{ f.value?.brief ?? "（方案没写）" }}</dd>
                </template>
                <template v-if="pending(d) && d.question"><dt>要你定</dt><dd>{{ d.question.text }}</dd></template>
                <template v-if="hasChange(changeOf(d))"><dt>改动</dt><dd>{{ changeLine(changeOf(d)) || "—" }}</dd></template>
                <template v-if="d.after?.deviation"><dt>偏差</dt><dd>{{ d.after.deviation }}</dd></template>
              </dl>

              <!-- opened -->
              <div v-else class="body">
                <p v-if="d.reqs.length" class="small muted">需求点：{{ d.reqs.map(reqTitle).join("、") }}</p>
                <div v-for="f in fieldsOf(d)" :key="f.key" class="field-block">
                  <div class="fl small">{{ f.label }}</div>
                  <template v-if="f.value">
                    <p class="fb">{{ f.value.brief }}</p>
                    <Markdown v-if="f.value.text" class="small" :source="f.value.text" :space="detail.spaceId" :run-id="workRun" />
                    <Markdown v-if="f.value.code" class="code" :source="fence(f.value.code, f.value.lang)" :linkify="false" />
                    <Markdown v-if="f.value.table" class="small" :source="tableMd(f.value.table)" :space="detail.spaceId" />
                  </template>
                  <p v-else class="muted small">（方案没写）</p>
                </div>
                <div v-if="d.rejected?.length" class="field-block">
                  <div class="fl small">不选的做法</div>
                  <ul class="small rejected"><li v-for="(r, i) in d.rejected" :key="i"><span>{{ r.text }}</span><span class="muted"> —— {{ r.why }}</span></li></ul>
                </div>

                <div v-if="d.question" class="question" :class="{ waiting: pending(d) }">
                  <div class="fl small">{{ pending(d) ? "要你定" : "定下的" }}</div>
                  <p class="small">{{ d.question.text }}</p>
                  <template v-if="pending(d) && deciding">
                    <div class="opts" role="radiogroup" :aria-label="`${d.id} 的选项`">
                      <button v-for="(o, i) in d.question.options" :key="o" type="button" role="radio" class="opt" :aria-checked="answerOf(d) === o" :class="{ on: answerOf(d) === o }" @click="pick(d, o)">
                        <span class="dot" aria-hidden="true" />{{ o }}<span v-if="d.question.recommended === i" class="badge accent">建议</span>
                      </button>
                    </div>
                    <input class="input sm" :value="custom[d.id] ?? ''" placeholder="或者写别的回答" :aria-label="`${d.id} 别的回答`" @input="typeAnswer(d, ($event.target as HTMLInputElement).value)" />
                  </template>
                  <ul v-else class="small opts-read">
                    <li v-for="(o, i) in d.question.options" :key="o" :class="{ picked: d.question.answer === o }">{{ o }}<span v-if="d.question.recommended === i" class="muted">（建议）</span></li>
                  </ul>
                  <p v-if="d.question.answer && !d.question.options.includes(d.question.answer)" class="small">回答：{{ d.question.answer }}</p>
                  <p v-else-if="pending(d) && !deciding" class="small muted">{{ detail.origin === "own" ? "等确认时在这里回答。" : "要问作者。" }}</p>
                </div>

                <div v-if="d.concerns?.length" class="field-block">
                  <div class="fl small">意见</div>
                  <DesignConcerns :concerns="d.concerns!" :editable="current" :space="detail.spaceId" :run-id="workRun" @mark="markConcern" />
                </div>

                <!-- after coding / reviewing the branch -->
                <div v-if="hasChange(changeOf(d)) || hasAfter(d)" class="after">
                  <div class="fl small">{{ detail.work?.branchReview || detail.origin === "external" ? "分支里的实现" : "编码后" }}</div>
                  <div v-if="hasChange(changeOf(d))" class="row wrap small">
                    <span class="muted">改动</span><span>{{ changeLine(changeOf(d)) || "没有改动" }}</span>
                    <span v-if="changeOf(d)!.findings.total" class="muted">· 评审问题 {{ changeOf(d)!.findings.open }} 个未解决 / 共 {{ changeOf(d)!.findings.total }}</span>
                    <button class="lnk" :aria-expanded="shown?.key === d.id" @click="showDiff(d.id, `${d.id} 的改动`)">{{ shown?.key === d.id ? "收起 diff" : "看 diff" }}</button>
                  </div>
                  <ul v-if="changeOf(d)?.tasks.length" class="small tasks"><li v-for="t in changeOf(d)!.tasks" :key="t.seq"><span class="mono muted">T{{ t.seq }}</span> {{ t.title }}</li></ul>
                  <p v-if="d.after?.done" class="small"><span class="muted">做了没有：</span>{{ DONE_LABELS[d.after.done].text }}</p>
                  <div v-if="d.after?.deviation" class="small"><span class="muted">偏差：</span><Markdown class="inline-md" :source="d.after.deviation" :space="detail.spaceId" :run-id="workRun" /></div>
                  <div v-if="d.after?.simpler" class="small"><span class="muted">更简单的做法：</span><Markdown class="inline-md" :source="d.after.simpler" :space="detail.spaceId" :run-id="workRun" /></div>
                  <p v-if="!hasChange(changeOf(d)) && hasAfter(d)" class="small"><button class="lnk" @click="showDiff(d.id, `${d.id} 的改动`)">{{ shown?.key === d.id ? "收起 diff" : "看 diff" }}</button></p>
                </div>
                <div v-if="shown?.key === d.id" class="shown">
                  <template v-if="shown.loading"><Skeleton variant="lines" :rows="3" /></template>
                  <p v-else-if="shown.missing" class="muted small">还没有关联的代码。</p>
                  <template v-else>
                    <div class="row wrap small"><span class="muted">{{ fileCount(shown) }} 个文件</span><span class="spacer" /><UiSegmented v-if="fileCount(shown)" v-model="diffLayout" size="sm" :options="diffLayoutOptions" aria-label="差异的排列" /></div>
                    <p v-if="!fileCount(shown)" class="muted small">没有改动。</p>
                    <template v-for="r in shown.files" :key="r.space">
                      <div v-for="f in r.files" :key="`${r.space}:${f.name}`" class="file">
                        <button class="fhead mono small" :aria-expanded="openFiles.has(`${r.space}:${f.name}`)" @click="toggleFile(`${r.space}:${f.name}`)"><DiffName :file="f" /><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span></button>
                        <DiffFile v-if="openFiles.has(`${r.space}:${f.name}`)" :run-id="workRun ?? ''" :space="r.space" :lines="f.lines" :expandable="!!workRun" />
                      </div>
                    </template>
                  </template>
                </div>
              </div>
            </article>
            <button v-if="visibleDecisions.length < decisions.length" class="btn ghost sm more" @click="showAll = true">还有 {{ decisions.length - visibleDecisions.length }} 个决定，全部显示</button>

            <!-- changes outside every decision -->
            <section v-if="detail.outside.length" class="card dcard outside">
              <div class="dhead static">
                <span class="dt">方案之外的改动</span>
                <span class="muted small">{{ outsideStat }}</span>
                <span class="spacer" />
                <button class="lnk small" :aria-expanded="shown?.key === 'outside'" @click="showDiff('outside', '方案之外的改动')">{{ shown?.key === "outside" ? "收起 diff" : "看 diff" }}</button>
              </div>
              <ul class="small mono files"><li v-for="f in detail.outside" :key="`${f.space}/${f.path}`" :title="f.path"><span class="ellipsis">{{ fileLabel(f) }}</span><span v-if="f.add || f.del" class="muted"> +{{ f.add }} −{{ f.del }}</span></li></ul>
              <div v-if="shown?.key === 'outside'" class="shown">
                <Skeleton v-if="shown.loading" variant="lines" :rows="3" />
                <p v-else-if="shown.missing" class="muted small">还没有关联的代码。</p>
                <template v-else>
                  <template v-for="r in shown.files" :key="r.space">
                    <div v-for="f in r.files" :key="`${r.space}:${f.name}`" class="file">
                      <button class="fhead mono small" :aria-expanded="openFiles.has(`${r.space}:${f.name}`)" @click="toggleFile(`${r.space}:${f.name}`)"><DiffName :file="f" /><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span></button>
                      <DiffFile v-if="openFiles.has(`${r.space}:${f.name}`)" :run-id="workRun ?? ''" :space="r.space" :lines="f.lines" :expandable="!!workRun" />
                    </div>
                  </template>
                </template>
              </div>
            </section>
          </div>
        </div>
      </template>
      <p v-else-if="!drafting" class="muted small">这份方案还没有内容。</p>

      <!-- the owner's own design waiting for them -->
      <div v-if="deciding" class="decide" role="region" aria-label="确认方案">
        <span class="small grow">{{ unanswered.length ? `还有 ${unanswered.length} 个问题没回答（${unanswered.map((d) => d.id).join("、")}），答完才能通过` : "看完决定后：通过就按它编码；有要改的提意见，方向不对就换个思路。" }}</span>
        <button class="btn primary sm" :disabled="working || unanswered.length > 0" :title="unanswered.length ? '先回答要你定的问题' : ''" @click="decide('approve')">通过</button>
        <button class="btn sm" :disabled="working" @click="decide('comment')">提意见</button>
        <button class="btn ghost sm" :disabled="working" @click="decide('rethink')">换个思路</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.design { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; container-type: inline-size; }
.dh { display: grid; gap: 6px; min-width: 0; }
.dtitle { margin: 0; font-family: var(--serif); font-size: 22px; line-height: 1.35; overflow-wrap: anywhere; }
.embedded .dtitle { font-size: 17px; }
.meta, .tally, .links { gap: 6px 10px; }
.links .link { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; }
.note { gap: 8px; margin: 0; padding: 8px 12px; border-radius: var(--radius); background: var(--accent-soft); }
.block { display: grid; gap: 6px; min-width: 0; }
.block > .section-title { margin: 0; }
.facts { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: 14px; }
/* Denser than an article: the design is read card by card. */
.design :deep(.prose) { font-size: 14px; line-height: 1.7; }
.design :deep(.prose.small) { font-size: 13px; }
.design :deep(.prose > :last-child) { margin-bottom: 0; }
.design .inline-md { font-size: inherit; line-height: inherit; }
.facts li { overflow-wrap: anywhere; }
.inline-md { display: inline; }
.inline-md :deep(p) { display: inline; margin: 0; }
.refs { margin-left: 6px; display: inline-flex; flex-wrap: wrap; gap: 2px 8px; }
.main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
.main.with-reqs { grid-template-columns: minmax(150px, 220px) minmax(0, 1fr); }
.reqs { position: sticky; top: 8px; display: grid; gap: 2px; min-width: 0; }
.reqs .section-title { margin: 0 0 4px; }
.req { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; border: 0; background: none; font: inherit; color: inherit; text-align: left; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.req:hover { background: var(--hover); }
.req.on { background: var(--accent-soft); }
.grow { flex: 1; min-width: 0; }
.cards { display: grid; gap: 10px; min-width: 0; }
.cards-head .section-title { margin: 0; }
.dcard { padding: 0; overflow: hidden; min-width: 0; transition: opacity 0.15s; }
.dcard.dim { opacity: 0.4; }
.dcard.on { border-color: var(--line-strong); }
.dhead { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; width: 100%; min-width: 0; padding: 10px 12px; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.dhead.static { cursor: default; }
.dhead:hover:not(.static) { background: var(--hover); }
.did { color: var(--muted); font-size: 12.5px; }
.dt { flex: 1 1 14em; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.caret { color: var(--muted); flex: none; transition: transform 0.15s; }
.caret.flip { transform: rotate(180deg); }
.brief { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 12px; margin: 0; padding: 0 12px 10px 12px; cursor: pointer; }
.brief dt { color: var(--muted); }
.brief dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.body { display: grid; gap: 12px; padding: 2px 12px 12px; min-width: 0; }
.field-block { display: grid; gap: 4px; min-width: 0; }
.field-block p, .after p { margin: 0; }
.fl { color: var(--muted); font-weight: 600; }
.fb { margin: 0; overflow-wrap: anywhere; }
.code { min-width: 0; }
.code :deep(pre) { margin: 0; overflow-x: auto; font-size: 12.5px; }
.rejected { margin: 0; padding-left: 1.2em; display: grid; gap: 2px; }
.question { display: grid; gap: 6px; padding: 10px 12px; border-radius: 8px; background: var(--sunken); min-width: 0; }
.question.waiting { background: var(--warn-soft); }
.question p { margin: 0; overflow-wrap: anywhere; }
.opts { display: grid; gap: 4px; }
.opt { display: flex; align-items: center; gap: 8px; min-width: 0; text-align: left; border: 1px solid var(--line); background: var(--panel); color: var(--ink); font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 8px; cursor: pointer; overflow-wrap: anywhere; }
.opt:hover { border-color: var(--line-strong); }
.opt.on { border-color: var(--accent); background: var(--accent-soft); }
.opt:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.dot { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid var(--line-strong); flex: none; }
.opt.on .dot { border-color: var(--accent); background: radial-gradient(var(--accent) 45%, transparent 50%); }
.opts-read { margin: 0; padding-left: 1.2em; }
.opts-read .picked { font-weight: 600; }
.after { display: grid; gap: 4px; padding-top: 10px; border-top: 1px dashed var(--line-strong); min-width: 0; }
.after .row { gap: 4px 8px; }
.tasks { margin: 0; padding-left: 1.2em; }
.shown { display: grid; gap: 6px; min-width: 0; }
.file { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; min-width: 0; }
.fhead { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 7px 12px; border: 0; background: var(--sunken); color: inherit; font: inherit; cursor: pointer; text-align: left; }
.add { color: var(--ok); }
.rm { color: var(--danger); }
.files { margin: 0; padding: 0 12px 10px 28px; display: grid; gap: 2px; }
.files li { min-width: 0; overflow-wrap: anywhere; }
.outside .shown { padding: 0 12px 12px; }
.more { justify-self: start; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; }
.decide { position: sticky; bottom: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); box-shadow: var(--shadow); }
@container (max-width: 680px) {
  .main.with-reqs { grid-template-columns: minmax(0, 1fr); }
  .reqs { position: static; }
  .brief { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .brief dt { margin-top: 4px; }
}
</style>
