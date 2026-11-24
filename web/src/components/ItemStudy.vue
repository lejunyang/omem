<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, onServerEvent, onServerResync, post, put } from "../api";
import { promptDialog } from "../lib/dialog";
import { refAction } from "../lib/refs";
import { landOn } from "../lib/landing";
import { objectStatusWords } from "../lib/flow";
import { byConcern, byUnjudged, directionWords, findingWord, kindWords, progress, scopeWords, total, trialTone, trialWord, verifiedWords, type StudyDirection, type StudyFinding, type StudyScope, type StudyTrial, type StudyView } from "../lib/study";
import { fmtTime } from "../store";
import RankBars from "./charts/RankBars.vue";
import Markdown from "./Markdown.vue";
import RunArtifacts from "./RunArtifacts.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * A study's ledger on the item page (docs/v2/studies.md): what it found, what it tried, the directions
 * and how much of the feature list has been tried. `choosing`: the flow is waiting for the owner to
 * pick this round's direction, which is done here. `focus`: a direction or trial to open on (the progress view's link).
 */
type Tab = "findings" | "trials" | "directions" | "coverage";
const props = withDefaults(defineProps<{ itemId: string; editable?: boolean; choosing?: boolean; focus?: { kind: "direction" | "trial"; id: string } | null }>(), { editable: true, focus: null });
const data = ref<StudyView | null>(null), error = ref(""), loading = ref(true), busy = ref(false);
const tab = ref<Tab>("findings"), everyRound = ref(false), showFixed = ref(false);
const router = useRouter();
let seq = 0, epoch = 0, picked = false;
/** The repositories that could be added to the scope, loaded when the owner opens it. */
const candidates = ref<{ id: string; name: string }[]>([]);
/** Per proposed direction: may its findings be turned into code changes (offered only when the scope allows it). */
const withCode = ref<Record<string, boolean>>({});
/** The push permission as it is being typed; saved together with one button. */
const pushRemote = ref(""), pushPrefix = ref("");
const pushDirty = computed(() => pushRemote.value.trim() !== (data.value?.scope?.pushRemote ?? "") || pushPrefix.value.trim() !== (data.value?.scope?.pushPrefix ?? ""));

const proposed = computed(() => props.choosing ? data.value?.directions.filter((d) => d.state === "proposed") ?? [] : []);
const going = computed(() => data.value?.directions.filter((d) => d.state === "confirmed" || d.state === "active").at(-1) ?? null);
const allFindings = computed(() => [...data.value?.findings ?? []].sort(byUnjudged));
const fixedCount = computed(() => allFindings.value.filter((f) => f.fixedAt).length);
/** Fixed ones are out of the way unless asked for. */
const findings = computed(() => showFixed.value ? allFindings.value : allFindings.value.filter((f) => !f.fixedAt));
const fresh = computed(() => allFindings.value.filter((f) => f.state === "new" && !f.fixedAt).length);
const round = computed(() => Math.max(0, ...(data.value?.trials ?? []).map((t) => t.round)));
const trials = computed(() => {
  const all = data.value?.trials ?? [];
  return (everyRound.value ? [...all] : all.filter((t) => t.round === round.value)).sort((a, b) => b.round - a.round || byConcern(a, b));
});
/** The one in hand first, then the ones waiting to be picked (as proposed), then earlier ones, newest round first. */
const rank = (d: StudyDirection) => d.state === "confirmed" || d.state === "active" ? 0 : d.state === "proposed" ? 1 : 2;
const directions = computed(() => (data.value?.directions ?? []).map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || (rank(a.d) === 2 ? b.d.round - a.d.round : 0) || a.i - b.i).map((x) => x.d));
const tried = computed(() => (data.value?.coverage.features ?? []).filter((f) => f.trials > 0).sort((a, b) => b.trials - a.trials));
const untried = computed(() => (data.value?.coverage.features ?? []).filter((f) => !f.trials));
const empty = computed(() => !!data.value && !data.value.directions.length && !data.value.trials.length && !data.value.findings.length && !data.value.coverage.ref);
const tabs = computed(() => [
  { value: "findings" as Tab, label: `发现 ${allFindings.value.length - fixedCount.value}` },
  { value: "trials" as Tab, label: `试验 ${data.value?.trials.length ?? 0}` },
  { value: "directions" as Tab, label: `方向 ${data.value?.directions.length ?? 0}` },
  { value: "coverage" as Tab, label: "覆盖" },
]);

