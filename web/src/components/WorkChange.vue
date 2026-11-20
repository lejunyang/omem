<script setup lang="ts">
import { computed, ref } from "vue";
import { put } from "../api";
import Markdown from "./Markdown.vue";
import { toast } from "../store";
import { changeTone, changeTypeLabel, clock, originLabel, refsMarkdown, type ChangeLite } from "../lib/work";

/**
 * One key change as a card in a list (按时间, a line's timeline): the change in a sentence with its
 * kind, when and on which line, its risk and next step, the sources, and 对我没用. The title opens
 * the whole change on the side.
 */
const props = defineProps<{ change: ChangeLite; line?: boolean; lineId?: string }>();
const emit = defineEmits<{ open: [c: ChangeLite]; changed: [] }>();
const c = computed(() => props.change);
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
</script>

<template>
  <article class="change" :class="[changeTone(c.type), { noise: c.noise }]">
    <header>
      <span class="dot" aria-hidden="true" />
      <button type="button" class="title" @click="emit('open', c)">{{ c.summary }}</button>
      <button type="button" class="lnk small muted no-use" :disabled="busy" @click="noise">{{ c.noise ? "放回" : "对我没用" }}</button>
    </header>
    <p class="meta small">
      <span class="tag">{{ changeTypeLabel[c.type] ?? c.type }}</span>
      <span>{{ clock(c.at) }}</span>
      <span>{{ originLabel[c.origin] ?? c.origin }}</span>
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
.lines { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; margin: 4px 0 0 17px; color: var(--ink-2); }
.lines dt { color: var(--muted); }
.lines dd { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.lines .risk { color: var(--warn); }
.refs { margin-left: 17px; font-size: 13px; }
.refs :deep(p) { margin: 2px 0 0; }
</style>
