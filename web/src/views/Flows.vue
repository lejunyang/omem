<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { del, get, post, put } from "../api";
import { confirmDialog } from "../lib/dialog";
import type { FlowFile } from "../lib/flow";
import RuleTabs from "../components/RuleTabs.vue";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";

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
  try { const result = await get<{ flows: FlowFile[] }>("/api/flows"); if (request === listSeq) { files.value = result.flows; error.value = ""; } }
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
async function open(file?: FlowFile) {
  if (busy.value || !await canLeave()) return;
  const next = file?.raw ?? template;
  if (next !== raw.value) reading.value = shown.value = null;
  selected.value = file?.id ?? null;
  original.value = file?.raw ?? "";
  raw.value = next;
  editing.value = true; error.value = "";
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
        <RuleTabs />
        <span class="spacer" />
        <button class="btn ghost sm icon" title="新建流程" aria-label="新建流程" :disabled="busy" @click="open()"><Icon name="plus" :size="15" /></button>
      </div>
      <div class="items">
        <Skeleton v-if="loading" :rows="4" />
        <template v-else>
          <div v-for="f in files" :key="f.id" class="li" :class="{ on: editing && selected === f.id }">
            <button class="grow pick" type="button" :disabled="busy" @click="open(f)">
              <div class="row"><strong class="ellipsis">{{ f.definition?.name ?? f.id }}</strong></div>
              <div v-if="f.definition?.description" class="muted small clamp">{{ f.definition.description }}</div>
              <div v-if="f.definition" class="muted small">{{ summary(f) }}</div>
              <div v-if="f.problem" class="err small clamp">这份定义读不了：{{ f.problem }}</div>
            </button>
          </div>
          <p v-if="!files.length && !error" class="muted small hint">还没有流程。点 ＋ 新建，或把你的做法讲给助理，它起草一份等你确认。</p>
          <p v-if="error && !editing" class="err small hint" role="alert">{{ error }} <button class="btn ghost sm" @click="load">重试</button></p>
        </template>
      </div>
    </aside>

    <main class="detail">
      <div v-if="!editing" class="empty">
        <Icon name="layers" :size="34" />
        <h3>流程</h3>
        <p>把一类事的做法写成几个阶段，事项就按它往前走：轮到谁就交给谁，要你拍板的地方停下来等你。阶段是一张清单，每段写明谁来做、做到什么算完，不用画图。</p>
        <p class="muted small">在事项页给一件事选一份流程就开始了。也可以直接对助理说“以后需求都这么走：先澄清，再编码，我推送以后……”，它起草好发给你确认。</p>
        <button class="btn" :disabled="busy" @click="open()"><Icon name="plus" :size="14" />新建流程</button>
      </div>

      <div v-else class="page">
        <header class="dh row">
          <strong class="title ellipsis">{{ title }}</strong>
          <span class="muted small" role="status">{{ status }}</span>
          <button class="btn primary sm" :disabled="!valid || !changed || busy" @click="save">保存</button>
          <button v-if="selected" class="btn sm danger" :disabled="busy" @click="remove">删除</button>
        </header>
        <p v-if="error" class="err small" role="alert">{{ error }}</p>

        <div class="panes">
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
                </div>
              </li>
            </ol>
            <p v-if="shown?.repeatDescription && !reading?.problem" class="small note">一轮一轮转：{{ shown.repeatDescription }}。</p>
            <p v-if="shown?.stages && !reading?.problem" class="muted small note">没有人参与的情况下连着自己开始了几段，下一段会先问你一声；这个数在 设置 → AI → 自动推进 里改。</p>
          </section>

          <section class="source">
            <label class="field"><span>定义（YAML）</span><textarea v-model="raw" class="textarea" spellcheck="false" rows="24" :disabled="busy" maxlength="60000" /></label>
            <details class="guide">
              <summary>每一段可以写什么</summary>
              <dl>
                <dt><code>by</code></dt>
                <dd>谁来做：<code>owner</code> 你来做；<code>wait</code> 只等进展；<code>{ run: {} }</code> 交给助手的一次运行（可写 <code>agent</code>、<code>skill</code>）；<code>{ object: code-work }</code> 或 <code>design</code> 跟着编码交办或方案走。</dd>
                <dt><code>gate</code></dt>
                <dd><code>confirm</code> 开始前先问你；不写就轮到自己开始。</dd>
                <dt><code>done</code></dt>
                <dd>做到什么算完：<code>confirm</code> 要你点头；<code>{ signal: git.pushed }</code> 改动推到远端就算（<code>git.merged</code> 是合进目标分支，只用在你来做或只等的阶段）；也可以写一句话；不写就按“谁来做”默认。</dd>
                <dt><code>needs</code></dt>
                <dd>要等哪些阶段做完，写它们的 id；不写就等上一段，<code>[]</code> 是不用等。</dd>
                <dt><code>when</code></dt>
                <dd>一句话，说明什么情况下才需要这一段；不符合时跳过。</dd>
                <dt><code>ai</code></dt>
                <dd>这一段的运行用哪一档模型：<code>strong</code> 好的、<code>standard</code> 中档、<code>cheap</code> 省的（各用哪个模型在 设置 → AI → 模型档位 里配）。加 <code>escalate: { to: strong, max: 2 }</code>，交不出结果或拿不准时换那一档重做，每轮最多 2 次。</dd>
                <dt><code>at</code>、<code>window</code></dt>
                <dd><code>at: "10:00"</code> 这一轮里不早于这个时刻开始；<code>window: "01:00-06:00"</code> 只在这个时间段里开始，可以跨午夜。</dd>
                <dt><code>budget</code></dt>
                <dd><code>{ minutes: 240 }</code> 这一段每轮最多跑这么久，到了就停下来等你。</dd>
                <dt><code>repeat</code></dt>
                <dd>写在最外层，不在某一段里：<code>{ from: 某一段的 id, every: manual }</code>。做完以后从那一段起可以再来一轮；<code>manual</code> 你点了才开始，<code>[tue, fri]</code> 每周二、周五，<code>day</code> 每天，<code>done</code> 做完接着来。</dd>
                <dt><code>note</code></dt>
                <dd>这一段要做什么，写给做的人看。</dd>
              </dl>
            </details>
          </section>
        </div>
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
.empty { max-width: 560px; margin: 50px auto; text-align: center; color: var(--ink-2); padding: 0 16px; display: grid; gap: 10px; justify-items: center; }
.empty h3, .empty p { margin: 0; }
.empty p { line-height: 1.7; }
.page { max-width: 1080px; padding: 16px 24px 40px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.dh { gap: 10px; flex-wrap: wrap; }
.title { flex: 1; min-width: 160px; font-size: 16px; font-weight: 600; }

.panes { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 28px; align-items: start; }
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
