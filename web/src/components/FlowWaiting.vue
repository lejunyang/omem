<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, onServerEvent, onServerResync, post } from "../api";
import FlowStagePlugin from "./FlowStagePlugin.vue";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import RichText from "./RichText.vue";
import { readableIds } from "../lib/work";
import { nextWords, ownerTurn, stageActions, stageWords, type FlowAction, type FlowStage, type FlowView } from "../lib/flow";

/**
 * The stages of an item's flow waiting for the owner (their turn, a question, or stuck), answered in
 * place with a button, a sentence, or in a conversation. The flow page shows it on top; a run page
 * that belongs to the item shows it too, so what the flow waits for is answered where the work is
 * (a review's findings decided, then "做完了" on the flow's own step), whatever that step is.
 * Given `flow`, it shows that view; else it reads the item's flow itself and keeps it current.
 */
// `editable` defaults to true: Vue reads a boolean prop left out as false, which hid every button on run pages.
const props = withDefaults(defineProps<{ item: { id: string; title: string; spaceId: string }; flow?: FlowView | null; editable?: boolean; titled?: boolean }>(), { flow: undefined, editable: true });
const emit = defineEmits<{ changed: [view: FlowView | null] }>();
const router = useRouter();

const own = ref<FlowView | null>(null);
const view = computed(() => (props.flow !== undefined ? props.flow : own.value));
const busy = ref(false), error = ref("");
const replies = ref<Record<string, string>>({});
let seq = 0;
async function load() {
  if (props.flow !== undefined) return emit("changed", null);
  const n = ++seq;
  try {
    const v = await get<FlowView>(`/api/items/${props.item.id}/flow`);
    if (n === seq) own.value = v;
  } catch {
    if (n === seq) own.value = null;
  }
}
watch(() => props.item.id, () => { own.value = null; if (props.flow === undefined) void load(); }, { immediate: true });
const off = onServerEvent((e) => { if (props.flow === undefined && e.type === "changed" && e.entity === "item" && e.id === props.item.id) void load(); });
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++seq; off(); resync(); });

const may = computed(() => props.editable);
const waiting = computed(() => (view.value?.flow?.endedAt ? [] : ((view.value?.stages ?? []) as FlowStage[]).filter((s) => ownerTurn(s) || s.state === "blocked")));
const text = (s: FlowStage) => s.result || s.note;