function take(view: StudyView) {
  const typing = !!data.value && pushDirty.value;
  data.value = view; error.value = "";
  if (!typing) { pushRemote.value = view.scope?.pushRemote ?? ""; pushPrefix.value = view.scope?.pushPrefix ?? ""; }
  // Open on what matters now, once: a direction to pick, then findings, then the trials.
  if (!picked) { picked = true; tab.value = proposed.value.length ? "directions" : view.findings.length ? "findings" : view.trials.length ? "trials" : view.directions.length ? "directions" : "coverage"; }
  focusOn();
}
/** Open on the direction or trial asked for, once per address; one not in the ledger is ignored. */
let focused = "";
function focusOn() {
  const f = props.focus, v = data.value;
  if (!f || !v || focused === `${props.itemId}:${f.kind}:${f.id}`) return;
  if (f.kind === "trial" ? !v.trials.some((t) => t.id === f.id) : !v.directions.some((d) => d.id === f.id)) return;
  focused = `${props.itemId}:${f.kind}:${f.id}`;
  tab.value = f.kind === "trial" ? "trials" : "directions";
  if (f.kind === "trial" && v.trials.find((t) => t.id === f.id)!.round !== round.value) everyRound.value = true;
  void landOn(`study-${f.kind}-${f.id}`);
}
watch(() => props.focus, focusOn);
async function load() {
  const request = ++seq, id = props.itemId;
  try { const view = await get<StudyView>(`/api/items/${id}/study`); if (request === seq && id === props.itemId) take(view); }
  catch (e) { if (request === seq) error.value = (e as Error).message; }
  finally { if (request === seq) loading.value = false; }
}
watch(() => props.itemId, () => { ++epoch; ++seq; picked = false; candidates.value = []; withCode.value = {}; data.value = null; error.value = ""; busy.value = false; loading.value = true; everyRound.value = false; void load(); }, { immediate: true });
watch(() => props.choosing, (now) => { if (now) tab.value = "directions"; });
const off = onServerEvent((e) => { if (e.type === "changed" && e.entity === "item" && e.id === props.itemId) void load(); });
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++epoch; ++seq; off(); resync(); });

