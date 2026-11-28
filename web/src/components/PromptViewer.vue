<script setup lang="ts">
/**
 * What one turn of a run sent its agent (`GET /api/runs/:id/prompts/:seq`, agents/prompt-log.ts): the
 * standing instructions and the message, each as an outline of its sections with their sizes, so the
 * reader sees what took the room before reading any of it. “原文” shows the text as it went.
 */
import { computed, ref, watch } from "vue";
import { get } from "../api";
import Icon from "./Icon.vue";
import SideSheet from "./SideSheet.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

export type PromptTurn = { seq: number; at: string; via: string; kept: boolean };
type Loaded = { via: string; systemSent: boolean; system: string | null; message: string | null; kept: boolean; expired: boolean; days: number };
/** `chars`: a top-level section counts the sections under it too. */
type Section = { title: string; level: number; text: string; chars: number };

const props = defineProps<{ runId: string; who: string; turns: PromptTurn[] }>();
const emit = defineEmits<{ close: [] }>();

const VIA: Record<string, string> = { system: "作为系统提示发出", message: "放在这条消息前面发出", resumed: "接上原会话，这一条没有再发", none: "没有说明" };
const at = ref(props.turns[0]?.seq ?? 0);
const loaded = ref<Loaded | null>(null);
const error = ref("");
const mode = ref<"outline" | "raw">("outline");
const open = ref(new Set<string>());
const filter = ref("");

let seq = 0;
async function load() {
  const mine = ++seq;
  loaded.value = null;
  error.value = "";
  open.value = new Set();
  try {
    const r = await get<Loaded>(`/api/runs/${encodeURIComponent(props.runId)}/prompts/${at.value}`);
    if (mine === seq) loaded.value = r;
  } catch (e) {
    if (mine === seq) error.value = (e as Error).message;
  }
}
watch(at, load, { immediate: true });

/** Sections by `#` and `##` headings (not inside code fences); what precedes the first heading is its own section. */
function outline(text: string, lead: string): Section[] {
  const out: Section[] = [];
  let cur: { title: string; level: number; lines: string[] } = { title: lead, level: 1, lines: [] };
  let fence = false;
  const push = () => {
    const body = cur.lines.join("\n").trim();
    if (body || cur.title !== lead) out.push({ title: cur.title, level: cur.level, text: body, chars: body.length });
  };
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^(#{1,2})\s+(.+)$/.exec(line);
    if (m) {
      push();
      cur = { title: m[2].trim(), level: m[1].length, lines: [] };
    } else if (line.trim() !== "---" || fence) cur.lines.push(line);
  }
  push();
  let top: Section | null = null;
  for (const sec of out) {
    if (sec.level === 1) top = sec;
    else if (top) top.chars += sec.chars;
  }
  return out;
}

