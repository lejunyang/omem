<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { speak, TYPE_LABEL, type Block, type QuizItem } from "./types";

/** One batch of questions: answered together, handed in once, then shown with its results. */
const props = defineProps<{ block: Block; voice?: { lang: string; rate: number }; submit: (answers: Record<string, unknown>) => Promise<void> }>();

const answers = reactive<Record<string, unknown>>({ ...(props.block.answers ?? {}) });
const sending = ref(false);
const error = ref("");
const open = computed(() => props.block.status === "open");
const results = computed(() => new Map((props.block.result?.items ?? []).map((r) => [r.id, r])));
const unanswered = computed(() => props.block.data.items.filter((it) => answers[it.id] === undefined || answers[it.id] === "").length);
const graded = computed(() => (props.block.result?.items ?? []).filter((r) => !r.pending));
const right = computed(() => graded.value.filter((r) => r.correct).length);
const pending = computed(() => (props.block.result?.items ?? []).filter((r) => r.pending).length);
const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

const clozeParts = (it: QuizItem) => (it.text ?? "").split(/_{3,}/);
const optionText = (it: QuizItem, i: number) => it.options?.[i] ?? "";

async function hand() {
  sending.value = true;
  error.value = "";
  try {
    await props.submit({ ...answers });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    sending.value = false;
  }
}

function mark(id: string) {
  const r = results.value.get(id);
  if (!r) return null;
  if (r.pending) return { cls: "wait", text: "等待评分" };
  if (r.score !== null && r.score > 0 && r.score < 1) return { cls: r.correct ? "ok" : "bad", text: `${Math.round(r.score * 100)}%` };
  return r.correct ? { cls: "ok", text: "对" } : { cls: "bad", text: "错" };
}
</script>

<template>
  <section class="quiz card" :aria-label="block.data.title">
    <header class="head">
      <h2>{{ block.data.title }}</h2>
      <span class="spacer" />
      <span v-if="!open && block.result" class="small muted">
        {{ graded.length ? `对 ${right} / ${graded.length}` : "" }}{{ pending ? ` · ${pending} 题待评分` : "" }}
      </span>
      <span v-else class="small muted">{{ block.data.items.length }} 题</span>
    </header>
    <p v-if="block.data.intro" class="intro muted">{{ block.data.intro }}</p>

    <ol class="items">
      <li v-for="(it, n) in block.data.items" :key="it.id" class="item" :class="mark(it.id)?.cls">
        <div class="meta row small">
          <span class="num">{{ n + 1 }}</span>
          <span class="badge">{{ TYPE_LABEL[it.type] ?? it.type }}{{ it.type === "translate" ? (it.direction === "zh-en" ? " · 中译英" : " · 英译中") : "" }}</span>
          <span class="badge">{{ it.level }}</span>
          <span class="spacer" />
          <span v-if="mark(it.id)" class="mark" :class="mark(it.id)!.cls">{{ mark(it.id)!.text }}</span>
        </div>

        <p v-if="it.prompt && it.type !== 'cloze'" class="prompt">{{ it.prompt }}</p>
        <div v-if="it.audio" class="row audio">
          <button class="btn sm" type="button" :disabled="!canSpeak" @click="speak(it.audio!, false, voice)">▶ 播放</button>
          <button class="btn sm ghost" type="button" :disabled="!canSpeak" @click="speak(it.audio!, true, voice)">慢速</button>
          <span v-if="!canSpeak" class="small muted">这个浏览器不支持朗读</span>
        </div>

        <div v-if="it.type === 'choice'" class="options" role="radiogroup" :aria-label="`第 ${n + 1} 题`">
          <button
            v-for="(o, i) in it.options"
            :key="i"
            type="button"
            role="radio"
            class="option"
            :aria-checked="answers[it.id] === i"
            :class="{ on: answers[it.id] === i, right: !open && results.get(it.id)?.expected === o, wrong: !open && answers[it.id] === i && !results.get(it.id)?.correct }"
            :disabled="!open"
            @click="answers[it.id] = i"
          >{{ o }}</button>
        </div>

        <div v-else-if="it.type === 'cloze'" class="cloze">
          <p v-if="it.prompt" class="small muted">{{ it.prompt }}</p>
          <p class="sentence">
            {{ clozeParts(it)[0] }}<input v-model="answers[it.id]" class="input blank" :disabled="!open" :aria-label="`第 ${n + 1} 题的空`" autocomplete="off" spellcheck="false" />{{ clozeParts(it)[1] }}
          </p>
        </div>

        <input v-else-if="it.type === 'dictation'" v-model="answers[it.id]" class="input" :disabled="!open" placeholder="写下听到的句子" autocomplete="off" spellcheck="false" :aria-label="`第 ${n + 1} 题`" />

        <textarea v-else v-model="answers[it.id] as string" class="textarea" rows="2" :disabled="!open" :placeholder="it.direction === 'zh-en' ? '用英文写' : '用中文写'" :aria-label="`第 ${n + 1} 题`" />

        <div v-if="!open && results.get(it.id)" class="answer small">
          <p v-if="it.type !== 'choice'">
            <span class="muted">你的答案：</span>{{ results.get(it.id)!.given || "（没答）" }}
          </p>
          <p v-if="results.get(it.id)!.expected && (it.type !== 'choice' || !results.get(it.id)!.correct)">
            <span class="muted">{{ it.type === "translate" ? "参考：" : "答案：" }}</span>{{ results.get(it.id)!.expected }}
          </p>
          <p v-if="results.get(it.id)!.explanation" class="muted">{{ results.get(it.id)!.explanation }}</p>
          <p v-if="results.get(it.id)!.feedback" class="feedback">{{ results.get(it.id)!.feedback }}</p>
        </div>
        <p v-else-if="!open && it.type === 'choice' && answers[it.id] !== undefined" class="small muted">你选了：{{ optionText(it, answers[it.id] as number) }}</p>
      </li>
    </ol>

    <footer v-if="open" class="foot row">
      <span v-if="error" class="small err">{{ error }}</span>
      <span class="spacer" />
      <span v-if="unanswered" class="small muted">还有 {{ unanswered }} 题没答</span>
      <button class="btn primary" type="button" :disabled="sending" @click="hand">{{ sending ? "提交中…" : "提交这一组" }}</button>
    </footer>
  </section>
