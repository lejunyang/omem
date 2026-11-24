<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { del, get, onServerEvent, onServerResync, post } from "../api";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { actorWords, aiName, changeChoices, changeHeads, changeStatus, changeWords, clockTime, evidenceLink, evidenceWord, minutesWords, nextWords, objectStatusWords, ownerTurn, reviewHow, reviewNotes, stageActions, stageColour, stageLine, stageWords, testSummary, testWords, verdictWords, type FlowAction, type FlowChange, type FlowDefinition, type FlowFile, type FlowStage, type FlowView, type StageTest } from "../lib/flow";
import FlowStagePlugin from "./FlowStagePlugin.vue";
import ItemStudy from "./ItemStudy.vue";
import PluginSlots from "./PluginSlots.vue";
import RankBars from "./charts/RankBars.vue";
import RunArtifacts from "./RunArtifacts.vue";
import { refAction } from "../lib/refs";
import { fmtTime, relTime } from "../store";
import Markdown from "./Markdown.vue";
import Skeleton from "./Skeleton.vue";
import UiSelect from "./UiSelect.vue";

/** `carrier`: whose item it is, when not the reader's (an observer, another member): their turn reads “等 小王”, and what only they decide is not shown. */
const props = withDefaults(defineProps<{ itemId: string; editable?: boolean; carrier?: string | null }>(), { editable: true, carrier: null });
const data = ref<FlowView | null>(null), error = ref(""), loading = ref(true), busy = ref(false);
const selected = ref(""), historyCount = ref(10), picking = ref(false), definitions = ref<FlowDefinition[]>([]), choice = ref("");
const pickerLoading = ref(false);
let seq = 0, pickerSeq = 0, epoch = 0;
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 60000);
const current = computed(() => data.value?.stages.find((s) => ownerTurn(s) || s.state === "blocked") ?? data.value?.stages.find((s) => ["doing", "stale", "pending"].includes(s.state)) ?? data.value?.stages.at(-1));
const stage = computed(() => data.value?.stages.find((s) => s.id === selected.value) ?? current.value);
const waiting = computed(() => data.value?.flow?.endedAt ? [] : data.value?.stages.filter((s) => ownerTurn(s) || s.state === "blocked") ?? []);
/** Changes the follow-up found that touch work already begun or done: the owner says what to do with each. */
const asked = computed(() => data.value?.flow?.endedAt ? [] : data.value?.changes?.filter((c) => c.status === "asked") ?? []);
const stageName = (id: string) => data.value?.stages.find((s) => s.id === id)?.name ?? id;
/** "编码（完成）、测试（进行中）": the stages a change touches, in the flow's order, with where each stands. */
const touched = (c: FlowChange) => (data.value?.stages ?? []).filter((s) => c.stages.includes(s.id)).map((s) => `${s.name}（${stageWords[s.state]}）`).join("、");
const reopens = (c: FlowChange) => data.value?.stages.find((s) => c.stages.includes(s.id))?.name;
/** The proposed time: a plain date stays as it was written, a moment is shown in the configured time zone. */
const dueWords = (c: FlowChange) => !c.due ? "另一个时间" : /^\d{4}-\d{2}-\d{2}$/.test(c.due) ? c.due : clockTime(c.due);
/** Where the flow keeps reading, said in one line; the new content waiting there is read together once it goes quiet. */
const following = computed(() => {
  const places = data.value?.flow?.endedAt ? [] : data.value?.follow ?? [];
  if (!places.length) return "";
  const names = places.slice(0, 3).map((p) => p.title || "未命名").join("、") + (places.length > 3 ? ` 等 ${places.length} 处` : "");
  const pending = places.reduce((n, p) => n + p.pending, 0);
  if (pending && data.value?.flow?.followCapped) return `在跟：${names}。今天已经读了不少批，还有 ${pending} 条新内容明天一起看。`;
  return `在跟：${names}。${pending ? `有 ${pending} 条新内容，等那边安静下来一起看。` : "有新结论会列在这里。"}`;
});
const completed = computed(() => !!data.value?.flow?.endedAt && data.value.stages.every((s) => ["done", "skipped"].includes(s.state)));
/** Stages still being done although a stage they build on was reopened: the owner says whether to stop them. */
const upstreamAsks = computed(() => data.value?.flow?.endedAt ? [] : data.value?.stages.filter((s) => s.state === "doing" && s.upstream) ?? []);
/** Once the flow ended: each stage's time, and how much of it waited on the owner, in hours when any stage took two or more. */
const review = computed(() => {
  const r = data.value?.review;
  if (!r) return null;
  const rows = r.stages.map((s) => ({ name: s.name, total: s.doingMinutes + s.gatedMinutes + s.blockedMinutes, owner: s.ownerMinutes })).filter((s) => s.total > 0);
  const hours = rows.some((s) => s.total >= 120), unit = (n: number) => hours ? Math.round(n / 6) / 10 : Math.round(n);
  return {
    line: [reviewHow[r.how], `用了 ${minutesWords(r.minutes)}`, r.rounds > 1 ? `${r.rounds} 轮` : "", r.reworks ? `你要求返工 ${r.reworks} 次` : "", r.longestOwnerWait ? `等你最久的是「${r.longestOwnerWait.name}」，${minutesWords(r.longestOwnerWait.minutes)}` : ""].filter(Boolean).join(" · "),
    labels: rows.map((s) => s.name), unit: hours ? "小时" : "分钟",
    series: [{ name: "用时", values: rows.map((s) => unit(s.total)) }, { name: "等你", values: rows.map((s) => unit(s.owner)) }],
    notes: reviewNotes(r).slice(0, 6),
  };
});
/** The owner answers the upstream card here: 0 stop the stage, 1 let it go on. */
async function answerUpstream(s: FlowStage, choice: 0 | 1) {
  if (!s.upstream || busy.value || !props.editable) return;
  const generation = epoch;
  busy.value = true; error.value = "";
  try { await post(`/api/asks/${encodeURIComponent(s.upstream.askId)}/answer`, { choice }); if (generation === epoch) await load(); }
  catch (e) { if (generation === epoch) error.value = (e as Error).message; }
  finally { if (generation === epoch) busy.value = false; }
}
async function load() {
  const request = ++seq, id = props.itemId;
  try { const result = await get<FlowView>(`/api/items/${id}/flow`); if (request === seq && id === props.itemId) { data.value = result; error.value = ""; } }
  catch (e) { if (request === seq) error.value = (e as Error).message; }
  finally { if (request === seq) loading.value = false; }
}
watch(() => props.itemId, () => { ++epoch; ++seq; ++pickerSeq; data.value = null; selected.value = ""; error.value = ""; busy.value = false; loading.value = true; picking.value = false; pickerLoading.value = false; definitions.value = []; historyCount.value = 10; void load(); }, { immediate: true });
const off = onServerEvent((e) => { if (e.type === "changed" && e.entity === "item" && e.id === props.itemId) void load(); });
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++epoch; ++seq; ++pickerSeq; off(); resync(); clearInterval(clock); });
async function mutate(id: string, path: string, payload?: unknown, remove = false) {
  if (id !== props.itemId || busy.value || !props.editable) return;
  const generation = epoch;
  busy.value = true; error.value = ""; ++seq;
  try { const result = remove ? await del<FlowView>(path) : await post<FlowView>(path, payload); if (generation === epoch) { ++seq; data.value = result; } }
  catch (e) { if (generation === epoch) error.value = (e as Error).message; }
  finally { if (generation === epoch) busy.value = false; }
}
async function start(def: FlowDefinition) {
  const id = props.itemId, generation = epoch;
  if (!await confirmDialog(`开始「${def.name}」`, { message: def.stages.map((s) => `${s.name}：${(s.note || (s.by === "owner" ? "由你完成" : s.by === "wait" ? "等待进展" : "由助理跟进")).replace(/[。！？\s]+$/, "")}。`).join("\n"), okText: "开始" })) return;
  if (generation === epoch) await mutate(id, `/api/items/${id}/flow`, { flow: def.id });
}
async function pick() {
  picking.value = !picking.value;
  if (!picking.value) return;
  const request = ++pickerSeq;
  pickerLoading.value = true;
  try {
    const result = await get<{ flows: FlowFile[] }>("/api/flows");
    if (request === pickerSeq) { definitions.value = result.flows.flatMap((f) => f.definition ? [f.definition] : []); choice.value = definitions.value[0]?.id ?? ""; }
  } catch (e) { if (request === pickerSeq) error.value = (e as Error).message; }
  finally { if (request === pickerSeq) pickerLoading.value = false; }
}
/** The owner starts the next round of a repeating flow. */
async function nextRound() {
  const id = props.itemId, generation = epoch;
  // A study's next round can be steered: what to look at, or what to leave alone, read by its planner.
  if (data.value?.flow?.study) {
    const answer = await promptDialog("再来一轮", { message: "定方向时会看到以前各轮的方向和发现，避开做过的。想让这一轮看什么、别碰什么，写在下面；不写就由它对着功能清单挑没碰过的。", fields: [{ id: "note", label: "这一轮看什么（可不填）", value: "", maxLength: 2000 }], okText: "开始" });
    if (!answer || generation !== epoch) return;
    return mutate(id, `/api/items/${id}/flow/round`, answer.note?.trim() ? { note: answer.note.trim() } : {});
  }
  await mutate(id, `/api/items/${id}/flow/round`, {});
}
/** The owner changes how long this stage may run in this round, and how often a stronger model may look. */
async function editBudget(s: FlowStage) {
  const id = props.itemId, generation = epoch;
  const answer = await promptDialog(`「${s.name}」这一轮的预算`, {
    message: "只改这件事上的这一份，不改流程定义。留空的不变。",
    fields: [
      { id: "minutes", label: "最多跑多少分钟", value: s.budget?.minutes != null ? String(s.budget.minutes) : "" },
      ...(s.escalate ? [{ id: "escalations", label: "拿不准时最多请更好的模型看几次", value: String(s.escalate.max) }] : []),
    ],
    okText: "保存",
  });
  if (!answer || generation !== epoch) return;
  const minutes = Number(answer.minutes), escalations = Number(answer.escalations);
  const patch = {
    ...(answer.minutes?.trim() && Number.isFinite(minutes) && minutes > 0 ? { budget: { ...(s.budget ?? {}), minutes: Math.round(minutes) } } : {}),
    ...(s.escalate && answer.escalations?.trim() && Number.isFinite(escalations) && escalations >= 0 ? { escalate: { max: Math.round(escalations) } } : {}),
  };
  if (Object.keys(patch).length) await mutate(id, `/api/items/${id}/flow/stages/${encodeURIComponent(s.id)}/budget`, patch);
}
async function act(s: FlowStage, a: FlowAction) {
  const id = props.itemId, generation = epoch;
  let note: string | undefined;
  if (a.reason) {
    const result = await promptDialog(a.label, { fields: [{ id: "note", label: "原因或完成说明", value: "", required: true, maxLength: 4000 }], okText: a.label });
    if (!result?.note.trim()) return;
    note = result.note.trim();
  }
  if (generation === epoch) await mutate(id, `/api/items/${id}/flow/stages/${s.id}/${a.action}`, { note });
}
/** The owner settles one change: fold it into this item (reopening the earliest stage it touches), make it an item of its own, or leave it. */
async function settle(c: FlowChange, choice: string) {
  const id = props.itemId;
  await mutate(id, `/api/items/${id}/flow/changes/${encodeURIComponent(c.id)}`, { choice });
}
/** The owner says a stage that has not begun was already done before the flow started, and what shows it. */
async function record(s: FlowStage) {
  const id = props.itemId, generation = epoch;
  const answer = await promptDialog(`「${s.name}」已经做过了`, { message: "记成做完，不再去做。写一句是怎么做的、结果在哪，以后翻这件事的经过时看得到。", fields: [{ id: "note", label: "当时是怎么做的", value: "", required: true, maxLength: 4000 }], okText: "记成做完" });
  if (!answer?.note.trim() || generation !== epoch) return;
  await mutate(id, `/api/items/${id}/flow/stages/${encodeURIComponent(s.id)}/record`, { note: answer.note.trim() });
}
/** The owner's word on one reported case: right, wrong (with what is wrong), or taken back. */
async function sign(s: FlowStage, t: StageTest, verdict: "ok" | "wrong" | null) {
  const id = props.itemId, generation = epoch;
  let note: string | undefined;
  if (verdict === "wrong") {
    const answer = await promptDialog("这条不对", { message: `${t.name}\n写下哪里不对。你对这一段点“还不行”时，标了不对的会一起带给下一次。`, fields: [{ id: "note", label: "哪里不对", value: t.verdictNote ?? "", required: true, maxLength: 2000 }], okText: "标成不对" });
    if (!answer?.note.trim() || generation !== epoch) return;
    note = answer.note.trim();
  }
  await mutate(id, `/api/items/${id}/flow/stages/${encodeURIComponent(s.id)}/tests/${encodeURIComponent(t.id)}`, { verdict, note });
}
async function stop() {
  const id = props.itemId, generation = epoch;
  if (await confirmDialog("停止流程", { message: "保留已有阶段与经过，撤回尚未回答的问题。事项仍由你决定是否关闭。", danger: true, okText: "停止" }) && generation === epoch) await mutate(id, `/api/items/${id}/flow`, undefined, true);
}
</script>