async function send(path: string, payload: unknown) {
  if (busy.value || !props.editable) return;
  const generation = epoch;
  busy.value = true; error.value = ""; ++seq;
  try { const view = await post<StudyView>(`/api/items/${props.itemId}/study/${path}`, payload); if (generation === epoch) { ++seq; take(view); } }
  catch (e) { if (generation === epoch) error.value = (e as Error).message; }
  finally { if (generation === epoch) busy.value = false; }
}
/** The owner picks this round's direction (or none), with a line of changes if any. */
async function choose(d: StudyDirection | null) {
  const generation = epoch;
  const answer = await promptDialog(d ? `这一轮就做：${d.goal}` : "这一轮不跑", {
    message: d ? "确认后助手按这个方向逐个去试。想改的地方写在下面，没有就留空。" : "这一轮到此为止，下一轮再定方向。",
    fields: d ? [{ id: "note", label: "要改的地方", value: "", maxLength: 2000 }] : [{ id: "note", label: "原因（可不填）", value: "", maxLength: 2000 }],
    okText: d ? "就做这个" : "这一轮不跑",
  });
  if (!answer || generation !== epoch) return;
  await send("choose", { direction: d?.id ?? null, note: answer.note?.trim() || undefined, ...(d && data.value?.scope?.allowCode ? { allowCode: withCode.value[d.id] ?? true } : {}) });
}
async function openScope(e: Event) {
  if (!(e.target as HTMLDetailsElement).open || candidates.value.length) return;
  const id = props.itemId;
  try { const scope = await get<StudyScope>(`/api/items/${id}/study/scope`); if (id === props.itemId) candidates.value = scope.candidates ?? scope.repos; }
  catch (err) { error.value = (err as Error).message; }
}
/** The owner changes what this study may touch. */
async function saveScope(patch: { repos?: string[]; allowCode?: boolean; thirdParty?: boolean; pushRemote?: string | null; pushPrefix?: string | null }) {
  if (busy.value || !props.editable) return;
  const generation = epoch;
  busy.value = true; error.value = "";
  try { await put(`/api/items/${props.itemId}/study/scope`, patch); if (generation === epoch) await load(); }
  catch (e) { if (generation === epoch) error.value = (e as Error).message; }
  finally { if (generation === epoch) busy.value = false; }
}
async function savePush() {
  const remote = pushRemote.value.trim(), prefix = pushPrefix.value.trim();
  await saveScope({ pushRemote: remote, pushPrefix: prefix });
  if (!error.value) { pushRemote.value = remote; pushPrefix.value = prefix; }
}
function toggleRepo(id: string, on: boolean) {
  const now = (data.value?.scope?.repos ?? []).map((r) => r.id);
  void saveScope({ repos: on ? [...new Set([...now, id])] : now.filter((x) => x !== id) });
}
/** The owner turns a finding into a code delegation: the change stays on its own branch and goes through review. */
async function fix(f: StudyFinding) {
  const generation = epoch;
  const answer = await promptDialog("去改这一条", { message: `${f.title}\n会发起一次编码交办：改动留在它自己的分支上，经过评审，不合并也不推送，改完由你决定用不用。`, fields: [{ id: "note", label: "要补的要求（可不填）", value: "", maxLength: 2000 }], okText: "发起修改" });
  if (!answer || generation !== epoch) return;
  await send(`findings/${encodeURIComponent(f.id)}/fix`, { note: answer.note?.trim() || undefined });
}
async function close(d: StudyDirection, state: "done" | "dropped") {
  const generation = epoch;
  const answer = await promptDialog(state === "done" ? "这个方向做完了" : "放下这个方向", {
    message: `${d.goal}\n没跑的试验不再跑。结论会留在记录里，以后定方向时能看到。`,
    fields: [{ id: "conclusion", label: "结论", value: "", required: true, maxLength: 4000 }],
    okText: state === "done" ? "做完了" : "放下",
  });
  if (!answer?.conclusion.trim() || generation !== epoch) return;
  await send(`directions/${encodeURIComponent(d.id)}/close`, { state, conclusion: answer.conclusion.trim() });
}
async function judge(f: StudyFinding, state: "confirmed" | "rejected" | "later") {
  let reason: string | undefined;
  if (state === "rejected") {
    const generation = epoch;
    const answer = await promptDialog("这条不算", { message: `${f.title}\n写了原因，以后定方向和归并发现时会参考。`, fields: [{ id: "reason", label: "为什么不算（可不填）", value: "", maxLength: 2000 }], okText: "不算" });
    if (!answer || generation !== epoch) return;
    reason = answer.reason?.trim() || undefined;
  }
  await send(`findings/${encodeURIComponent(f.id)}`, { state, reason });
}
/**
 * Take one finding into a conversation: the assistant gets the item, the finding's id and its text, the
 * owner writes the rest. `rewrite`: ask it to check the trials and re-describe it (revise_study_finding).
 */
function discuss(f: StudyFinding, rewrite = false) {
  const quote = `${f.title}\n\n${f.repro}`.slice(0, 1500).replace(/\n/g, "\n> ");
  const head = `关于研究（事项 ${props.itemId}）的发现 ${f.id}（${kindWords[f.kind]}，${findingWord(f)}）：\n\n> ${quote}\n\n`;
  const ask = rewrite ? "这条写得不清楚。请用 read_ledger 读它依据的试验，必要时读代码确认它成不成立，再用 revise_study_finding 重写正文：分“条件 / 现象 / 为什么是问题 / 建议”几节，命令和输出放代码块。不成立就告诉我原因，先不改状态。" : "";
  void router.push({ path: "/ask", query: { draft: head + ask } });
}
/** The owner closes a finding as fixed, saying by what (a commit, a release); any other call reopens it. */
async function markFixed(f: StudyFinding) {
  const generation = epoch;
  const answer = await promptDialog("标为已改好", { message: `${f.title}\n改好的发现排到最后，之后定方向和归并时不会再当成新问题。`, fields: [{ id: "note", label: "怎么改好的（提交、版本或交办，可不填）", value: "", maxLength: 2000 }], okText: "已改好" });
  if (!answer || generation !== epoch) return;
  await send(`findings/${encodeURIComponent(f.id)}`, { state: "fixed", reason: answer.note?.trim() || undefined });
}
/** The commits a trial ran on, shortened. */
const shas = (t: StudyTrial) => Object.values(t.commits ?? {}).map((c) => c.slice(0, 8)).join("、");
const trialMeta = (t: StudyTrial) => [trialWord(t), t.peer ? `在 ${t.peer} 上` : "", t.fixOf ? "改动之后的重跑" : "", t.unsure ? "它自己拿不准" : "", t.escalated ? "请更好的模型看过" : "", t.attempts > 1 ? `第 ${t.attempts} 次` : "", everyRound.value ? `第 ${t.round} 轮` : ""].filter(Boolean).join(" · ");
</script>