/** Words without a button: what they do depends on what the stage is waiting for. */
function replyMeaning(s: FlowStage) {
  if (s.state === "blocked") return "按这句话重开这一段";
  if (s.question === "gate" || s.question === "when") return "按这句话开始";
  if (s.question === "done" || s.question === "refuse") return "按这句话重做";
  if (s.question === "skip") return "跳过，原因是这句";
  return "";
}
/** The stage's buttons, less "reopen": with a box for words, sending them is the reopen. */
const buttons = (s: FlowStage) => stageActions(s).filter((a) => !(a.action === "reopen" && replyMeaning(s)));
/** A box whenever words do something here: sent on their own, or carried by a button (a reason, or how the owner's own step went). */
const boxed = (s: FlowStage) => !!replyMeaning(s) || buttons(s).some((a) => a.reason) || s.state === "doing" && s.by === "owner";
function placeholder(s: FlowStage) {
  if (replyMeaning(s)) return `写一句话：${replyMeaning(s)}，或作为按钮的原因`;
  if (s.state === "doing" && s.by === "owner") return "怎么定的、结果在哪（可不写）；跳过要写原因";
  return "写一句原因，再点下面的按钮";
}
/** The stage's instruction can run to a paragraph: two lines, the rest on demand. */
const opened = ref<Record<string, boolean>>({});
async function act(s: FlowStage, a: FlowAction) {
  if (busy.value || !may.value) return;
  const note = replies.value[s.id]?.trim();
  if (a.reason && !note) { error.value = `「${a.label}」要写一句原因：写在下面的框里再点。`; return; }
  busy.value = true; error.value = "";
  try {
    const v = await post<FlowView>(`/api/items/${props.item.id}/flow/stages/${encodeURIComponent(s.id)}/${a.action}`, { note: note || undefined });
    replies.value[s.id] = "";
    if (props.flow === undefined) own.value = v;
    emit("changed", v);
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function reply(s: FlowStage) {
  const note = replies.value[s.id]?.trim();
  if (!note || busy.value || !may.value) return;
  busy.value = true; error.value = "";
  try {
    if (s.state === "blocked" || !s.askId) await post(`/api/items/${props.item.id}/flow/stages/${encodeURIComponent(s.id)}/reopen`, { note });
    else await post(`/api/asks/${encodeURIComponent(s.askId)}/answer`, { text: note });
    replies.value[s.id] = "";
    await load();
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
/** The blocked stage goes back to its assistant with the card's plan (and the owner's words, when written) — no card was sent for it. */
async function resume(s: FlowStage) {
  if (busy.value || !may.value) return;
  const plan = s.card?.sections.find((x) => x.label === "建议的做法")?.text;
  const note = [replies.value[s.id]?.trim(), "本人让助手接着做：先核对卡点现在的状态，再照建议的做法处理。", plan && `建议的做法：${plan}`].filter(Boolean).join("\n");
  busy.value = true; error.value = "";
  try {
    await post(`/api/items/${props.item.id}/flow/stages/${encodeURIComponent(s.id)}/reopen`, { note });
    replies.value[s.id] = "";
    await load();
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
/** A plugin's block answered (仍然通过 / 等处理) or the stage finished by hand. */
function pluginChanged(v: FlowView | null) {
  if (!v) return void load();
  if (props.flow === undefined) own.value = v;
  emit("changed", v);
}
/** Take the stage into a conversation: the assistant gets the item and stage to read, the owner writes the rest. */
function discuss(s: FlowStage) {
  if (s.card) return void router.push(s.card.discussUrl.slice(s.card.discussUrl.indexOf("#") + 1));
  const i = props.item;
  const said = text(s) ? `\n\n> ${text(s).slice(0, 600).replace(/\n+/g, "\n> ")}` : "";
  void router.push({ path: "/ask", query: { draft: `关于事项「${i.title}」（${i.id}）流程里的「${s.name}」（${stageWords[s.state]}）${said}\n\n`, space: i.spaceId } });
}

async function answer(s: FlowStage, choice?: number) {
  if (!s.card?.askId || busy.value || !may.value) return;
  busy.value = true; error.value = "";
  try {
    await post(`/api/asks/${encodeURIComponent(s.card.askId)}/answer`, { choice, text: replies.value[s.id]?.trim() || undefined });
    replies.value[s.id] = "";
    await load();
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
</script>

<template>
  <div v-if="waiting.length" class="flow-waiting">
    <p v-if="titled" class="small muted head">
      <router-link :to="`/items/${item.id}/flow`">事项「{{ item.title }}」的流程</router-link>在等你
    </p>
    <p v-if="error" class="error small" role="alert">{{ error }}</p>
    <section v-for="s in waiting" :key="`w-${s.id}`" class="turn" :aria-label="`等你：${s.name}`">
      <template v-if="s.card">
        <div class="turn-head"><Icon :name="s.state === 'blocked' ? 'alert' : 'check'" :size="16" /><strong>{{ s.card.title }}</strong></div>
        <router-link class="small" :to="s.card.flowUrl.slice(s.card.flowUrl.indexOf('#') + 1)">事项流程页：{{ s.card.itemTitle }}</router-link>
        <div v-for="section in s.card.sections" :key="section.label" class="words">
          <strong class="small">{{ section.label }}</strong>
          <Markdown :source="section.text" :space="item.spaceId" compact />
        </div>
        <template v-if="may && s.card.askId">
          <textarea v-if="!s.gateReview" v-model="replies[s.id]" class="textarea" rows="2" :aria-label="`给「${s.name}」写的话`" placeholder="写下你的指示，或给按钮补充说明" />
          <div class="row wrap">
            <button v-for="(option, index) in s.card.options" :key="option.choice" type="button" class="btn sm" :class="index === 0 ? 'primary' : 'ghost'" :disabled="busy" @click="answer(s, option.choice)">{{ option.label }}</button>
            <button v-if="s.card.textAction" type="button" class="btn sm" :disabled="busy || !replies[s.id]?.trim()" @click="answer(s)">{{ s.card.textAction }}</button>
            <span class="spacer" />
            <button type="button" class="btn ghost sm" @click="discuss(s)"><Icon name="chat" :size="14" />在对话里讨论</button>
          </div>
        </template>
        <template v-else-if="may && s.state === 'doing' && s.by === 'owner'">
          <textarea v-model="replies[s.id]" class="textarea" rows="2" :aria-label="`给「${s.name}」写的话`" :placeholder="placeholder(s)" />
          <div class="row wrap">
            <button v-for="(a, i) in buttons(s)" :key="a.label" type="button" class="btn sm" :class="i === 0 ? 'primary' : 'ghost'" :disabled="busy" @click="act(s, a)">{{ a.label }}</button>
            <button type="button" class="btn ghost sm" @click="discuss(s)"><Icon name="chat" :size="14" />在对话里讨论</button>
          </div>
        </template>
        <template v-else-if="may && !s.waitUntil">
          <textarea v-model="replies[s.id]" class="textarea" rows="2" :aria-label="`给「${s.name}」写的话`" placeholder="写下你希望这一段怎么处理" />
          <div class="row wrap">
            <button v-if="s.state === 'blocked' && s.carrier.kind === 'run'" type="button" class="btn primary sm" :disabled="busy" @click="resume(s)">让助手接着做</button>
            <button v-if="s.state === 'blocked'" type="button" class="btn sm" :disabled="busy || !replies[s.id]?.trim()" @click="act(s, { action: 'done', label: '标记阶段完成', reason: true })">标记阶段完成</button>
            <button type="button" class="btn sm" :disabled="busy || !replies[s.id]?.trim()" @click="reply(s)">按这句话处理</button>
            <button type="button" class="btn ghost sm" @click="discuss(s)"><Icon name="chat" :size="14" />在对话里讨论</button>
          </div>
        </template>
      </template>
      <template v-else>
      <div class="turn-head"><Icon :name="s.state === 'blocked' ? 'alert' : 'check'" :size="16" /><strong>{{ s.gateReview ? "被检查拦下" : s.state === "blocked" ? "卡住了" : "等你" }}：{{ s.name }}</strong></div>
      <div class="words">
        <RichText tag="p" class="small" :text="readableIds(nextWords(s))" :space="item.spaceId" :lines="opened[s.id] ? undefined : 2" />
        <button v-if="nextWords(s).length > 120" type="button" class="lnk small" :aria-expanded="!!opened[s.id]" @click="opened[s.id] = !opened[s.id]">{{ opened[s.id] ? "收起" : "展开" }}</button>
      </div>
      <FlowStagePlugin v-if="s.gateReview" :item-id="item.id" :stage="s" :editable="may" flat @changed="pluginChanged" />
      <Markdown v-else-if="s.state === 'blocked' && text(s)" :source="readableIds(text(s))" :space="item.spaceId" compact />
      <template v-if="may">
        <textarea v-if="boxed(s)" v-model="replies[s.id]" class="textarea" rows="2" :aria-label="`给「${s.name}」写的话`" :placeholder="placeholder(s)" />
        <div class="row wrap">
          <button v-for="(a, i) in buttons(s)" :key="a.label" type="button" class="btn sm" :class="i === 0 ? 'primary' : 'ghost'" :disabled="busy" @click="act(s, a)">{{ a.label }}</button>
          <button v-if="replyMeaning(s)" type="button" class="btn sm" :disabled="busy || !replies[s.id]?.trim()" @click="reply(s)">{{ replyMeaning(s) }}</button>
          <span class="spacer" />
          <button type="button" class="btn ghost sm" @click="discuss(s)"><Icon name="chat" :size="14" />在对话里讨论</button>
        </div>
      </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.flow-waiting { display: grid; gap: 10px; }
.head { margin: 0; }
.turn { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 8px; padding: 12px 14px; display: grid; gap: 8px; background: var(--warn-soft); min-width: 0; overflow-wrap: anywhere; }
.turn-head { display: flex; gap: 6px; align-items: center; }
.turn p { margin: 0; }
.words { display: grid; gap: 2px; justify-items: start; color: var(--ink-2); min-width: 0; }
.words :deep(code), .turn :deep(.prose code) { font-size: 12px; overflow-wrap: anywhere; word-break: break-all; }
.lnk { border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
.lnk:hover { text-decoration: underline; }
</style>
