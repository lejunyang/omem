<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { initialValues } from "@omem-ai/plugin-sdk/blocks";
import { post, type Ask } from "../api";
import Markdown from "./Markdown.vue";
import UiFields from "./UiFields.vue";
import UiView from "./UiView.vue";
import { toast } from "../store";

/**
 * One question, set of suggested next steps or approval from an agent. A button answers at once;
 * the text box takes a free answer or a refusal's reason. Suggestions render compactly under the
 * reply they belong to. A question may carry a form and things to look at (docs/v2/interactive-ui.md):
 * the form is sent as a whole, with an optional note.
 */
/** `full`: opened on its own (a side sheet): nothing is clipped, and what opened it already says what kind it is. */
const props = defineProps<{ ask: Ask; compact?: boolean; full?: boolean }>();
const emit = defineEmits<{ answered: [Ask] }>();
const text = ref("");
const busy = ref(false);
const title = computed(() => ({ question: "需要你回答", approval: "需要你批准", suggestion: "" })[props.ask.kind]);
/** A host card's own head (a flow stage, a design) and body; the question is then only its text version. */
const head = computed(() => props.ask.ui?.head ?? null);
const hasBody = computed(() => props.ask.ui?.body !== undefined);
const BADGE = { info: "accent", success: "ok", warning: "warn", danger: "danger", neutral: "" } as const;
/** omem's own pages open in place; other addresses in a new tab. */
const inApp = (url: string) => url.startsWith(`${location.origin}${location.pathname}#`) || url.startsWith(`${location.origin}/#`);
const hrefOf = (url: string) => (inApp(url) ? url.slice(url.indexOf("#")) : url);
const fields = computed(() => props.ask.ui?.fields ?? []);
const values = reactive<Record<string, unknown>>(initialValues(props.ask.ui?.fields ?? []));
const error = ref("");
/** What is asked, in a sentence, then its sections (src/agents/brief.ts); a long rest opens on demand. */
const parts = computed(() => {
  const ps = (props.ask.question ?? "").trim().split(/\n\s*\n/);
  return { lead: ps[0] ?? "", body: ps.slice(1).join("\n\n") };
});
const long = computed(() => !props.full && parts.value.body.length > 700);
const expanded = ref(false);