<template>
  <section class="item-study" aria-label="研究" :aria-busy="busy">
    <div class="study-head">
      <span class="study-name">研究记录</span>
      <span v-if="fresh" class="study-fresh">{{ fresh }} 条发现等你看</span>
      <span v-if="data && data.idleRounds > 0" class="muted small">连着 {{ data.idleRounds }} 轮没有新发现</span>
    </div>
    <details v-if="data?.scope" class="scope" @toggle="openScope">
      <summary><span class="muted">范围</span>{{ scopeWords(data.scope) }}</summary>
      <div class="scope-body">
        <div class="scope-repos">
          <span class="muted">可以读写的仓库</span>
          <UiCheckbox v-for="r in candidates.length ? candidates : data.scope.repos" :key="r.id" :model-value="data.scope.repos.some((x) => x.id === r.id)" size="sm" :disabled="busy || !editable" @change="(v: boolean) => toggleRepo(r.id, v)">{{ r.name }}</UiCheckbox>
          <span v-if="!data.scope.repos.length && !candidates.length" class="muted">这件事所在的空间下面没有仓库。试验只能读材料，跑不了命令。</span>
        </div>
        <UiCheckbox :model-value="data.scope.allowCode" switch :disabled="busy || !editable" @change="(v: boolean) => saveScope({ allowCode: v })">可以改代码：从一条发现发起编码交办。改动留在交办自己的分支上，经过评审，不合并、不推送</UiCheckbox>
        <UiCheckbox :model-value="data.scope.thirdParty" switch :disabled="busy || !editable" @change="(v: boolean) => saveScope({ thirdParty: v })">本机可以执行第三方样本的代码：拿别人的仓库当样本时，会在这台机器上跑它的安装脚本和构建脚本（只在研究自己的工作区里）</UiCheckbox>
        <div class="push">
          <div>推送：只推到下面这个远端、这个分支前缀下面。两项都填了，试验才能把自己工作区里的提交推上去（比如推到测试分支让托管的流水线跑）；主分支和别的远端推不了，每次推送都留记录。留空就是不推。</div>
          <div class="push-line">
            <label class="field"><span>远端的名字</span><input v-model="pushRemote" class="input mono" placeholder="origin" :disabled="busy || !editable" /></label>
            <label class="field"><span>分支前缀（以 / 结尾）</span><input v-model="pushPrefix" class="input mono" placeholder="study/" :disabled="busy || !editable" /></label>
            <button v-if="editable && pushDirty" type="button" class="btn sm primary" :disabled="busy" @click="savePush">保存</button>
          </div>
        </div>
        <details v-if="data.pushes?.length" class="sub">
          <summary>推过 {{ data.pushes.length }} 次</summary>
          <ul><li v-for="x in data.pushes" :key="x.id"><span class="mono">{{ x.remote }} {{ x.branch }}</span><span class="muted"> · {{ x.commit.slice(0, 8) }} · {{ fmtTime(x.at) }}</span><span v-if="x.note" class="muted prior">{{ x.note }}</span></li></ul>
        </details>
        <p class="muted">试验在宿主给这个研究单独建的工作区里跑，不碰你的仓库目录。别的执行环境在 设置 → 推进工作 → 研究的试验在哪跑 里登记。</p>
      </div>
    </details>
    <Skeleton v-if="loading" variant="text" :rows="3" />
    <p v-if="error" class="error small" role="alert">{{ error }} <button class="btn ghost sm" :disabled="busy" @click="load">重试</button></p>
    <p v-if="empty" class="muted small">还没有内容：先把项目的功能梳理成清单，定了方向以后，每个试验的结果和归并出的发现都记在这里。</p>
    <template v-else-if="data">
      <div v-if="going" class="going">
        <div class="going-goal"><span class="muted">这一轮在试</span>{{ going.goal }}</div>
        <div v-if="total(going)" class="bar" role="img" :aria-label="progress(going).map((p) => `${p.label} ${p.n}`).join('，')">
          <span v-for="p in progress(going)" :key="p.tone" :class="`t-${p.tone}`" :style="{ flexGrow: p.n }" />
        </div>
        <div class="legend small">
          <span class="muted">{{ total(going) }} 个试验</span>
          <span v-for="p in progress(going)" :key="p.tone" class="legend-item"><i :class="`t-${p.tone}`" />{{ p.label }} {{ p.n }}</span>
        </div>
      </div>
      <UiSegmented v-model="tab" size="sm" aria-label="记录的几部分" :options="tabs" />

      <div v-if="tab === 'findings'" class="rows">
        <p v-if="!allFindings.length" class="muted small">还没有发现。一轮试验跑完，小结会把几个试验里的同一个问题归并成一条，列在这里等你看。</p>
        <p v-else-if="!findings.length" class="muted small">发现都改好了。</p>
        <details v-for="f in findings" :key="f.id" class="entry" :open="f.state === 'new' && fresh <= 3">
          <summary>
            <span class="kind" :class="f.kind">{{ kindWords[f.kind] }}</span>
            <span class="entry-name">{{ f.title }}</span>
            <span class="entry-meta" :class="f.fixedAt ? 'fixed' : f.state === 'new' ? 'waiting' : 'muted'">{{ findingWord(f) }}</span>
          </summary>
          <div class="entry-body">
            <Markdown :source="f.repro" class="text" />
            <div v-if="f.fixedAt" class="fix"><span class="fix-ok">{{ fmtTime(f.fixedAt) }} 标为已改好</span><template v-if="f.fixedNote">：{{ f.fixedNote }}</template></div>
            <div v-if="f.stateReason" class="muted">你写的原因：{{ f.stateReason }}</div>
            <details v-if="f.revised" class="sub">
              <summary>重写过，看原来的写法</summary>
              <div class="muted">{{ kindWords[f.revised.kind] }} · {{ f.revised.title }}</div>
              <Markdown :source="f.revised.repro" class="text" />
            </details>
            <div v-if="f.trials.length" class="basis">
              <div class="muted">依据的试验</div>
              <div v-for="t in f.trials" :key="t.id" class="basis-row">
                <span class="dot" :class="`t-${trialTone(t)}`" />
                <span class="basis-what">{{ t.object }} <span class="muted">×</span> {{ t.check }}<span class="muted"> · {{ trialWord(t) }} · 第 {{ t.round }} 轮</span></span>
                <a v-if="t.runId" :href="`#/runs/${t.runId}`" class="muted">运行</a>
                <RunArtifacts v-if="t.artifacts.length" :items="t.artifacts" class="basis-files" />
              </div>
            </div>
            <div v-if="f.fix" class="fix">已有改动：{{ objectStatusWords(f.fix.status) }}<template v-if="f.fix.verified"> · <span :class="f.fix.verified === 'passed' ? 'fix-ok' : 'fix-bad'">{{ verifiedWords[f.fix.verified] }}</span></template> · <a :href="f.fix.link">看这次交办</a></div>
            <div v-if="editable && f.state !== 'duplicate'" class="row wrap">
              <template v-if="!f.fixedAt">
                <button v-if="f.state !== 'confirmed'" type="button" class="btn sm" :class="f.state === 'new' ? 'primary' : 'ghost'" :disabled="busy" @click="judge(f, 'confirmed')">认可</button>
                <button v-if="f.state !== 'rejected'" type="button" class="btn sm ghost" :disabled="busy" @click="judge(f, 'rejected')">不算</button>
                <button v-if="f.state === 'new'" type="button" class="btn sm ghost" :disabled="busy" @click="judge(f, 'later')">以后再说</button>
                <button v-if="data.scope?.allowCode && data.scope.repos.length && !f.fix && f.state !== 'rejected'" type="button" class="btn sm ghost" :disabled="busy" @click="fix(f)">去改…</button>
                <button v-if="f.state !== 'rejected'" type="button" class="btn sm ghost" :disabled="busy" @click="markFixed(f)">已改好…</button>
              </template>
              <button v-else type="button" class="btn sm ghost" :disabled="busy" @click="judge(f, 'confirmed')">没改好，重新打开</button>
              <button type="button" class="btn sm ghost" @click="discuss(f)">就这条问</button>
              <button type="button" class="btn sm ghost" title="让助手读依据的试验和代码，按条件 / 现象 / 为什么是问题 / 建议重写这条" @click="discuss(f, true)">看不懂，重写</button>
            </div>
          </div>
        </details>
        <button v-if="fixedCount" type="button" class="link small" @click="showFixed = !showFixed">{{ showFixed ? "收起已改好的" : `看已改好的 ${fixedCount} 条` }}</button>
      </div>

      <div v-else-if="tab === 'trials'" class="rows">
        <p v-if="!data.trials.length" class="muted small">还没有试验。方向确认以后，助手按计划一个一个去试，每个都照实记下结果。</p>
        <div v-else class="rows-head small muted">
          <span>{{ everyRound ? `各轮一共 ${data.trials.length} 个` : `第 ${round} 轮，${trials.length} 个` }}，没做好的排在前面</span>
          <button v-if="data.trials.length > trials.length || everyRound" type="button" class="link" @click="everyRound = !everyRound">{{ everyRound ? "只看这一轮" : `看各轮的（共 ${data.trials.length} 个）` }}</button>
        </div>
        <details v-for="t in trials" :id="`study-trial-${t.id}`" :key="t.id" class="entry">
          <summary>
            <span class="dot" :class="`t-${trialTone(t)}`" />
            <span class="entry-name">{{ t.object }} <span class="muted">×</span> {{ t.check }}</span>
            <span class="entry-meta muted">{{ trialMeta(t) }}</span>
          </summary>
          <div class="entry-body">
            <Markdown v-if="t.summary" :source="t.summary" class="text" />
            <div v-else class="muted">{{ t.state === "running" ? "正在跑。" : t.state === "queued" ? "还没轮到。" : "没有跑。" }}</div>
            <div v-if="t.prior" class="muted prior">{{ t.prior }}</div>
            <div v-if="t.findings.length" class="muted">它觉得可能是问题的：{{ t.findings.map((x) => `${kindWords[x.kind] ?? x.kind}「${x.title}」`).join("、") }}</div>
            <div v-if="t.env || shas(t)" class="muted">{{ [t.env ? `在哪跑：${t.env}` : "", t.peer ? `派给了设备 ${t.peer}${t.peerRunId ? `（那边的运行 ${t.peerRunId}）` : ""}` : "", shas(t) ? `提交 ${shas(t)}` : ""].filter(Boolean).join(" · ") }}</div>
            <div class="links">
              <template v-for="(r, i) in t.evidence.filter((x) => x.startsWith('src:'))" :key="r"><a href="#" :title="r" @click.prevent="refAction(r)?.()">原件 {{ i + 1 }}</a></template>
              <a v-if="t.runId" :href="`#/runs/${t.runId}`">看这次运行</a>
              <span class="muted">{{ fmtTime(t.updatedAt) }}</span>
            </div>
            <RunArtifacts v-if="t.artifacts.length" :items="t.artifacts" />
          </div>
        </details>
      </div>

      <div v-else-if="tab === 'directions'" class="rows">
        <p v-if="!data.directions.length" class="muted small">还没有方向。“定方向”那一段会对着功能清单提出这一轮往哪试，由你来选。</p>
        <div v-if="proposed.length" class="choose">
          <p>这一轮提了 {{ proposed.length }} 个方向，选一个{{ editable ? "" : "（由事项本人选）" }}：</p>
          <div v-if="editable" class="row wrap"><button type="button" class="btn sm ghost" :disabled="busy" @click="choose(null)">这一轮不跑</button></div>
        </div>
        <details v-for="d in directions" :id="`study-direction-${d.id}`" :key="d.id" class="entry" :open="d.state === 'proposed' && choosing || d.id === going?.id">
          <summary>
            <span class="state" :class="d.state">{{ directionWords[d.state] }}</span>
            <span class="entry-name">{{ d.goal }}</span>
            <span class="entry-meta muted">第 {{ d.round }} 轮 · {{ total(d) || d.plan.length }} 个试验</span>
          </summary>
          <div class="entry-body">
            <dl class="facts">
              <template v-if="d.approach"><dt>做法</dt><dd><Markdown :source="d.approach" class="text" /></dd></template>
              <template v-if="d.acceptance"><dt>验收</dt><dd><Markdown :source="d.acceptance" class="text" /></dd></template>
              <template v-if="d.env"><dt>在哪跑</dt><dd>{{ d.env }}</dd></template>
              <template v-if="d.estimate"><dt>预计花费</dt><dd>{{ d.estimate }}</dd></template>
              <template v-if="d.thirdParty"><dt>要留意</dt><dd>会执行第三方样本的安装或构建脚本</dd></template>
              <template v-if="d.allowCode && d.state !== 'proposed'"><dt>改代码</dt><dd>它的发现可以转成编码交办</dd></template>
              <template v-if="d.note"><dt>你的要求</dt><dd>{{ d.note }}</dd></template>
              <template v-if="d.conclusion"><dt>结论</dt><dd><Markdown :source="d.conclusion" class="text" /></dd></template>
            </dl>
            <details v-if="d.plan.length" class="sub">
              <summary>计划试的 {{ d.plan.length }} 个</summary>
              <ul><li v-for="(p, i) in d.plan" :key="i">{{ p.object }} <span class="muted">×</span> {{ p.check }}<span v-if="p.prior" class="muted prior">{{ p.prior }}</span></li></ul>
            </details>
            <details v-if="d.removed.length" class="sub">
              <summary>去掉了 {{ d.removed.length }} 个以前试过的</summary>
              <ul><li v-for="(p, i) in d.removed" :key="i">{{ p.object }} <span class="muted">×</span> {{ p.check }}<span class="muted prior">{{ p.prior }}</span></li></ul>
            </details>
            <div v-if="editable && d.state === 'proposed' && choosing" class="row wrap">
              <button type="button" class="btn sm primary" :disabled="busy" @click="choose(d)">就做这个</button>
              <UiCheckbox v-if="data.scope?.allowCode" :model-value="withCode[d.id] ?? true" size="sm" @change="(v: boolean) => (withCode[d.id] = v)">这个方向的发现可以改代码</UiCheckbox>
            </div>
            <div v-else-if="editable && (d.state === 'confirmed' || d.state === 'active')" class="row wrap">
              <button type="button" class="link" :disabled="busy" @click="close(d, 'done')">这个方向做完了…</button>
              <button type="button" class="link" :disabled="busy" @click="close(d, 'dropped')">放下不做了…</button>
            </div>
          </div>
        </details>
      </div>

      <div v-else class="rows">
        <p v-if="!data.coverage.ref" class="muted small">还没有功能清单。“梳理”那一段做完以后，这里按功能列出各试过几次、哪些还没碰过。</p>
        <template v-else>
          <div class="rows-head small muted">
            <span>{{ data.coverage.features.length }} 个功能里试过 {{ tried.length }} 个。按试验对象里出现功能名粗略统计。</span>
            <a href="#" @click.prevent="refAction(data.coverage.ref!)?.()">看功能清单</a>
          </div>
          <RankBars v-if="tried.length" :items="tried.map((f) => ({ label: f.title, value: f.trials }))" name="试过的次数" unit="次" :table="false" />
          <p v-if="untried.length" class="small untried"><span class="muted">还没试过的（{{ untried.length }}）</span>{{ untried.map((f) => f.title).join("、") }}</p>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.item-study { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
.study-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.study-name { font-size: 12.5px; font-weight: 600; color: var(--ink-2); }
.study-fresh { font-size: 12.5px; font-weight: 600; color: var(--warn); }
.error { color: var(--danger); margin: 0; }
/* What the study may touch: one line, opened to change it. */
.scope { font-size: 12.5px; }
.scope > summary { cursor: pointer; color: var(--ink-2); list-style: none; }
.scope > summary::-webkit-details-marker { display: none; }
.scope > summary .muted { margin-right: 8px; }
.scope > summary:hover { text-decoration: underline; }
.scope-body { display: grid; gap: 10px; padding: 10px 0 4px; }
.scope-body p { margin: 0; }
.scope-repos { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.fix { color: var(--ink-2); }
.fix-ok { color: var(--ok); }
.fix-bad { color: var(--danger); }
.push { display: grid; gap: 8px; }
.push-line { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; }
.push-line .field { flex: 1 1 140px; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.link { padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: 12.5px; }
.link:hover { color: var(--ink); text-decoration: underline; }
.link:disabled { cursor: default; opacity: 0.6; }

/* The direction in hand: its goal, then one thin bar of how its trials went (the flow strip's language). */
.going { display: grid; gap: 6px; }
.going-goal { display: flex; flex-wrap: wrap; gap: 0 8px; font-size: 13.5px; line-height: 1.5; }
.bar { display: flex; gap: 2px; height: 3px; }
.bar span { flex: 1 1 0; min-width: 3px; border-radius: 2px; background: var(--line-strong); transform-origin: left; animation: grow 0.5s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
@keyframes grow { from { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) { .bar span { animation: none; } }
.legend { display: flex; flex-wrap: wrap; gap: 2px 12px; color: var(--ink-2); }
.legend-item { display: inline-flex; align-items: center; gap: 5px; }
.legend-item i { width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); }
.bar .t-ok, .legend-item .t-ok, .dot.t-ok { background: var(--ok); }
.bar .t-bad, .legend-item .t-bad, .dot.t-bad { background: var(--danger); }
.bar .t-warn, .legend-item .t-warn, .dot.t-warn { background: var(--warn); }
.bar .t-run, .legend-item .t-run, .dot.t-run { background: var(--accent); }
.bar .t-skip, .legend-item .t-skip { background: var(--line); }

/* One line per finding, trial or direction; opened to read it. No boxes: hairlines between rows. */
.rows { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; min-width: 0; }
.rows > p { margin: 4px 0; }
.rows-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; padding-bottom: 4px; }
.entry { border-bottom: 1px solid var(--line); }
.entry > summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 7px 0; cursor: pointer; list-style: none; }
.entry > summary::-webkit-details-marker { display: none; }
.entry > summary:hover .entry-name { text-decoration: underline; }
.entry-name { flex: 1 1 12em; min-width: 0; }
.entry-meta { flex: 0 1 auto; font-size: 12px; }
.entry-meta.waiting { color: var(--warn); font-weight: 600; }
.entry-meta.fixed { color: var(--ok); }
.entry-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 0 0 12px 15px; font-size: 12.5px; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); transform: translateY(-1px); }
.kind, .state { flex: none; min-width: 2.4em; font-size: 12px; color: var(--muted); }
.kind.defect { color: var(--danger); }
.kind.gap { color: var(--warn); }
.kind.idea { color: var(--accent); }
.state.proposed { color: var(--warn); font-weight: 600; }
.state.confirmed, .state.active { color: var(--accent); }
.text { font-size: 12.5px; }
.text :deep(p) { margin: 0 0 4px; }
.text :deep(p:last-child) { margin-bottom: 0; }
.prior { display: block; white-space: pre-line; }
.links { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.basis { display: grid; gap: 4px; }
.basis-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.basis-what { flex: 1 1 12em; min-width: 0; }
.basis-files { flex: 1 1 100%; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 0; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; min-width: 0; }
.sub > summary { width: fit-content; cursor: pointer; color: var(--muted); }
.sub ul { margin: 6px 0 0; padding-left: 16px; display: grid; gap: 4px; }
.choose { display: grid; gap: 8px; padding: 10px 14px; margin-bottom: 4px; border-radius: var(--radius); background: var(--warn-soft); }
.choose p { margin: 0; font-size: 13.5px; }
.untried { margin: 6px 0 0; line-height: 1.7; }
.untried .muted { margin-right: 8px; }
</style>