<template>
  <section class="item-flow" aria-label="事项流程" :aria-busy="busy">
    <Skeleton v-if="loading" variant="text" :rows="2" />
    <p v-if="error" class="error small" role="alert">{{ error }} <button class="btn ghost sm" :disabled="busy" @click="load">重试</button></p>
    <template v-if="data && !data.flow && editable">
      <div v-if="data.suits[0]" class="row wrap small muted">可以按流程推进：{{ data.suits[0].name }} <button class="btn ghost sm" :disabled="busy" @click="start(data.suits[0])">开始</button><button v-if="data.suits.length > 1" class="btn ghost sm" :aria-expanded="picking" @click="pick">其他流程…</button></div>
      <button v-if="!data.suits.length" class="btn ghost sm" :aria-expanded="picking" :disabled="busy" @click="pick">用流程推进…</button>
      <div v-if="picking" class="stack">
        <Skeleton v-if="pickerLoading" variant="text" :rows="2" />
        <template v-else><UiSelect v-model="choice" aria-label="选择流程" :options="definitions.map((d) => ({ value: d.id, label: d.name }))" /><button class="btn sm" :disabled="busy || !choice" @click="start(definitions.find((d) => d.id === choice)!)">开始</button><p v-if="!definitions.length" class="muted small">还没有可用的流程。<router-link to="/flows">编写流程</router-link></p></template>
      </div>
    </template>
    <template v-else-if="data?.flow">
      <div class="flow-head">
        <span class="flow-name">{{ data.flow.name }}</span>
        <span v-if="data.flow.id.startsWith('once-')" class="badge once" title="助手为这件事临时排的阶段清单，不是保存过的流程模板；完整走完后会问你要不要存成模板">一次性清单</span>
        <span v-if="data.flow.repeat" class="muted small">第 {{ data.flow.round ?? 1 }} 轮</span>
        <span v-if="data.flow.endedAt" class="muted small">{{ completed ? "走完了" : "已停止" }}</span>
        <span class="spacer" />
        <router-link :to="`/items/${itemId}/flow`" class="btn sm">打开流程页</router-link>
        <button v-if="editable && !data.flow.endedAt" type="button" class="link small" :disabled="busy" @click="stop">停止流程</button>
      </div>
      <div class="flow-strip" aria-label="阶段">
        <button v-for="s in data.stages" :key="s.id" type="button" class="segment" :class="[stageColour(s), { selected: stage?.id === s.id, skipped: s.state === 'skipped' }]" :aria-pressed="stage?.id === s.id" @click="selected = s.id">
          <span class="segment-bar" />
          <span class="segment-name">{{ s.name }}</span>
          <span class="segment-line">{{ stageLine(s, now, carrier) || "　" }}</span>
        </button>
      </div>
      <div v-if="data.flow.canStartRound" class="round-done">
        <p>第 {{ data.flow.round ?? 1 }} 轮做完了。{{ data.flow.nextRoundAt ? `下一轮 ${clockTime(data.flow.nextRoundAt)} 开始，也可以现在就开始。` : "下一轮等你开始。" }}</p>
        <div v-if="editable" class="row wrap"><button type="button" class="btn sm primary" :disabled="busy" @click="nextRound">再来一轮</button></div>
      </div>
      <div v-if="review" class="review">
        <div class="tests-head"><span>这一次走得怎样</span><span class="muted">{{ review.line }}</span></div>
        <RankBars v-if="review.labels.length" :labels="review.labels" :series="review.series" :unit="review.unit" note="用时算进行中、等你同意开始和卡住的时间；等你算等你同意开始、你自己做和等你确认结果的时间。" :table="false" />
        <ul v-if="review.notes.length" class="review-notes">
          <li v-for="n in review.notes" :key="n">{{ n }}</li>
        </ul>
      </div>
      <div v-for="s in carrier ? [] : upstreamAsks" :key="`up-${s.id}`" class="turn">
        <p><span class="turn-kind">上游重开了</span>「{{ s.upstream!.name }}」重开了，正在做的「{{ s.name }}」是按重开前的做的。要停下吗？</p>
        <p class="turn-note">原因：{{ s.upstream!.reason }}。停下就取消这一段正在做的（交办只停下、不丢弃），等「{{ s.upstream!.name }}」做完再重新做；不答的话它做完后也要再复核一次。</p>
        <div v-if="editable" class="row wrap"><button type="button" class="btn sm primary" :disabled="busy" @click="answerUpstream(s, 0)">停下</button><button type="button" class="btn sm ghost" :disabled="busy" @click="answerUpstream(s, 1)">继续做</button></div>
      </div>
      <div v-for="s in waiting" :key="s.id" class="turn" :class="{ theirs: !!carrier }">
        <p>{{ nextWords(s, carrier) }}</p>
        <FlowStagePlugin v-if="s.gateReview" :item-id="itemId" :stage="s" :editable="editable && !carrier" :who="carrier" flat @changed="(v) => (v ? (data = v) : load())" />
        <div v-if="editable" class="row wrap"><button v-for="(a, i) in stageActions(s)" :key="a.label" type="button" class="btn sm" :class="i === 0 ? 'primary' : 'ghost'" :disabled="busy" @click="act(s, a)">{{ a.label }}</button></div>
      </div>
      <div v-for="c in carrier ? [] : asked" :key="c.id" class="turn">
        <p><span class="turn-kind">{{ changeHeads[c.type] }}</span>{{ c.summary }}</p>
        <Markdown v-if="c.detail" :source="c.detail" class="stage-text" />
        <p class="turn-note">
          <template v-if="c.type === 'deadline'">提出改成 {{ dueWords(c) }}，还没有改；你定了才改这件事的截止时间。</template>
          <template v-else><template v-if="touched(c)">会影响：{{ touched(c) }}。</template><template v-if="reopens(c)">并进来就重开「{{ reopens(c) }}」，把这条带给它，它后面做完的阶段要再看一遍。</template></template>
          <span class="evidence turn-refs"><template v-for="(r, i) in c.refs" :key="r"><a v-if="refAction(r)" href="#" :title="r" @click.prevent="refAction(r)!()">原话 {{ i + 1 }}</a></template></span>
        </p>
        <div v-if="editable" class="row wrap"><button v-for="(a, i) in changeChoices(c)" :key="a.choice" type="button" class="btn sm" :class="i === 0 ? 'primary' : 'ghost'" :disabled="busy" @click="settle(c, a.choice)">{{ a.label }}</button></div>
      </div>
      <div v-if="stage" class="stage-detail">
        <div class="stage-title"><strong>{{ stage.name }}</strong><span class="muted">{{ stageWords[stage.state] }}{{ stage.recorded ? "（补录的）" : "" }}</span></div>
        <Markdown v-if="stage.instruction && !waiting.some((s) => s.id === stage!.id)" :source="stage.instruction" class="stage-text" />
        <dl class="stage-facts">
          <dt>谁来做</dt>
          <dd><a v-if="stage.carrier.link" :href="stage.carrier.link">{{ stage.carrier.label }}</a><span v-else>{{ stage.carrier.label }}</span></dd>
          <template v-if="stage.object">
            <dt>跟着</dt>
            <dd><a :href="stage.object.link" :target="stage.object.statusLabel ? '_blank' : undefined" rel="noopener noreferrer">{{ stage.object.title }}</a> <span class="badge" :title="stage.object.status">{{ stage.object.statusLabel ?? objectStatusWords(stage.object.status) }}</span><span v-if="stage.object.disabled" class="muted">（读它的插件停用了）</span><span v-if="stage.object.fields?.length" class="muted object-fields">{{ stage.object.fields.map((f) => `${f.label} ${f.value}`).join(" · ") }}</span></dd>
          </template>
          <template v-if="stage.links?.length">
            <dt>交给你看</dt>
            <dd class="evidence"><a v-for="l in stage.links" :key="l.url" :href="l.url" target="_blank" rel="noopener noreferrer" :title="l.url">{{ l.label }}</a></dd>
          </template>
          <template v-if="stage.evidence.length">
            <dt>依据</dt>
            <dd class="evidence"><template v-for="(r, i) in stage.evidence" :key="r"><a v-if="refAction(r)" href="#" :title="r" @click.prevent="refAction(r)!()">原件 {{ i + 1 }}</a><a v-else-if="evidenceLink(r)" :href="evidenceLink(r)!" :title="r">{{ evidenceWord(r) }} {{ i + 1 }}</a><span v-else class="muted" :title="r">{{ r.length > 24 ? `${r.slice(0, 22)}…` : r }}</span></template></dd>
          </template>
          <template v-if="stage.descriptions?.ai">
            <dt>模型</dt>
            <dd>{{ stage.descriptions.ai }}<span v-if="stage.actualAI" class="muted">（这次用的是 {{ aiName(stage.actualAI) }}）</span></dd>
          </template>
          <template v-if="stage.descriptions?.time || (stage.waitUntil && stage.state === 'pending')">
            <dt>时间</dt>
            <dd>{{ stage.descriptions?.time }}<span v-if="stage.waitUntil && stage.state === 'pending'" class="muted">{{ stage.descriptions?.time ? "；" : "" }}等到 {{ clockTime(stage.waitUntil) }} 再开始</span></dd>
          </template>
          <template v-if="stage.budget?.minutes != null || stage.escalate">
            <dt>预算</dt>
            <dd>
              <template v-if="stage.budget?.minutes != null">已用 {{ Math.round(stage.usedMinutes ?? 0) }} / {{ stage.budget.minutes }} 分钟</template>
              <template v-if="stage.escalate">{{ stage.budget?.minutes != null ? "；" : "" }}请更好的模型看过 {{ stage.escalations ?? 0 }} / {{ stage.escalate.max }} 次</template>
              <button v-if="editable && !data.flow.endedAt" type="button" class="link small budget-edit" :disabled="busy" @click="editBudget(stage)">改</button>
            </dd>
          </template>
          <template v-if="stage.waitingSignal && !stage.waitingSignal.type.includes(':')">
            <dt>在等</dt>
            <dd>{{ stage.waitingSignal.note }}<span v-if="stage.waitingSignal.checkedAt" class="muted">（{{ relTime(stage.waitingSignal.checkedAt) }}看的）</span></dd>
          </template>
          <template v-if="stage.note">
            <dt>最近</dt>
            <dd><Markdown :source="stage.note" class="stage-text" /></dd>
          </template>
        </dl>
        <FlowStagePlugin v-if="!(stage.gateReview && waiting.some((s) => s.id === stage!.id))" :item-id="itemId" :stage="stage" :editable="editable && !carrier" :who="carrier" @changed="(v) => (v ? (data = v) : load())" />
        <div v-if="stage.shots?.length" class="stage-shots">
          <div class="tests-head"><span>截图</span><span class="muted">{{ stage.shots.length }} 张</span></div>
          <RunArtifacts :items="stage.shots" />
        </div>
        <div v-if="stage.tests?.length" class="stage-tests">
          <div class="tests-head"><span>逐条的结果</span><span class="muted">{{ testSummary(stage.tests) }}</span></div>
          <details v-for="t in stage.tests" :key="t.id" class="test" :open="t.status === 'failed'">
            <summary>
              <span class="test-dot" :class="t.status" />
              <span class="test-name">{{ t.name }}</span>
              <span class="muted test-meta">{{ testWords[t.status] }}{{ t.mode ? ` · ${t.mode}` : "" }}{{ t.artifacts.length ? ` · ${t.artifacts.length} 份截图或录屏` : "" }}</span>
              <span v-if="t.verdict" class="test-meta test-verdict" :class="t.verdict">{{ verdictWords[t.verdict] }}</span>
            </summary>
            <div class="test-body">
              <div v-if="t.req" class="muted">需求点：<a :href="`#/code/reqs/${t.req.id}`">{{ t.req.title }}</a></div>
              <Markdown v-if="t.note" :source="t.note" class="stage-text" />
              <RunArtifacts v-if="t.artifacts.length" :items="t.artifacts" />
              <div v-else class="muted">这一条没有交截图或录屏。</div>
              <div v-if="t.verdict === 'wrong' && t.verdictNote" class="verdict-note">你写的：{{ t.verdictNote }}</div>
              <div v-if="editable && !data.flow.endedAt" class="row wrap">
                <button v-if="t.verdict !== 'ok'" type="button" class="btn sm ghost" :disabled="busy" @click="sign(stage, t, 'ok')">看过，对</button>
                <button v-if="t.verdict !== 'wrong'" type="button" class="btn sm ghost" :disabled="busy" @click="sign(stage, t, 'wrong')">不对…</button>
                <button v-if="t.verdict" type="button" class="link small" :disabled="busy" @click="sign(stage, t, null)">撤销</button>
              </div>
            </div>
          </details>
        </div>
        <button v-if="editable && ['done', 'skipped', 'stale'].includes(stage.state)" type="button" class="link small" :disabled="busy" @click="act(stage, { action: 'reopen', label: '重开这一段', reason: true })">重开这一段</button>
        <button v-if="editable && !data.flow.endedAt && ['pending', 'gated'].includes(stage.state)" type="button" class="link small" :disabled="busy" @click="record(stage)">这一段已经做过了…</button>
        <button v-if="editable && !data.flow.endedAt && stage.state === 'doing' && stage.autoStarted" type="button" class="link small" :disabled="busy" @click="act(stage, { action: 'hold', label: '先停下' })">它是直接开始的：先停下，以后轮到这一段还是先问我</button>
        <PluginSlots at="flow.stage" :item-id="itemId" :stage="stage.id" />
      </div>
      <ItemStudy v-if="data.flow.study" :item-id="itemId" :editable="editable" :choosing="!data.flow.endedAt && data.stages.some((s) => s.asking === 'direction')" />
      <div v-if="data.changes?.length || following" class="changes">
        <div v-if="data.changes?.length" class="tests-head"><span>这件事的变化</span><span class="muted">群里、会话里和文档里新说的</span></div>
        <details v-for="c in data.changes ?? []" :key="c.id" class="test">
          <summary>
            <span class="change-kind" :class="c.type">{{ changeWords[c.type] }}</span>
            <span class="test-name">{{ c.summary }}</span>
            <span class="test-meta" :class="c.status === 'asked' ? 'change-waiting' : 'muted'">{{ changeStatus(c) }} · {{ relTime(c.at) }}</span>
          </summary>
          <div class="test-body">
            <Markdown v-if="c.detail" :source="c.detail" class="stage-text" />
            <div v-if="c.type === 'deadline' && c.due" class="muted">{{ c.status === "merged" ? "截止时间改成了" : "提出改成" }} {{ dueWords(c) }}</div>
            <div v-if="c.stages.length" class="muted">影响：{{ c.stages.map(stageName).join("、") }}</div>
            <div v-if="c.req" class="muted">需求点：<a :href="`#/code/reqs/${c.req}`">打开</a></div>
            <div class="evidence">
              <template v-for="(r, i) in c.refs" :key="r"><a v-if="refAction(r)" href="#" :title="r" @click.prevent="refAction(r)!()">原话 {{ i + 1 }}</a></template>
              <a :href="`#/runs/${c.runId}`" class="muted">看这次是怎么读的</a>
            </div>
          </div>
        </details>
        <p v-if="following" class="muted small following">{{ following }}</p>
      </div>
      <details v-if="data.rounds?.length" class="history">
        <summary>以前各轮</summary>
        <ol>
          <li v-for="r in data.rounds" :key="r.round">
            <span class="history-what">第 {{ r.round }} 轮</span>
            <span class="muted">{{ fmtTime(r.endedAt) }} 做完</span>
            <span v-for="s in r.stages.filter((x) => x.note || x.state !== 'done')" :key="s.id" class="muted round-line">{{ data.stages.find((x) => x.id === s.id)?.name ?? s.id }}：{{ stageWords[s.state] }}{{ s.note ? `，${s.note}` : "" }}</span>
          </li>
        </ol>
      </details>
      <details v-if="data.log.length" class="history">
        <summary>经过</summary>
        <ol>
          <li v-for="l in data.log.slice(0, historyCount)" :key="l.id">
            <span class="history-what">{{ data.stages.find((s) => s.id === l.stageId)?.name ?? l.stageId }}：{{ stageWords[l.toState] }}</span>
            <span class="muted">{{ fmtTime(l.at) }} · {{ actorWords(l.actor) }}</span>
            <Markdown v-if="l.note" :source="l.note" class="stage-text muted" />
          </li>
        </ol>
        <button v-if="historyCount < data.log.length" type="button" class="link small" @click="historyCount += 10">再看十条</button>
      </details>
    </template>
  </section>