async function answer(body: { choice?: number; approved?: boolean; value?: Record<string, unknown> }) {
  if (busy.value) return;
  if (props.ask.kind === "question" && body.choice === undefined && !body.value && !text.value.trim()) return toast("写下回答，或点一个选项");
  busy.value = true;
  error.value = "";
  try {
    const done = await post<Ask>(`/api/asks/${props.ask.id}/answer`, { ...body, text: text.value.trim() || undefined });
    text.value = "";
    emit("answered", done);
  } catch (e) {
    if (body.value) error.value = (e as Error).message;
    else toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="ask" :class="[ask.kind, { compact }, head?.tag ? `tone-${head.tag.tone}` : '']" role="group" :aria-label="head?.title || title || '下一步'">
    <div v-if="head" class="ask-head">
      <div class="ask-head-row">
        <span class="ask-head-title">{{ head.title || title }}</span>
        <span v-if="head.tag" class="badge" :class="BADGE[head.tag.tone]">{{ head.tag.text }}</span>
      </div>
      <div v-if="head.subtitle" class="muted small ask-head-sub">{{ head.subtitle }}</div>
    </div>
    <div v-else-if="title && !full" class="ask-title small">{{ title }}</div>
    <div v-if="ask.askedBy" class="muted small">{{ ask.askedByName || ask.askedBy }} 的助手替 ta 问你，回答会交给 ta</div>
    <Markdown v-if="hasBody && ask.ui?.body" :source="ask.ui.body" compact />
    <template v-else-if="!hasBody && ask.question">
      <Markdown :class="{ 'ask-lead': !!parts.body }" :source="parts.lead" compact />
      <div v-if="parts.body" class="ask-body" :class="{ clipped: long && !expanded }">
        <Markdown class="ask-q" :source="parts.body" compact />
      </div>
      <button v-if="long" type="button" class="btn ghost sm more" @click="expanded = !expanded">{{ expanded ? "收起" : "展开全部" }}</button>
    </template>
    <UiView v-if="ask.ui?.view?.length" class="ask-view" :components="ask.ui.view" :ask-id="ask.id" :can-submit="!fields.length && ask.status === 'pending'" :draft="(ask as { draft?: unknown }).draft" @answered="emit('answered', ask)" />
    <div v-if="ask.ui?.links?.length" class="ask-links">
      <a v-for="l in ask.ui.links" :key="l.url" :href="hrefOf(l.url)" :target="inApp(l.url) ? undefined : '_blank'" :rel="inApp(l.url) ? undefined : 'noopener'">{{ l.text }}<span aria-hidden="true">{{ inApp(l.url) ? " →" : " ↗" }}</span></a>
    </div>
    <form v-if="fields.length" class="ask-form" @submit.prevent="answer({ value: { ...values } })">
      <UiFields :fields="fields" :values="values" :id-prefix="`ask-${ask.id}`" />
      <textarea v-if="ask.allowText" v-model="text" class="textarea" rows="2" placeholder="补充说明（可不填）" aria-label="补充说明" />
      <div class="row gap wrap">
        <span v-if="error" class="err small" role="alert">{{ error }}</span>
        <span class="spacer" />
        <button class="btn primary sm" :disabled="busy">{{ ask.ui?.submitLabel || "提交" }}</button>
      </div>
    </form>
    <div v-else class="row wrap gap">
      <template v-if="ask.kind === 'approval'">
        <button class="btn primary sm" :disabled="busy" @click="answer({ approved: true })">批准</button>
        <button class="btn danger sm" :disabled="busy" @click="answer({ approved: false })">拒绝</button>
      </template>
      <button v-for="(o, i) in ask.options" v-else :key="i" class="btn sm" :class="i === 0 ? 'primary' : ''" :disabled="busy" :title="o.message || o.label" @click="answer({ choice: i })">{{ o.label }}</button>
    </div>
    <form v-if="ask.allowText && !fields.length" class="row gap ask-text" @submit.prevent="answer(ask.kind === 'approval' ? { approved: false } : {})">
      <input v-model="text" class="input" :placeholder="ask.kind === 'approval' ? '理由或附言（点批准或拒绝时一起发送）' : ask.options.length ? '也可以写别的回答' : '你的回答'" :aria-label="ask.kind === 'approval' ? '理由' : '回答'" />
      <button v-if="ask.kind === 'question'" class="btn sm" :disabled="busy || !text.trim()">回答</button>
    </form>
  </div>
</template>

<style scoped>
.ask {
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* Whatever the question holds (a long link, a wide table, a code line) stays inside the card. */
  box-sizing: border-box;
  max-width: min(760px, 100%);
  min-width: 0;
  overflow-wrap: anywhere;
}
.ask-lead { font-weight: 600; }
.ask-lead :deep(p) { margin: 0; }
.ask-body.clipped { max-height: 280px; overflow: hidden; mask-image: linear-gradient(to bottom, #000 75%, transparent); }
.more { align-self: flex-start; }
.ask > * {
  min-width: 0;
  max-width: 100%;
}
/* Wide tables and code scroll sideways inside the card; cells keep their words whole instead of breaking every number. */
.ask-q :deep(pre),
.ask-q :deep(table) {
  max-width: 100%;
  overflow-x: auto;
}
.ask-q :deep(th),
.ask-q :deep(td) {
  overflow-wrap: normal;
  word-break: normal;
  min-width: 4em;
}
.ask-q :deep(th) {
  white-space: nowrap;
}
.ask.approval {
  border-left-color: var(--warn);
}
/* A host card's state colours its edge, the same tone as its tag. */
.ask.tone-success { border-left-color: var(--ok); }
.ask.tone-warning { border-left-color: var(--warn); }
.ask.tone-danger { border-left-color: var(--danger); }
.ask.tone-neutral { border-left-color: var(--line-strong); }
.ask-head { display: grid; gap: 2px; margin-bottom: -2px; }
.ask-links { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; }
.ask-links a { color: var(--accent); text-decoration: none; }
.ask-links a:hover { text-decoration: underline; }
.ask-head-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ask-head-title { font: 600 15px/1.4 var(--serif); }
.ask-head-sub { overflow-wrap: anywhere; }
.ask.compact {
  border: none;
  padding: 4px 0 0;
  background: transparent;
}
.ask-title {
  font-weight: 600;
  color: var(--muted);
}
.gap {
  gap: 6px;
}
.ask-text .input {
  flex: 1;
  min-width: 0;
}
.ask-view {
  border: none;
  padding: 0;
  background: transparent;
}
.ask-form {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.err {
  color: var(--danger);
}
.spacer {
  flex: 1;
}
</style>
