<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { get, onServerEvent, post, type Ask, type Run } from "../api";
import { proposalText } from "../lib/ai-policy";
import { toast } from "../store";
import AskCard from "./AskCard.vue";

/**
 * “用一句话改”: the owner says what they want (“日常整理别用 gemini 和 Claude Code”), a strong model
 * drafts the change to the rules (POST /api/ai/policy/propose, a run), and its preview comes back here
 * as the usual card to confirm, revise or drop. Nothing is saved before the confirmation. A draft still
 * under way is picked up again when the page opens (the run id is kept for the tab).
 */
const emit = defineEmits<{ changed: [] }>();
const KEEP = "omem.aiPolicyDraft";
const text = ref("");
const phase = ref<"idle" | "drafting" | "asking">("idle");
const runId = ref<string | null>(null);
const ask = ref<Ask | null>(null);
const said = ref("");
const failed = ref("");
const busy = ref(false);
let timer = 0;
let seq = 0;

function keep(id: string | null) {
  try {
    if (id) sessionStorage.setItem(KEEP, id);
    else sessionStorage.removeItem(KEEP);
  } catch {}
}
function stop() {
  clearTimeout(timer);
  timer = 0;
}
function reset(message = "") {
  stop();
  seq++;
  phase.value = "idle";
  runId.value = null;
  ask.value = null;
  said.value = message;
  keep(null);
}
async function submit() {
  const t = text.value.trim();
  if (!t || busy.value) return;
  busy.value = true;
  failed.value = "";
  said.value = "";
  try {
    const r = await post<{ runId: string }>("/api/ai/policy/propose", { text: t });
    follow(r.runId);
  } catch (e) {
    failed.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function follow(id: string) {
  stop();
  runId.value = id;
  keep(id);
  phase.value = "drafting";
  ask.value = null;
  void check();
}
/** Where the draft is: its card once the run has made one, or why it stopped. */
async function check() {
  const id = runId.value;
  if (!id) return;
  const mine = ++seq;
  stop();
  try {
    const { run } = await get<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}`);
    if (mine !== seq) return;
    const askId = typeof run.output?.askId === "string" ? run.output.askId : null;
    if (askId) {
      // A revise card is asked under the same run: the newest pending one is the one to answer.
      const pending = await get<Ask[]>("/api/asks?status=pending").catch(() => [] as Ask[]);
      if (mine !== seq) return;
      const open = pending.filter((a) => a.runId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const card = open ?? (await get<Ask>(`/api/asks/${encodeURIComponent(askId)}`));
      if (mine !== seq) return;
      if (card.status === "pending") {
        ask.value = card;
        phase.value = "asking";
        return;
      }
      return reset(card.result ?? "这份草稿已经处理过了。");
    }
    if (run.status === "failed" || run.status === "cancelled" || run.status === "done") {
      failed.value = run.error || "没有起草出规则，换个说法再试一次。";
      return reset();
    }
  } catch (e) {
    if (mine !== seq) return;
    failed.value = (e as Error).message;
    return reset();
  }
  timer = window.setTimeout(() => void check(), 3000);
}
/** After an answer: saved, dropped, or a card to restate it (then a new draft, under this run). */
async function answered(a: Ask) {
  const choice = a.options[a.choice ?? -1]?.label;
  if (a.ui?.fields?.length) {
    // The restated sentence starts a new draft whose parent is this run.
    const parent = runId.value!;
    said.value = a.result ?? "";
    ask.value = null;
    phase.value = "drafting";
    for (let i = 0; i < 10; i++) {
      const r = await get<{ children: Run[] }>(`/api/runs/${encodeURIComponent(parent)}`).catch(() => null);
      const child = r?.children.filter((c) => c.kind === "ai-policy-draft").sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
      if (child) return follow(child.id);
      await new Promise((ok) => setTimeout(ok, 800));
    }
    return reset("修改后的原话已经交出去了，起草好以后在“需要你处理”里确认。");
  }
  if (choice === "改一下") return void check();
  if (choice === "确认") {
    toast(a.result ?? "已保存 AI 规则", "ok");
    text.value = "";
    emit("changed");
  }
  reset(a.result ?? "");
}
const off = onServerEvent((e) => {
  if (e.type === "run" && e.runId === runId.value && phase.value === "drafting") void check();
});
onMounted(() => {
  if (proposalText.value) {
    text.value = proposalText.value;
    proposalText.value = "";
  }
  let kept: string | null = null;
  try { kept = sessionStorage.getItem(KEEP); } catch {}
  if (kept) follow(kept);
});
onBeforeUnmount(() => {
  stop();
  off();
});
</script>

<template>
  <div class="propose">
    <form class="propose-form" @submit.prevent="submit">
      <textarea v-model="text" class="textarea" rows="2" maxlength="8000" aria-label="用一句话改规则" placeholder="例如：日常整理别用 gemini 和 Claude Code；写文档优先 Gemini 的 neon" :disabled="phase !== 'idle'" @keydown.enter.exact.prevent="submit" />
      <button class="btn primary sm" :disabled="busy || phase !== 'idle' || !text.trim()">{{ busy ? "提交中…" : "起草" }}</button>
    </form>
    <p v-if="failed" class="small warn-text" role="alert">{{ failed }}</p>
    <p v-else-if="said && phase === 'idle'" class="small muted">{{ said }}</p>
    <div v-if="phase === 'drafting'" class="propose-wait small muted" role="status">
      <span class="dot" aria-hidden="true" />正在起草…强组的 AI 读完现有的类别、组和后端后，会在这里给出改动让你确认。
      <RouterLink v-if="runId" :to="`/runs/${runId}`">看过程</RouterLink>
      <button type="button" class="btn ghost sm" @click="reset()">不等了</button>
    </div>
    <AskCard v-if="phase === 'asking' && ask" :key="ask.id" :ask="ask" full @answered="answered" />
  </div>
</template>

<style scoped>
.propose {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.propose-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 8px;
}
.propose-wait {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  50% { opacity: 0.3; }
}
@media (prefers-reduced-motion: reduce) {
  .dot { animation: none; }
}
@media (max-width: 640px) {
  .propose-form {
    grid-template-columns: minmax(0, 1fr);
  }
  .propose-form > .btn {
    justify-self: end;
  }
}
</style>
