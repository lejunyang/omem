<script setup lang="ts">
import { computed, ref } from "vue";
import type { PreCheck } from "../lib/works";
import { relTime } from "../store";
import Markdown from "./Markdown.vue";

/**
 * The check before coding (docs/v2/pre-check.md): what the change touches, what went wrong there
 * before, what to test again afterwards. The coder planned its tasks with it; the reviews check
 * against it.
 */
const props = defineProps<{ check: PreCheck; space?: string }>();
const open = ref(false);

type Line = { text: string; tag?: string; where?: string[]; note?: string };
const sections = computed(() => {
  const c = props.check;
  const out: { title: string; lines: Line[] }[] = [];
  const meta = (x: { reqs?: string[]; refs?: string[] }) => [x.reqs?.length ? `需求点 ${x.reqs.join("、")}` : "", x.refs?.length ? `依据 ${x.refs.join("、")}` : ""].filter(Boolean).join(" · ");
  if (c.impacts?.length) out.push({ title: "要顾及的", lines: c.impacts.map((x) => ({ text: x.text, where: x.where, note: meta(x) })) });
  if (c.history?.length) out.push({ title: "以前出过的问题", lines: c.history.map((x) => ({ text: x.text, where: x.where, note: meta(x) })) });
  if (c.regressions?.length) out.push({ title: "回归清单", lines: c.regressions.map((x) => ({ text: x.text, tag: x.auto ? "自动" : "人工", note: [x.how ?? "", x.reqs?.length ? `需求点 ${x.reqs.join("、")}` : ""].filter(Boolean).join(" · ") })) });
  if (c.areas?.length) out.push({ title: "预计改动的位置", lines: c.areas.map((a) => ({ text: a.note || "", where: a.files })) });
  if (c.questions?.length) out.push({ title: "没查清的", lines: c.questions.map((q) => ({ text: q })) });
  return out;
});
const counts = computed(() => [
  props.check.impacts?.length ? `要顾及 ${props.check.impacts.length} 处` : "",
  props.check.history?.length ? `以前的问题 ${props.check.history.length} 条` : "",
  props.check.regressions?.length ? `回归 ${props.check.regressions.length} 项` : "",
  props.check.questions?.length ? `没查清 ${props.check.questions.length} 条` : "",
].filter(Boolean).join(" · "));
</script>

<template>
  <section class="card pad block pre">
    <div class="row wrap head">
      <strong class="small">编码前的检查</strong>
      <span class="muted small">{{ counts || "没查出要特别顾及的" }}<template v-if="check.at"> · {{ relTime(check.at) }}</template></span>
      <span class="spacer" />
      <button v-if="sections.length" class="btn ghost sm" :aria-expanded="open" @click="open = !open">{{ open ? "收起" : "展开" }}</button>
    </div>
    <div class="small summary"><Markdown :source="check.summary" :space="space" /></div>
    <div v-if="open" class="more small">
      <div v-for="s in sections" :key="s.title" class="sec">
        <div class="section-title">{{ s.title }}</div>
        <ul>
          <li v-for="(l, i) in s.lines" :key="i">
            <span v-if="l.tag" class="badge" :class="l.tag === '自动' ? 'ok' : ''">{{ l.tag }}</span>
            <span>{{ l.text }}</span>
            <span v-if="l.where?.length" class="where"><code v-for="w in l.where" :key="w">{{ w }}</code></span>
            <span v-if="l.note" class="muted note">{{ l.note }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pre { display: grid; gap: 8px; }
.head { gap: 8px; align-items: center; }
.summary { min-width: 0; overflow-wrap: anywhere; }
.more { display: grid; gap: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.sec { display: grid; gap: 4px; }
ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
li { overflow-wrap: anywhere; }
li > * + * { margin-left: 6px; }
.where code { font-size: 12px; margin-right: 4px; }
.note { font-size: 12px; }
</style>