</template>

<style scoped>
.item-flow { display: grid; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.flow-head { display: flex; align-items: baseline; gap: 8px; }
.flow-name { font-size: 12.5px; font-weight: 600; color: var(--ink-2); }
.once { font-size: 11.5px; }
.link { padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: 12.5px; }
.link:hover { color: var(--ink); text-decoration: underline; }
.link:disabled { cursor: default; opacity: 0.6; }

/* A row of thin bars, one per stage: no boxes. Four colours only; skipped and stale are said in words. */
.flow-strip { display: flex; flex-wrap: wrap; gap: 4px 6px; }
.segment { flex: 1 1 56px; min-width: 0; display: flex; flex-direction: column; gap: 3px; padding: 0 0 4px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: var(--radius-sm); }
.segment-bar { display: block; height: 3px; border-radius: 2px; background: var(--line-strong); }
.segment.ok .segment-bar { background: var(--ok); }
.segment.accent .segment-bar { background: var(--accent); }
.segment.warn .segment-bar { background: var(--warn); }
.segment.skipped .segment-bar { background: var(--line); }
.segment-name { margin-top: 2px; font-size: 13px; line-height: 1.3; color: var(--muted); }
.segment.ok .segment-name, .segment.accent .segment-name { color: var(--ink); }
.segment.warn .segment-name { color: var(--warn); font-weight: 600; }
.segment.selected .segment-name { font-weight: 600; color: var(--ink); }
.segment.warn.selected .segment-name { color: var(--warn); }
.segment-line { font-size: 11.5px; line-height: 1.3; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The stage in hand gets the room its line needs. */
.segment.warn, .segment.accent { flex: 1.7 1 84px; }
.segment.warn .segment-line { color: var(--warn); }
.segment:hover .segment-name { text-decoration: underline; }

/* Between two rounds: nothing is waiting, so it is calm; one button starts the next. */
.round-done { display: grid; gap: 10px; padding: 12px 14px; border-radius: var(--radius); background: var(--sunken); }
.round-done p { margin: 0; font-size: 13.5px; line-height: 1.6; }
.budget-edit { margin-left: 8px; }
.round-line { overflow-wrap: anywhere; }

/* What waits for the owner: said once, with the buttons that state allows. */
.turn { display: grid; gap: 10px; padding: 12px 14px; border-radius: var(--radius); background: var(--warn-soft); }
/* Someone else's turn: said, not asked of the reader. */
.turn.theirs { background: var(--sunken); }
.turn p { margin: 0; font-size: 13.5px; line-height: 1.6; }

.turn-kind { margin-right: 8px; font-weight: 600; color: var(--warn); }
.turn .turn-note { font-size: 12.5px; color: var(--ink-2); }
.turn-refs { display: inline-flex; margin-left: 4px; }

/* After the flow ended: where the time went, then the few lines worth reading. */
.review { display: grid; gap: 8px; font-size: 13px; }
.review-notes { margin: 0; padding: 0 0 0 1.1em; display: grid; gap: 2px; font-size: 12.5px; color: var(--ink-2); }

/* What the item's chats and documents said since the flow began: one line each, newest first. */
.changes { display: grid; gap: 2px; font-size: 13px; }
.change-kind { flex: none; min-width: 2.4em; font-size: 12px; color: var(--muted); }
.change-kind.scope, .change-kind.blocker { color: var(--warn); }
.change-kind.decision, .change-kind.deadline { color: var(--accent); }
.change-waiting { color: var(--warn); font-weight: 600; }
.following { margin: 6px 0 0; }

.stage-detail { display: grid; gap: 6px; font-size: 13px; }
.stage-detail > .link { justify-self: start; text-align: left; }
.stage-title { display: flex; align-items: baseline; gap: 8px; }
.stage-title .muted { font-size: 12.5px; }
.stage-text { font-size: 13px; }
.stage-text :deep(p) { margin: 0; }
.stage-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 0; }
.stage-facts dt { color: var(--muted); }
.stage-facts dd { margin: 0; min-width: 0; }
.evidence { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.object-fields { display: block; font-size: 12.5px; }

/* A verification stage's cases: one line each, opened to see what was done and the screenshots or recordings. */
.stage-tests { display: grid; gap: 2px; margin-top: 4px; }
.stage-shots { display: grid; gap: 4px; margin-top: 4px; }
.tests-head { display: flex; align-items: baseline; gap: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--ink-2); }
/* The summary line wraps under the title in a narrow drawer instead of squeezing it. */
.review .tests-head { flex-wrap: wrap; row-gap: 2px; }
.review .tests-head > span:first-child { flex: none; }
.test { border-bottom: 1px solid var(--line); }
.test summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 6px 0; cursor: pointer; list-style: none; }
.test summary::-webkit-details-marker { display: none; }
.test-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); transform: translateY(-1px); }
.test-dot.passed { background: var(--ok); }
.test-dot.failed { background: var(--danger); }
.test-name { flex: 1 1 10em; min-width: 0; }
.test-meta { flex: 0 1 auto; font-size: 12px; }
.test summary:hover .test-name { text-decoration: underline; }
.test-verdict.ok { color: var(--ok); }
.test-verdict.wrong { color: var(--danger); font-weight: 600; }
.verdict-note { color: var(--danger); }
.test-body { display: grid; gap: 6px; padding: 0 0 10px 15px; font-size: 12.5px; }

.history { font-size: 12.5px; }
.history summary { width: fit-content; cursor: pointer; color: var(--muted); }
.history ol { margin: 8px 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.history li { display: grid; gap: 1px; padding-left: 10px; border-left: 2px solid var(--line); }
.history-what { color: var(--ink-2); }
.error { color: var(--danger); margin: 0; }
</style>