</template>

<style scoped>
.quiz {
  padding: 16px 18px;
  display: grid;
  gap: 12px;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.head h2 {
  font-size: 17px;
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}
.item {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
  min-width: 0;
}
.item.ok {
  border-color: color-mix(in srgb, var(--ok) 35%, var(--line));
}
.item.bad {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--line));
}
.num {
  font-weight: 600;
  color: var(--ink-2);
}
.mark {
  font-weight: 600;
  border-radius: 4px;
  padding: 0 6px;
}
.mark.ok {
  color: var(--ok);
  background: var(--ok-soft);
}
.mark.bad {
  color: var(--danger);
  background: var(--danger-soft);
}
.mark.wait {
  color: var(--warn);
  background: var(--warn-soft);
}
.prompt,
.sentence {
  font-size: 15px;
  overflow-wrap: anywhere;
}
.options {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
}
.option {
  text-align: left;
  border: 1px solid var(--line-strong);
  background: var(--panel);
  border-radius: 8px;
  padding: 7px 10px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.option:hover:not(:disabled) {
  background: var(--hover);
}
.option.on {
  border-color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--ink);
}
.option.right {
  border-color: var(--ok);
  background: var(--ok-soft);
}
.option.wrong {
  border-color: var(--danger);
  background: var(--danger-soft);
}
.option:disabled {
  cursor: default;
}
.blank {
  display: inline-block;
  width: 9em;
  max-width: 100%;
  margin: 0 4px;
  padding: 2px 8px;
}
.answer {
  display: grid;
  gap: 2px;
  overflow-wrap: anywhere;
}
.feedback {
  color: var(--ink-2);
  border-left: 2px solid var(--accent);
  padding-left: 8px;
  margin-top: 2px;
}
.foot {
  flex-wrap: wrap;
}
.err {
  color: var(--danger);
}
</style>
