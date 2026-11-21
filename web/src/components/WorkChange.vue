<script setup lang="ts">
import { computed, ref } from "vue";
import { put } from "../api";
import Markdown from "./Markdown.vue";
import { state, toast } from "../store";
import { ownerCalled } from "../lib/owner-name";
import { changeTone, changeTypeLabel, clock, originText, refsMarkdown, sourceLabel, type ChangeLite } from "../lib/work";

/**
 * One key change as a card in a list (按时间, a line's timeline): the change in a sentence with its
 * kind, when and on which line, its risk and next step, the sources, and 对我没用. The title opens
 * the whole change on the side.
 */
/** `readonly`: someone else reading the owner's line: no 对我没用. */
const props = defineProps<{ change: ChangeLite; line?: boolean; lineId?: string; readonly?: boolean }>();
const emit = defineEmits<{ open: [c: ChangeLite]; changed: [] }>();
const c = computed(() => props.change);
/** Reading the owner's line, “你定的” is the owner's: named. */
const by = computed(() => (props.readonly ? ownerCalled(state.me) : undefined));
const cited = computed(() => refsMarkdown(c.value.refs));
const busy = ref(false);
async function noise() {
  busy.value = true;
  try {
    await put(`/api/item-changes/${c.value.id}/noise`, { noise: !c.value.noise });
    toast(c.value.noise ? "已放回时间线" : "已从时间线拿掉，以后少记这类", "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
/** Where it happened: the line, and the work item under it when that is another one. */
const where = computed(() => [props.line ? c.value.lineTitle : "", c.value.itemId !== (props.lineId ?? c.value.lineId) ? c.value.itemTitle : ""].filter(Boolean).join(" · "));

/**
 * Who noted it (src/items/changes.ts): a quiet mark after the origin when someone added to it later or
 * other paths stepped aside on its message; the details (who first, who added what, the source, who
 * stepped aside and why) in a small layer on hover, focus or click. Esc closes it and keeps the focus.
 */
const FIELD: Record<string, string> = { summary: "说法", detail: "经过", risk: "风险", next: "下一步", due: "日期", req: "需求点", stages: "影响的阶段", refs: "引用" };
const added = computed(() => c.value.added ?? []);
const yields = computed(() => c.value.yields ?? []);
const mark = computed(() => [added.value.length ? `${added.value.length} 处补充` : "", yields.value.length ? `${yields.value.length} 处让开` : ""].filter(Boolean).join(" · "));
const whoLines = computed(() => [
  `最先记下：${originText(c.value.origin, by.value)}${sourceLabel(c.value.sourceKey) ? `，来自${sourceLabel(c.value.sourceKey)}` : ""}`,
  ...added.value.map((a) => `${clock(a.at)} ${originText(a.origin, by.value)}补了${a.fields.map((f) => FIELD[f] ?? f).join("、")}`),
  ...yields.value.map((y) => `${y.label}让开了：${y.reason || `${y.to}已经在处理`}`),
]);
const hover = ref(false);
const pinned = ref(false);
const trigger = ref<HTMLButtonElement>();
function closeWho() {
  if (!hover.value && !pinned.value) return;
  hover.value = false;
  pinned.value = false;
  trigger.value?.focus();
}
</script>

<template>
  <article class="change" :class="[changeTone(c.type), { noise: c.noise }]">
    <header>
      <span class="dot" aria-hidden="true" />
      <button type="button" class="title" @click="emit('open', c)">{{ c.summary }}</button>
      <button v-if="!readonly" type="button" class="lnk small muted no-use" :disabled="busy" @click="noise">{{ c.noise ? "放回" : "对我没用" }}</button>
    </header>
    <p class="meta small">
      <span class="tag">{{ changeTypeLabel[c.type] ?? c.type }}</span>
      <span>{{ clock(c.at) }}</span>
      <span v-if="c.origin">{{ originText(c.origin, by) }}</span>
      <span v-if="mark" class="who" @keydown.esc.stop="closeWho">
        <button ref="trigger" type="button" class="who-btn" :aria-expanded="hover || pinned" aria-label="谁记的、谁补的、谁让开了" @mouseenter="hover = true" @mouseleave="hover = false" @focus="hover = true" @blur="hover = false" @click.stop="pinned = !pinned">{{ mark }}</button>
        <span v-if="hover || pinned" class="who-pop" role="tooltip" @mouseenter="hover = true" @mouseleave="hover = false">
          <span v-for="(l, i) in whoLines" :key="i" class="who-line">{{ l }}</span>
        </span>
      </span>
      <router-link v-if="where" :to="`/work/${c.itemId !== (lineId ?? c.lineId) ? c.itemId : c.lineId}`" class="where">{{ where }}</router-link>
      <span v-if="c.status === 'asked'" class="asked">等你定</span>
    </p>
    <dl v-if="c.risk || c.next" class="lines small">
      <template v-if="c.risk"><dt>风险</dt><dd class="risk">{{ c.risk }}</dd></template>
      <template v-if="c.next"><dt>下一步</dt><dd>{{ c.next }}</dd></template>
    </dl>
    <Markdown v-if="cited" :source="cited" class="prose refs" />
  </article>
</template>

<style scoped>
.change { display: grid; gap: 4px; padding: 12px 14px 12px 16px; border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line); min-width: 0; }
.change.noise { opacity: 0.6; }
header { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.dot { width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--muted); flex: none; transform: translateY(1px); }
.warn .dot { border-color: var(--warn); }
.accent .dot { border-color: var(--accent); }
.ok .dot { border-color: var(--ok); }
.title { all: unset; cursor: pointer; flex: 1; min-width: 0; font-size: 14.5px; font-weight: 600; line-height: 1.5; color: var(--ink); overflow-wrap: anywhere; }
.title:hover { text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.no-use { flex: none; }
.meta { display: flex; flex-wrap: wrap; gap: 2px 10px; margin: 0 0 0 17px; color: var(--muted); }
.tag { font-weight: 600; letter-spacing: 0.04em; }
.warn .tag { color: var(--warn); }
.accent .tag { color: var(--accent); }
.ok .tag { color: var(--ok); }
.where { color: var(--muted); overflow-wrap: anywhere; }
.asked { color: var(--warn); }
.change { position: relative; }
.who { min-width: 0; }
.who-btn { all: unset; cursor: pointer; color: var(--muted); font-size: 12px; text-decoration: underline dotted; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.who-btn:hover, .who-btn[aria-expanded="true"] { color: var(--ink-2); }
.who-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
/* Held inside the card (left of the card, under the line it opens from): never wider than the card, so no sideways overflow. */
.who-pop { position: absolute; z-index: 5; left: 17px; margin-top: 22px; display: grid; gap: 4px; width: max-content; max-width: min(360px, calc(100% - 34px)); padding: 8px 12px; border-radius: var(--radius); background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow, 0 4px 16px rgb(0 0 0 / 0.08)); color: var(--ink-2); font-size: 12px; line-height: 1.6; }
.who-line { overflow-wrap: anywhere; }
.lines { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; margin: 4px 0 0 17px; color: var(--ink-2); }
.lines dt { color: var(--muted); }
.lines dd { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.lines .risk { color: var(--warn); }
.refs { margin-left: 17px; font-size: 13px; }
.refs :deep(p) { margin: 2px 0 0; }
</style>
