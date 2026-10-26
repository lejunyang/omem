<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { post } from "../api";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";
import { toast } from "../store";
import { decisionOf, type Reviews } from "../lib/reviews";
import { clearQuotes, quotesOf, quotesText, removeQuote } from "../lib/quotes";

/**
 * The next round of changes gathered by selecting text on the run page (“加入修改点”): numbered
 * quotes, each with what should change there, plus the review findings marked “改”. Starting the
 * fix sends them as one task, as the 概览's fix box does.
 */
const props = defineProps<{ runId: string; rv: Reviews; canFix: boolean; branchReview: boolean }>();
const emit = defineEmits<{ close: [] }>();
const router = useRouter();
const quotes = computed(() => quotesOf(props.runId, "fix"));
const findingIds = computed(() => props.rv.findings.value.filter((f) => decisionOf(f) === "fix").map((f) => f.id));
const withFindings = ref(true);
const extra = ref("");
const starting = ref(false);
const returnTo = document.activeElement as HTMLElement | null;
const panel = ref<HTMLElement | null>(null);
onMounted(() => panel.value?.focus());
onBeforeUnmount(() => returnTo?.focus?.());

async function start() {
  const ids = withFindings.value ? findingIds.value : [];
  const text = [quotesText(quotes.value, "本人在页面上选中、要求修改的地方（按 [1]、[2] 编号）："), extra.value.trim()].filter(Boolean).join("\n\n");
  if (starting.value || (!ids.length && !text)) return;
  starting.value = true;
  try {
    const r = await post<{ id: string }>(`/api/runs/${props.runId}/fix`, { findingIds: ids, text: text || undefined });
    clearQuotes(props.runId, "fix");
    toast(props.branchReview ? "已基于这个分支交办修改" : "已安排下一轮修改", "ok");
    emit("close");
    router.push(`/runs/${r.id}`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <div class="scrim" @click="emit('close')" />
  <aside ref="panel" class="drawer" role="dialog" aria-label="下一轮要改的" tabindex="-1" @keydown.esc="emit('close')">
    <header>
      <span class="t">下一轮要改的</span>
      <button class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="16" /></button>
    </header>
    <div class="body">
      <p class="muted small">在改动、评审或打开的原件里选中一段，点“加入修改点”，攒在这里；每处写一句要怎么改，再一起开始修改。关闭后还在，右下角的图标能再打开。</p>
      <p v-if="!quotes.length" class="muted">还没有加入的修改点。</p>
      <div v-for="(q, i) in quotes" :key="q.id" class="quote">
        <div class="row small muted"><span class="num">[{{ i + 1 }}]</span><span class="grow ellipsis" :title="q.label">{{ q.label }}</span><button class="btn ghost sm icon" :aria-label="`去掉修改点 ${i + 1}`" @click="removeQuote(runId, 'fix', q.id)"><Icon name="x" :size="13" /></button></div>
        <pre>{{ q.quote }}</pre>
        <input v-model="q.note" class="input sm" :placeholder="`[${i + 1}] 这里要怎么改（可不填）`" :aria-label="`修改点 ${i + 1} 的要求`" />
      </div>
    </div>
    <div class="compose">
      <p v-if="!canFix" class="muted small">这次交办已经应用、丢弃或还没完成，不能从这里续改；可以先把这些内容复制到新的交办里。</p>
      <UiCheckbox v-if="findingIds.length" v-model="withFindings" size="sm">同时改评审里定为“改”的 {{ findingIds.length }} 个问题</UiCheckbox>
      <textarea v-model="extra" class="textarea" rows="3" placeholder="其他要求（可选）：需求变化、实现上的约束" aria-label="其他要求" />
      <div class="row">
        <span class="muted small">{{ quotes.length }} 处{{ withFindings && findingIds.length ? ` + ${findingIds.length} 个问题` : "" }}</span>
        <span class="spacer" />
        <button class="btn primary sm" :disabled="!canFix || starting || (!quotes.length && !extra.trim() && !(withFindings && findingIds.length))" @click="start">开始修改</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; background: rgba(10, 12, 16, 0.2); z-index: 39; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100vw); background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow-lg); z-index: 40; display: flex; flex-direction: column; outline: none; }
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--line); min-height: 52px; }
.t { flex: 1; font-weight: 600; }
.body { flex: 1; padding: 16px; overflow: auto; display: grid; gap: 12px; align-content: start; }
.body > p { margin: 0; }
.compose { border-top: 1px solid var(--line); padding: 12px 16px; display: grid; gap: 8px; }
.compose p { margin: 0; }
.quote { border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 8px 8px 0; padding: 4px 8px 8px 10px; display: grid; gap: 6px; }
.quote pre { margin: 0; max-height: 160px; overflow: auto; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.num { font-weight: 600; color: var(--accent); }
.grow { flex: 1; min-width: 0; }
</style>
