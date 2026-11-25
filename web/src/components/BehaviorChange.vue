<script lang="ts">
export type ChangeBlock = { kind: "same" | "del" | "add"; text: string; rewrite?: boolean };
export type BehaviorChangeView = {
  title: string;
  runTitle: string | null;
  reason: string | null;
  runs: number;
  explicit: boolean;
  target: { kind: string; label: string; name: string };
  current: string | null;
  files: { path: string; name: string; status: "added" | "removed" | "changed"; format?: "md" | "text"; counts: { removed: number; added: number; rewrite: number }; blocks: ChangeBlock[] }[];
};
</script>

<script setup lang="ts">
import { computed, ref } from "vue";
import { post, type Ask } from "../api";
import { toast } from "../store";
import Markdown from "./Markdown.vue";
import RichText from "./RichText.vue";

/**
 * A change the assistant made to how it works (src/agents/behavior-changes.ts) on its own page
 * (`#/ui/<askId>`): who and why, keep or undo, then every file's paragraphs before and after. Unchanged
 * paragraphs fold into “N 段没变”; changed ones are rendered, red for what went and green for what came.
 */
const props = defineProps<{ ask: Ask; change: BehaviorChangeView }>();
const emit = defineEmits<{ answered: [] }>();

const busy = ref(false);
async function answer(choice: number) {
  busy.value = true;
  try {
    const r = await post<{ result?: string }>(`/api/asks/${props.ask.id}/answer`, { choice });
    toast(r.result || "已处理", "ok");
    emit("answered");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}

const why = computed(() => [props.change.runTitle, props.change.reason].filter(Boolean).join("："));
const status = computed(() =>
  props.ask.status === "pending" ? "" : props.ask.status === "cancelled" ? `这张卡已经失效${props.ask.result ? `：${props.ask.result}` : "。"}` : props.ask.result || `已选：${props.ask.answer ?? ""}`,
);
function scale(f: BehaviorChangeView["files"][number]) {
  const changed = f.blocks.filter((b) => b.kind !== "same").length;
  if (f.status === "added") return `新建，共 ${changed} 段`;
  if (f.status === "removed") return `删除了这个文件（原有 ${changed} 段）`;
  const c = f.counts;
  return [c.removed && `删了 ${c.removed} 段`, c.added && `加了 ${c.added} 段`, c.rewrite && `改写 ${c.rewrite} 段`].filter(Boolean).join("、") || "只有格式或不显示的内容有变化";
}

/** Runs of unchanged paragraphs (two or more fold); a long file shows its first changes, the rest on demand. */
type Group = { key: string; kind: "same"; blocks: ChangeBlock[]; shown?: boolean } | { key: string; kind: "change"; block: ChangeBlock };
const LIMIT = 60;
function groups(fi: number): Group[] {
  const out: Group[] = [];
  let changes = 0;
  props.change.files[fi].blocks.forEach((b, i) => {
    if (b.kind === "same") {
      const last = out[out.length - 1];
      if (last?.kind === "same") last.blocks.push(b);
      else out.push({ key: `s${i}`, kind: "same", blocks: [b] });
    } else {
      changes++;
      if (changes <= LIMIT || more.value[fi]) {
        // The heading the change sits under stays in sight: fold what is above it.
        const last = out[out.length - 1];
        const h = last?.kind === "same" && props.change.files[fi].format !== "text" ? lastHeading(last.blocks) : -1;
        if (last?.kind === "same" && h > 0 && last.blocks.length - h <= 2) out.splice(out.length - 1, 1, { ...last, blocks: last.blocks.slice(0, h) }, { key: `${last.key}h`, kind: "same", blocks: last.blocks.slice(h), shown: true });
        out.push({ key: `c${i}`, kind: "change", block: b });
      }
    }
  });
  return out;
}
const HEADING = /^#{1,6}\s/;
/** Settings and YAML, and a file's front matter, read as they are written. */
const raw = (f: BehaviorChangeView["files"][number], b: ChangeBlock) => f.format === "text" || /^---\r?\n/.test(b.text);
function lastHeading(blocks: ChangeBlock[]) {
  for (let i = blocks.length - 1; i >= 0; i--) if (HEADING.test(blocks[i].text)) return i;
  return -1;
}
const hidden = (fi: number) => (more.value[fi] ? 0 : Math.max(props.change.files[fi].blocks.filter((b) => b.kind !== "same").length - LIMIT, 0));
const open = ref<Record<string, boolean>>({});
const more = ref<Record<number, boolean>>({});
</script>

<template>
  <article class="bc">
    <header class="bc-head">
      <p class="kicker small">{{ change.target.label }} · {{ change.target.name }}<template v-if="change.runs > 1"> · 合并了 {{ change.runs }} 次运行的改动</template></p>
      <h1>{{ change.title }}</h1>
      <p v-if="why" class="why"><RichText :text="why" /></p>
      <div class="row acts">
        <template v-if="ask.status === 'pending'">
          <button class="btn sm primary" :disabled="busy" @click="answer(0)">保留</button>
          <button class="btn sm danger" :disabled="busy" @click="answer(1)">撤回</button>
        </template>
        <p v-else class="status small" role="status">{{ status }}</p>
        <span class="spacer" />
        <a v-if="change.current" class="btn sm ghost" :href="change.current">现在的全文</a>
      </div>
    </header>

    <section v-for="(f, fi) in change.files" :key="f.path" class="file" :aria-label="`${f.name} 的改动`">
      <h2 class="fname"><span class="name" :title="f.path">{{ f.name }}</span><span class="muted small">{{ scale(f) }}</span></h2>
      <div class="diff">
        <template v-for="g in groups(fi)" :key="g.key">
          <template v-if="g.kind === 'same'">
            <button v-if="!g.shown && g.blocks.length > 1 && !open[`${fi}:${g.key}`]" type="button" class="fold small" :aria-expanded="false" @click="open[`${fi}:${g.key}`] = true">
              {{ g.blocks.length }} 段没变 · 展开
            </button>
            <template v-else>
              <button v-if="!g.shown && g.blocks.length > 1" type="button" class="fold small" :aria-expanded="true" @click="open[`${fi}:${g.key}`] = false">收起这 {{ g.blocks.length }} 段</button>
              <div v-for="(b, k) in g.blocks" :key="k" class="blk same">
                <span class="sign" aria-hidden="true" />
                <pre v-if="raw(f, b)" class="txt">{{ b.text }}</pre>
                <Markdown v-else :source="b.text" :linkify="false" compact />
              </div>
            </template>
          </template>
          <div v-else class="blk" :class="g.block.kind">
            <span class="sign" aria-hidden="true">{{ g.block.kind === "del" ? "−" : "+" }}</span>
            <span class="sr">{{ g.block.kind === "del" ? (g.block.rewrite ? "改写前：" : "删去：") : g.block.rewrite ? "改写后：" : "加上：" }}</span>
            <pre v-if="raw(f, g.block)" class="txt">{{ g.block.text }}</pre>
            <Markdown v-else :source="g.block.text" :linkify="false" compact />
          </div>
        </template>
        <button v-if="hidden(fi)" type="button" class="fold small" @click="more[fi] = true">还有 {{ hidden(fi) }} 段改动 · 全部显示</button>
      </div>
    </section>
  </article>
</template>

<style scoped>
.bc {
  display: grid;
  gap: 20px;
  min-width: 0;
}
.bc-head {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.kicker {
  margin: 0;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.bc-head h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.why {
  margin: 0;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.acts {
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.status {
  margin: 0;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.file {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.fname {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  font-size: 15px;
  font-weight: 650;
}
.fname .name {
  min-width: 0;
  overflow-wrap: anywhere;
}
.diff {
  display: grid;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  min-width: 0;
}
.diff > * + * {
  border-top: 1px solid var(--line);
}
.blk {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  padding: 6px 12px 6px 4px;
  min-width: 0;
}
.blk.del {
  background: var(--danger-soft);
}
.blk.add {
  background: var(--ok-soft);
}
.blk.same {
  color: var(--ink-2);
}
.sign {
  text-align: center;
  font-family: var(--mono);
  color: var(--muted);
  line-height: 1.7;
}
.blk.del .sign {
  color: var(--danger);
}
.blk.add .sign {
  color: var(--ok);
}
.blk :deep(.prose) {
  min-width: 0;
  overflow-wrap: anywhere;
}
.blk :deep(:is(h1, h2, h3, h4, h5, h6)) {
  margin: 0;
  font-size: 15px;
  border: 0;
  padding: 0;
}
.blk :deep(pre) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.txt {
  margin: 0;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
  background: none;
  padding: 0;
}
.fold {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  background: var(--sunken);
  color: var(--muted);
  padding: 5px 12px 5px 26px;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}
.fold:hover,
.fold:focus-visible {
  color: var(--accent);
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