const blocks = computed(() => {
  const l = loaded.value;
  if (!l) return [];
  return [
    ...(l.system !== null ? [{ key: "system", title: l.systemSent ? "说明" : "说明（这一条没有发）", note: l.systemSent ? VIA[l.via] ?? l.via : "这一条接上了原来的会话，说明没有再发；下面是当时一个新会话会收到的说明，会话开始时那一份可能略有不同。", text: l.system, sections: outline(l.system, "开头") }] : []),
    ...(l.message !== null ? [{ key: "message", title: "这一条消息", note: "", text: l.message, sections: outline(l.message, "开头") }] : []),
  ];
});
const q = computed(() => filter.value.trim().toLowerCase());
const shown = (s: Section) => !q.value || s.title.toLowerCase().includes(q.value) || s.text.toLowerCase().includes(q.value);
const isOpen = (key: string, s: Section) => open.value.has(key) || (!!q.value && s.text.toLowerCase().includes(q.value));
function toggle(key: string) {
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
}
function openAll(on: boolean) {
  open.value = on ? new Set(blocks.value.flatMap((b) => b.sections.map((_, i) => `${b.key}:${i}`))) : new Set();
}
const chars = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}K 字` : `${n} 字`);
const share = (n: number, total: number) => (total ? Math.max(2, Math.round((n / total) * 100)) : 0);
const time = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const turnOptions = computed(() => props.turns.map((t, i) => ({ value: t.seq, label: `第 ${i + 1} 条 ${time(t.at)}` })));
</script>

<template>
  <SideSheet :label="`${who}收到的提示词`" tag="提示词" :width="820" @close="emit('close')">
    <template #head><strong class="who ellipsis">{{ who }}</strong></template>
    <div class="viewer">
      <div v-if="turns.length > 1" class="turns">
        <UiSegmented v-if="turns.length <= 5" v-model="at" :options="turnOptions" aria-label="哪一条消息" />
        <UiSelect v-else v-model="at" :options="turnOptions" size="sm" aria-label="哪一条消息" />
      </div>
      <Skeleton v-if="!loaded && !error" variant="lines" :rows="12" />
      <p v-else-if="error" class="error">{{ error }}</p>
      <template v-else-if="loaded">
        <p v-if="!loaded.kept" class="muted">这一条没有保留原文：它发出时还没有这项记录，或者保留原文的开关关着。</p>
        <p v-else-if="loaded.expired" class="muted">原文已经清掉了：只保留最近 {{ loaded.days }} 天用过的，或者这次运行是在另一台设备上跑的。</p>
        <template v-else>
          <div class="bar row wrap">
            <UiSegmented v-model="mode" :options="[{ value: 'outline', label: '分节' }, { value: 'raw', label: '原文' }]" aria-label="怎么看" />
            <template v-if="mode === 'outline'">
              <input v-model="filter" class="input sm find" type="search" placeholder="在提示词里找" aria-label="在提示词里找" />
              <span class="spacer" />
              <button class="btn ghost sm" @click="openAll(true)">全部展开</button>
              <button class="btn ghost sm" @click="openAll(false)">全部收起</button>
            </template>
          </div>
          <section v-for="b in blocks" :key="b.key" class="block">
            <h4>{{ b.title }}<span class="muted small"> · {{ chars(b.text.length) }}</span></h4>
            <p v-if="b.note" class="muted small">{{ b.note }}</p>
            <pre v-if="mode === 'raw'" class="text mono">{{ b.text }}</pre>
            <template v-else>
              <template v-for="(s, i) in b.sections" :key="i">
                <div v-if="shown(s)" class="sec" :class="{ sub: s.level > 1 }">
                  <button class="sec-head" :aria-expanded="isOpen(`${b.key}:${i}`, s)" @click="toggle(`${b.key}:${i}`)">
                    <Icon :name="isOpen(`${b.key}:${i}`, s) ? 'down' : 'right'" :size="13" />
                    <span class="title">{{ s.title }}</span>
                    <span class="meter" aria-hidden="true"><i :style="{ width: `${share(s.chars, b.text.length)}%` }" /></span>
                    <span class="n muted small">{{ chars(s.chars) }}</span>
                  </button>
                  <pre v-if="isOpen(`${b.key}:${i}`, s)" class="text mono">{{ s.text || "（只有标题）" }}</pre>
                </div>
              </template>
              <p v-if="q && !b.sections.some(shown)" class="muted small">这一部分里没有“{{ filter.trim() }}”。</p>
            </template>
          </section>
        </template>
      </template>
    </div>
  </SideSheet>
</template>

<style scoped>
.who { min-width: 0; }
.viewer { display: grid; gap: 14px; min-width: 0; }
.turns { min-width: 0; overflow-x: auto; }
.bar { gap: 8px; align-items: center; }
.find { width: 180px; max-width: 100%; }
.block { display: grid; gap: 4px; min-width: 0; }
.block h4 { margin: 0 0 2px; font-size: 14px; }
.sec { border-top: 1px solid var(--line); min-width: 0; }
.sec.sub { margin-left: 18px; }
.sec-head { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; border: 0; background: none; color: var(--ink); font: inherit; font-size: 13px; text-align: left; padding: 7px 4px; cursor: pointer; border-radius: 6px; }
.sec-head:hover { background: var(--hover); }
.sec:not(.sub) > .sec-head .title { font-weight: 600; }
.title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.meter { flex: none; width: 72px; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.meter i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.n { flex: none; width: 64px; text-align: right; }
.text { margin: 0 0 8px; padding: 10px 12px; background: var(--hover); border-radius: 8px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 60vh; overflow: auto; }
.error { color: var(--danger); }
@media (max-width: 520px) {
  .meter { display: none; }
  .sec.sub { margin-left: 10px; }
}
</style>
