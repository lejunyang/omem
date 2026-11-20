<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import { del, get, post, put } from "../api";
import { confirmDialog } from "../lib/dialog";
import type { FlowFile } from "../lib/flow";
import FlowTabs from "../components/FlowTabs.vue";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import { state, toast } from "../store";

/**
 * Flows (docs/v2/flows.md) are made by talking: the owner says how a kind of work goes, the assistant
 * asks what is unclear and drafts a definition (save_flow) the owner enables. This page starts that
 * conversation, lists drafts waiting for 启用, and shows each flow as stages; the YAML is there for
 * whoever wants to read or edit it, folded away.
 */
type Draft = { askId: string; conversationId: string | null; createdAt: string; id: string; name: string; description: string; stages: number; replaces: boolean };
const router = useRouter();
const drafts = ref<Draft[]>([]);
/** The YAML of the open flow, shown only when asked for (a new flow written by hand opens with it). */
const showSource = ref(false);
const describe = ref("");
const change = ref("");
const starting = ref(false);
const examples = [
  { label: "需求交付", text: "需求来了先由助手澄清范围、列出要确认的问题，我确认后交给编码 Agent 改，改完它自己跑测试并评审；我看过再推送，推送以后部署预发，由助手按验收点在预发上逐条验，结果给我签字。" },
  { label: "每周周报", text: "每周五下午，助手先把这周我参与的事项、提交和会议整理成周报草稿，我改完点头，它再发到团队群。" },
  { label: "线上问题排查", text: "有人报线上问题时，助手先查日志和最近的发布，给出可能的原因和证据；要改代码的话先问我，我同意后交办去修，修完我来确认关单。" },
];
/** What the assistant is asked: the owner's words, and how to go about it. */
function draftPrompt(words: string) {
  return `帮我建一个流程：\n\n${words.trim()}\n\n先弄清楚：分几段、每段做什么、谁来做（我自己、你的一次运行、交办编码、只是等别人）、哪一段开始前要先问我、每段做到什么算完、做完要不要一轮一轮重复。拿不准的先问我，问清楚了再用 save_flow 起草给我确认。`;
}
async function startConversation(text: string) {
  if (!text.trim() || starting.value) return;
  starting.value = true;
  try {
    const r = await post<{ conversationId: string }>("/api/ask", { text, space: state.space });
    await router.push(`/ask/${r.conversationId}`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    starting.value = false;
  }
}
async function changeWithAssistant() {
  if (!selected.value || !change.value.trim()) return;
  await startConversation(`我想改流程「${title.value}」（id: ${selected.value}）：\n\n${change.value.trim()}\n\n现在的定义：\n\n\`\`\`yaml\n${original.value}\n\`\`\`\n\n拿不准的先问我，改好后用 save_flow 起草新版本给我确认（id 保持 ${selected.value}）。`);
}
async function answerDraft(d: Draft, choice: 0 | 1) {
  try {
    await post(`/api/asks/${d.askId}/answer`, { choice });
    toast(choice === 0 ? `已启用「${d.name}」` : "已放弃这份草稿", "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

type Step = { id: string; name: string; carrier: string; gate: string; done: string; when: string; needs: string[]; ai?: string; time?: string; budget?: string };
type Reading = { ok: boolean; id?: string; name?: string; description?: string; problem?: string; stages?: Step[]; repeatDescription?: string };
const template = `# id 用小写字母、数字和连字符；保存后保持不变。
id: my-flow
name: 我的流程
description: 整理材料后由我确认。
stages:
  - id: collect
    name: 整理
    note: 核对事项材料，整理结论并附依据。
    by: { run: {} }
  - id: check
    name: 确认
    # 不填 needs 时，等待上一段完成。
    by: owner
    gate: confirm
`;
const files = ref<FlowFile[]>([]), loading = ref(true), error = ref(""), busy = ref(false);
const editing = ref(false), selected = ref<string | null>(null), raw = ref(""), original = ref("");
/** `reading` is the answer for the text as it is now; `shown` is the last one that parsed, kept on screen while the owner types. */
const reading = ref<Reading | null>(null), shown = ref<Reading | null>(null), validating = ref(false);
let validationSeq = 0, listSeq = 0, timer: ReturnType<typeof setTimeout> | undefined;
const changed = computed(() => raw.value !== original.value);
const renamed = computed(() => !!selected.value && !!reading.value?.ok && reading.value.id !== selected.value);
const valid = computed(() => !validating.value && !!reading.value?.ok && !renamed.value);
const title = computed(() => shown.value?.name ?? files.value.find((f) => f.id === selected.value)?.definition?.name ?? selected.value ?? "新流程");
const status = computed(() => validating.value ? "正在核对…" : !selected.value ? "还没保存" : changed.value ? "有没保存的修改" : "已保存");

async function load() {
  const request = ++listSeq;
  loading.value = true;
  try { const result = await get<{ flows: FlowFile[]; drafts?: Draft[] }>("/api/flows"); if (request === listSeq) { files.value = result.flows; drafts.value = result.drafts ?? []; error.value = ""; } }
  catch (e) { if (request === listSeq) error.value = (e as Error).message; }
  finally { if (request === listSeq) loading.value = false; }
}
watch(raw, () => {
  clearTimeout(timer);
  const request = ++validationSeq, yaml = raw.value;
  validating.value = true;
  timer = setTimeout(async () => {
    try { const result = await post<Reading>("/api/flows/validate", { yaml }); if (request === validationSeq) { reading.value = result; if (result.ok) shown.value = result; } }
    catch (e) { if (request === validationSeq) reading.value = { ok: false, problem: (e as Error).message }; }
    finally { if (request === validationSeq) validating.value = false; }
  }, 350);
});
/** Gates of the open definition the owner agreed to stop being asked at, by stage id. */
const grants = computed(() => new Map((files.value.find((f) => f.id === selected.value)?.grants ?? []).map((g) => [g.stage, g.grantedAt])));
async function askAgain(stage: Step) {
  if (!selected.value || busy.value) return;
  busy.value = true;
  try { await del(`/api/flows/${encodeURIComponent(selected.value)}/gates/${encodeURIComponent(stage.id)}`); await load(); }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
/** What a definition in the list comes to, in a few words. */
function summary(f: FlowFile) {
  const stages = f.definition?.stages ?? [];
  const yours = stages.filter((s) => s.by === "owner").length, asked = stages.filter((s) => s.gate === "confirm" && s.by !== "owner").length;
  return [`${stages.length} 段`, yours ? `${yours} 段你来做` : "", asked ? `${asked} 段开始前先问你` : ""].filter(Boolean).join(" · ");
}
/** The stages a step waits for, said only when it is not simply "the one before". */
function waits(s: Step, i: number) {
  const all = shown.value?.stages ?? [];
  if (!i || s.needs.length === 1 && s.needs[0] === all[i - 1]?.id) return "";
  return s.needs.length ? `等「${s.needs.map((id) => all.find((n) => n.id === id)?.name ?? id).join("」「")}」做完` : "不用等前面的阶段，可以同时进行";
}
const canLeave = () => !changed.value || confirmDialog("放弃没保存的修改", { message: "切换后，这次修改不会保存。", okText: "放弃修改", danger: true });
/** Open a flow, or (none given) a new one written by hand. */
async function open(file?: FlowFile) {
  if (busy.value || !await canLeave()) return;
  const next = file?.raw ?? template;
  if (next !== raw.value) reading.value = shown.value = null;
  selected.value = file?.id ?? null;
  original.value = file?.raw ?? "";
  raw.value = next;
  editing.value = true; error.value = ""; change.value = "";
  showSource.value = !file;
}
/** Back to starting a new flow with the assistant. */
async function startNew() {
  if (busy.value || !await canLeave()) return;
  editing.value = false; selected.value = null; original.value = raw.value = ""; reading.value = shown.value = null; error.value = "";
}
async function save() {
  if (!valid.value || !changed.value || busy.value) return;
  const id = reading.value!.id!, yaml = raw.value;
  if (!selected.value && files.value.some((f) => f.id === id)) { error.value = "这个 id 已经有一份流程在用：换一个 id，或在左边打开那一份来改。"; return; }
  busy.value = true;
  try { await put(`/api/flows/${encodeURIComponent(id)}`, { yaml }); selected.value = id; original.value = yaml; error.value = ""; await load(); }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function remove() {
  const id = selected.value;
  if (!id || busy.value || !await confirmDialog(`删除「${title.value}」`, { message: "已经按它在走的事项不受影响，各自带着开始时的那一份。删除后不能再用它开始新的。", danger: true, okText: "删除" })) return;
  busy.value = true;
  try { await del(`/api/flows/${encodeURIComponent(id)}`); editing.value = false; original.value = raw.value = ""; selected.value = null; await load(); }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
onMounted(load);
onBeforeRouteLeave(() => busy.value ? false : canLeave());
function beforeUnload(e: BeforeUnloadEvent) { if (changed.value) e.preventDefault(); }
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => { ++validationSeq; ++listSeq; clearTimeout(timer); window.removeEventListener("beforeunload", beforeUnload); });
</script>

<template>
  <div class="flows">
    <aside class="list-col">
      <div class="head row">
        <FlowTabs />
      </div>
      <div class="items">
        <Skeleton v-if="loading" :rows="4" />
        <template v-else>
          <button class="li new" :class="{ on: !editing }" type="button" :disabled="busy" @click="startNew"><Icon name="sparkles" :size="15" />和助理一起建一个流程</button>
          <template v-if="drafts.length">
            <div class="group">等你确认的草稿</div>
            <div v-for="d in drafts" :key="d.askId" class="li draft">
              <div class="grow">
                <div class="row"><strong class="ellipsis">{{ d.name }}</strong><span class="badge warn">草稿</span></div>
                <div class="muted small">{{ d.stages }} 段<template v-if="d.replaces"> · 会替换现有的同名流程</template></div>
                <div class="row draft-actions">
                  <button class="btn primary sm" type="button" @click="answerDraft(d, 0)">启用</button>
                  <button class="btn ghost sm" type="button" @click="answerDraft(d, 1)">不用</button>
                  <router-link v-if="d.conversationId" :to="`/ask/${d.conversationId}`" class="btn ghost sm">看对话</router-link>
                </div>
              </div>
            </div>
          </template>
          <div v-if="files.length" class="group">流程</div>
          <div v-for="f in files" :key="f.id" class="li" :class="{ on: editing && selected === f.id }">
            <button class="grow pick" type="button" :disabled="busy" @click="open(f)">
              <div class="row"><strong class="ellipsis">{{ f.definition?.name ?? f.id }}</strong></div>
              <div v-if="f.definition?.description" class="muted small clamp">{{ f.definition.description }}</div>
              <div v-if="f.definition" class="muted small">{{ summary(f) }}</div>
              <div v-if="f.problem" class="err small clamp">这份定义读不了：{{ f.problem }}</div>
            </button>
          </div>
          <p v-if="!files.length && !error" class="muted small hint">还没有流程。</p>
          <p v-if="error && !editing" class="err small hint" role="alert">{{ error }} <button class="btn ghost sm" @click="load">重试</button></p>
        </template>
      </div>
    </aside>

    <main class="detail">
      <div v-if="!editing" class="start">
        <h2>和助理一起定一个流程</h2>
        <p class="lead">流程是一类事的固定做法：分几段，轮到谁就交给谁，要你拍板的地方停下来等你。讲讲这类事你平时怎么做，助理会问清楚拿不准的地方，起草好发给你确认，你点“启用”才生效。</p>
        <ol class="asks-list">
          <li><strong>从哪开始</strong><span class="muted">什么时候用这个流程：来了一个需求、每周五、有人报问题……</span></li>
          <li><strong>分几步，每步做什么</strong><span class="muted">按顺序说就行，不用想格式。</span></li>
          <li><strong>每步谁来做</strong><span class="muted">你自己、助手跑一次、交给编码 Agent、还是只是等别人。</span></li>
          <li><strong>哪里要你拍板</strong><span class="muted">开始前要先问你的、做完要你点头的。</span></li>
          <li><strong>做到什么算完</strong><span class="muted">推到远端、合进主分支、你确认，或一句话说清楚。</span></li>
        </ol>
        <label class="field">
          <span>这类事怎么做</span>
          <textarea v-model="describe" class="textarea" rows="6" placeholder="例如：需求来了先由助手澄清范围，我确认后交给编码 Agent 改，改完自己跑测试；我看过再推送，推送以后部署预发并逐条验收，结果给我签字。" />
        </label>
        <div class="row wrap examples">
          <span class="muted small">照着改：</span>
          <button v-for="x in examples" :key="x.label" type="button" class="btn ghost sm" @click="describe = x.text">{{ x.label }}</button>
        </div>
        <div class="row wrap">
          <button class="btn primary" :disabled="!describe.trim() || starting" @click="startConversation(draftPrompt(describe))"><Icon name="chat" :size="15" />交给助理起草</button>
          <span class="muted small">会打开一段对话，助理问清楚后把草稿发给你；草稿也会出现在左边。</span>
        </div>
        <p class="muted small manual">熟悉定义格式的话，也可以<button type="button" class="link" :disabled="busy" @click="open()">自己写定义（YAML）</button>。</p>
      </div>

      <div v-else class="page">
        <header class="dh row">
          <strong class="title ellipsis">{{ title }}</strong>
          <span v-if="changed || !selected" class="muted small" role="status">{{ status }}</span>
          <button v-if="changed || !selected" class="btn primary sm" :disabled="!valid || !changed || busy" @click="save">保存</button>
          <button v-if="selected" class="btn ghost sm danger" :disabled="busy" @click="remove"><Icon name="trash" :size="14" />删除</button>
        </header>
        <p v-if="shown?.description" class="muted desc">{{ shown.description }}</p>
        <p v-if="error" class="err small" role="alert">{{ error }}</p>

        <div class="panes" :class="{ single: !showSource }">
          <section class="reading" aria-live="polite">
            <h3>它会怎么走</h3>
            <p v-if="reading?.problem" class="err small">{{ reading.problem }}</p>
            <p v-else-if="renamed" class="err small">改已有的流程时 id 要保持 {{ selected }}。要另存一份，点左上的 ＋ 新建。</p>
            <Skeleton v-if="!shown && validating" variant="text" :rows="5" />
            <ol v-else-if="shown?.stages" class="steps" :class="{ stale: !!reading?.problem || validating }">
              <li v-for="(s, i) in shown.stages" :key="s.id">
                <span class="step-no">{{ i + 1 }}</span>
                <div class="step">
                  <div class="step-head"><strong>{{ s.name }}</strong><span class="muted">{{ s.carrier }}</span></div>
                  <div class="muted">{{ s.gate }}，{{ s.done }}。</div>
                  <div v-if="s.when" class="muted">{{ s.when }}</div>
                  <div v-if="s.ai || s.time || s.budget" class="muted">{{ [s.ai, s.time, s.budget].filter(Boolean).join("；") }}</div>
                  <div v-if="waits(s, i)" class="muted">{{ waits(s, i) }}</div>
                  <div v-if="grants.has(s.id)" class="granted">你连着同意过，现在轮到它就直接开始。<button type="button" class="link" :disabled="busy" @click="askAgain(s)">改回每次问我</button></div>
                </div>
              </li>
            </ol>
            <p v-if="shown?.repeatDescription && !reading?.problem" class="small note">一轮一轮转：{{ shown.repeatDescription }}。</p>
            <p v-if="shown?.stages && !reading?.problem" class="muted small note">没有人参与的情况下连着自己开始了几段，下一段会先问你一声；这个数在 设置 → 推进工作 → 自动推进 里改。</p>
            <button v-if="!showSource" type="button" class="btn ghost sm source-toggle" @click="showSource = true"><Icon name="code" :size="14" />查看定义（YAML）</button>
          </section>

          <section v-if="showSource" class="source">
            <div class="row"><span class="muted small">定义（YAML）</span><span class="spacer" /><button v-if="selected" type="button" class="btn ghost sm" @click="showSource = false">收起</button></div>
            <label class="field"><span class="sr-only">定义（YAML）</span><textarea v-model="raw" class="textarea" spellcheck="false" rows="24" :disabled="busy" maxlength="60000" /></label>
            <details class="guide">
              <summary>每一段可以写什么</summary>
              <dl>
                <dt><code>by</code></dt>
                <dd>谁来做：<code>owner</code> 你来做；<code>wait</code> 只等进展；<code>{ run: {} }</code> 交给助手的一次运行（可写 <code>agent</code>、<code>skill</code>）；<code>{ object: code-work }</code> 或 <code>design</code> 跟着编码交办或方案走；装了插件以后还能跟着它的对象走，写 <code>{ object: "插件:类型" }</code>（比如 <code>"github:pull-request"</code>），在事项页的“外部状态”里挂上链接。</dd>
                <dt><code>gate</code></dt>
                <dd><code>confirm</code> 开始前先问你；不写就轮到自己开始。</dd>
                <dt><code>done</code></dt>
                <dd>做到什么算完：<code>confirm</code> 要你点头；<code>{ signal: git.pushed }</code> 改动推到远端就算（<code>git.merged</code> 是合进目标分支，只用在你来做或只等的阶段）；<code>{ object: "插件:类型", status: merged }</code> 是这件事挂着的那个外部对象到了这个状态就算；也可以写一句话；不写就按“谁来做”默认。</dd>
                <dt><code>needs</code></dt>
                <dd>要等哪些阶段做完，写它们的 id；不写就等上一段，<code>[]</code> 是不用等。</dd>
                <dt><code>when</code></dt>
                <dd>一句话，说明什么情况下才需要这一段；不符合时跳过。</dd>
                <dt><code>ai</code></dt>
                <dd>这一段的运行用哪一档模型：<code>strong</code> 好的、<code>standard</code> 中档、<code>cheap</code> 省的（各用哪个模型在 设置 → 后端与模型 → 默认 AI 与档位 里配）。加 <code>escalate: { to: strong, max: 2 }</code>，交不出结果或拿不准时换那一档重做，每轮最多 2 次。</dd>
                <dt><code>at</code>、<code>window</code></dt>
                <dd><code>at: "10:00"</code> 这一轮里不早于这个时刻开始；<code>window: "01:00-06:00"</code> 只在这个时间段里开始，可以跨午夜。</dd>
                <dt><code>budget</code></dt>
                <dd><code>{ minutes: 240 }</code> 这一段每轮最多跑这么久，到了就停下来等你。逐个去试的阶段还可以写 <code>trials: 8</code>，每轮最多试这么多个，没试完的留到下一轮。</dd>
                <dt>课题</dt>
                <dd>给一个项目找问题和改进点时用（内置的 <code>study</code> 是一份完整的例子）：定方向的阶段写 <code>tools: [propose_directions]</code>，提出的方向由你选；试验的阶段写 <code>by: { object: trials }</code>（可写 <code>agent</code>、<code>skill</code>），按选定的方向一个一个去试，每个记一条结果；小结的阶段写 <code>tools: [read_ledger, record_finding, close_direction]</code>，把试验归并成发现；再加一段 <code>by: { object: fixes }</code>（可写 <code>budget: { fixes: 2 }</code>），方向允许改代码时把这一轮新发现的缺陷逐条交办去改，改完重跑当初失败的试验。结果都在事项页的“课题的台账”里。</dd>
                <dt><code>repeat</code></dt>
                <dd>写在最外层，不在某一段里：<code>{ from: 某一段的 id, every: manual }</code>。做完以后从那一段起可以再来一轮；<code>manual</code> 你点了才开始，<code>[tue, fri]</code> 每周二、周五，<code>day</code> 每天，<code>done</code> 做完接着来。</dd>
                <dt><code>note</code></dt>
                <dd>这一段要做什么，写给做的人看。</dd>
              </dl>
            </details>
          </section>
        </div>

        <section v-if="selected" class="change">
          <label class="field">
            <span>想怎么改，跟助理说</span>
            <textarea v-model="change" class="textarea" rows="2" placeholder="例如：编码前加一段“出方案”，方案要我确认；预发验收改成每段都先问我。" />
          </label>
          <div class="row"><button class="btn sm" :disabled="!change.trim() || starting" @click="changeWithAssistant"><Icon name="chat" :size="14" />让助理改</button><span class="muted small">它起草新版本发给你确认，确认前现在这份照常用。</span></div>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* The same shape as the rules page: a list on the left, what is picked on the right. */
.flows { display: flex; height: 100%; overflow-wrap: anywhere; }
.list-col { width: 300px; flex: none; border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.head { padding: 12px; border-bottom: 1px solid var(--line); gap: 8px; }
.items { overflow-y: auto; padding: 6px; flex: 1; }
.hint { padding: 6px 10px; }
.li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 8px; }
.li:hover { background: var(--hover); }
.li.on { background: var(--accent-soft); }
.pick { border: 0; background: none; text-align: left; color: var(--ink); cursor: pointer; padding: 0; min-width: 0; font: inherit; display: grid; gap: 2px; }
.pick:disabled { cursor: default; }
.grow { flex: 1; min-width: 0; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.err { color: var(--danger); margin: 0; }

.detail { flex: 1; min-width: 0; overflow-y: auto; }
.page { max-width: 1080px; padding: 16px 24px 40px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.dh { gap: 10px; flex-wrap: wrap; }
.title { flex: 1; min-width: 160px; font-size: 16px; font-weight: 600; }

.panes { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 28px; align-items: start; }
.panes.single { grid-template-columns: minmax(0, 1fr); max-width: 680px; }
.source-toggle { justify-self: start; }
.desc { margin: -6px 0 0; line-height: 1.6; }
.change { display: grid; gap: 8px; max-width: 680px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
.change .row { gap: 10px; flex-wrap: wrap; }
.field { display: grid; gap: 6px; }
.field > span { font-size: 12.5px; color: var(--ink-2); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.li.new { width: 100%; border: 0; background: none; font: inherit; color: var(--ink); cursor: pointer; align-items: center; gap: 8px; font-weight: 550; }
.li.new:disabled { cursor: default; }
.group { font-size: 11px; color: var(--muted); padding: 12px 10px 4px; letter-spacing: 0.04em; }
.draft-actions { gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.start { max-width: 680px; margin: 36px auto; padding: 0 24px 40px; display: grid; gap: 16px; }
.start h2 { margin: 0; font-family: var(--serif); font-size: 24px; }
.start .lead { margin: 0; line-height: 1.75; color: var(--ink-2); }
.asks-list { margin: 0; padding: 0 0 0 20px; display: grid; gap: 6px; line-height: 1.6; font-size: 13.5px; }
.asks-list li { padding-left: 4px; }
.asks-list strong { margin-right: 8px; font-weight: 600; }
.examples { gap: 6px; }
.start .row { gap: 10px; }
.manual { margin: 0; }
.link { padding: 0; border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; }
.panes > * { min-width: 0; display: grid; gap: 10px; }
.reading h3 { margin: 0; font-size: 12.5px; font-weight: 400; color: var(--ink-2); }

/* The stages as a numbered list down a hairline: name and who does it, then how it starts and what ends it. */
.steps { margin: 0; padding: 0; list-style: none; display: grid; font-size: 13px; line-height: 1.6; }
.steps.stale { opacity: 0.55; }
.steps li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; position: relative; padding-bottom: 14px; }
.steps li:not(:last-child)::before { content: ""; position: absolute; left: 10.5px; top: 24px; bottom: 2px; width: 1px; background: var(--line); }
.steps li:last-child { padding-bottom: 0; }
.step-no { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line-strong); color: var(--ink-2); font-size: 11.5px; display: grid; place-items: center; font-variant-numeric: tabular-nums; }
.step { display: grid; gap: 1px; min-width: 0; }
.step-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.step .muted { font-size: 12.5px; }
.note { margin: 0; line-height: 1.6; }

.source .field > span { font-size: 12.5px; color: var(--ink-2); }
.source textarea { width: 100%; font-family: var(--mono); font-size: 12.5px; line-height: 1.6; tab-size: 2; white-space: pre-wrap; overflow-wrap: anywhere; resize: vertical; }
.granted { color: var(--ink-2); }
.granted .link { margin-left: 6px; padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; text-decoration: underline; }
.granted .link:hover { color: var(--ink); }
.guide { font-size: 12.5px; color: var(--ink-2); }
.guide summary { width: fit-content; cursor: pointer; color: var(--muted); }
.guide dl { margin: 8px 0 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; line-height: 1.6; }
.guide dd { margin: 0; }
.guide code { font-family: var(--mono); font-size: 12px; }

@media (max-width: 1180px) { .panes { grid-template-columns: minmax(0, 1fr); gap: 18px; } }
@media (max-width: 760px) {
  .flows { flex-direction: column; }
  .list-col { width: 100%; max-height: 36vh; border-right: 0; border-bottom: 1px solid var(--line); }
  .page { padding: 12px 16px 32px; }
}
</style>
