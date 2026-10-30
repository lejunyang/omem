<script setup lang="ts">
import { computed } from "vue";
import { openCitation, state, type CitationTarget } from "../store";

/**
 * A memory's text with its references made clickable: `[[cases/x]]` / `[[space:slug|文字]]` a Wiki page
 * (a case page is one), `[文字](src:<id>#L1-L9)` and bare `src:` / `mem:` / `msg:` refs. All open in the
 * citation drawer on this page, the way a Wiki page's citations do.
 */
const props = defineProps<{ text: string; space?: string }>();

type Part = { text: string; target?: CitationTarget };
const RE = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\((src:[^)\s]+)\)|\b(src|mem|msg):([\w.-]+)(?:#L(\d+)(?:-L?(\d+))?)?/g;

function src(id: string, from?: string, to?: string): CitationTarget {
  return { kind: "source", id, from: from ? +from : undefined, to: to ? +to : from ? +from : undefined };
}
const parts = computed<Part[]>(() => {
  const out: Part[] = [];
  let last = 0;
  for (const m of props.text.matchAll(RE)) {
    if (m.index > last) out.push({ text: props.text.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[1]) {
      const t = m[1].trim();
      // Slugs have no ":", space ids may be any script (`[[项目A:cases/x]]`).
      const [space, slug] = /^[^:/\s]+:/.test(t) ? [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)] : [props.space ?? state.space, t];
      out.push({ text: m[2] ?? slug, target: { kind: "page", space, slug } });
    } else if (m[3]) {
      const r = /^src:([^#]+)(?:#L(\d+)(?:-L?(\d+))?)?/.exec(m[4]);
      out.push(r ? { text: m[3], target: src(r[1], r[2], r[3]) } : { text: m[0] });
    } else if (m[5] === "src") out.push({ text: m[0], target: src(m[6], m[7], m[8]) });
    else out.push({ text: m[0], target: { kind: m[5] === "mem" ? "memory" : "message", id: m[6] } });
  }
  if (last < props.text.length) out.push({ text: props.text.slice(last) });
  return out;
});
function open(e: MouseEvent, t: CitationTarget) {
  // Inside the drawer a reference goes one layer deeper; elsewhere it opens the drawer afresh.
  openCitation(t, !(e.target as HTMLElement).closest(".drawer"));
}
</script>

<template>
  <span class="memory-text"><template v-for="(p, i) in parts" :key="i"><a v-if="p.target" href="#" class="ref" :class="`ref-${p.target.kind}`" :title="p.target.kind === 'page' ? `${p.target.space}:${p.target.slug}` : undefined" @click.prevent.stop="open($event, p.target)">{{ p.text }}</a><template v-else>{{ p.text }}</template></template></span>
</template>

<style scoped>
.ref {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dashed currentColor;
}
.ref:hover {
  text-decoration: none;
  border-bottom-style: solid;
}
/* Prefixed: a bare `page` class would pick up the global page layout (padding). */
.ref-source,
.ref-memory,
.ref-message {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.88em;
}
</style>
