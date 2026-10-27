<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { get, post, put } from "../api";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";
import { fmtTime, toast } from "../store";

/**
 * A coding delegation while it runs (src/agents/code-steer.ts): the owner's words for the coding
 * Agent without waiting for the round to end, and the review the rounds get from now on. The same
 * as telling the assistant (message_code_run / set_code_review).
 */
type Note = { id: string; text: string; at: string; deliveredAt?: string };
type RoundReview = { tier?: string; checks?: string[]; split?: boolean; rotate?: boolean };
const props = defineProps<{ runId: string; coding: boolean; notes: Note[]; review: RoundReview | undefined }>();
const emit = defineEmits<{ changed: [] }>();

const text = ref("");
const sending = ref(false);
async function send() {
  if (!text.value.trim() || sending.value) return;
  sending.value = true;
  try {
    const r = await post<{ stage: string }>(`/api/runs/${props.runId}/notes`, { text: text.value.trim() });
    text.value = "";
    toast(r.stage === "coding" ? "已交给编码 Agent" : "编码已写完，下一轮带上", "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    sending.value = false;
  }
}

const tiers = ref<{ id: string; name: string }[]>([]);
onMounted(async () => {
  try {
    tiers.value = (await get<{ tiers: { id: string; name: string }[] }>("/api/review-settings")).tiers;
  } catch {
    /* the review choice is optional */
  }
});
const tier = ref(props.review?.tier ?? "");
const split = ref(props.review?.split !== false);
const rotateOf = (r?: RoundReview) => (r?.rotate === undefined ? "" : r.rotate ? "on" : "off");
const rotate = ref<"" | "on" | "off">(rotateOf(props.review));
watch(() => props.review, (r) => { tier.value = r?.tier ?? ""; split.value = r?.split !== false; rotate.value = rotateOf(r); });
const ROTATE = [{ value: "" as const, label: "模型按档位设置" }, { value: "on" as const, label: "每轮换模型" }, { value: "off" as const, label: "不换模型" }];
const tierOptions = computed(() => [{ value: "", label: "按改动自动选" }, ...tiers.value.map((t) => ({ value: t.id, label: `「${t.name}」档` }))]);
async function saveReview() {
  try {
    const r = await put<{ current: boolean }>(`/api/runs/${props.runId}/round-review`, { tier: tier.value, split: split.value, ...(rotate.value ? { rotate: rotate.value === "on" } : {}) });
    toast(r.current ? "这一轮就按这个评审" : "这一轮已在评审，从下一轮开始", "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
</script>

<template>
  <section class="card pad block steer">
    <div class="row wrap">
      <div class="section-title flat">补充给编码 Agent</div>
      <span class="spacer" />
      <span class="muted small">{{ coding ? "它下一次调用 omem 工具时收到，最晚在这一轮检查之前" : "这一轮已写完代码，补充随下一轮交给它" }}</span>
    </div>
    <ul v-if="notes.length" class="notes small">
      <li v-for="n in notes" :key="n.id"><span class="muted">{{ fmtTime(n.at) }}</span> {{ n.text }} <span class="badge" :class="{ ok: n.deliveredAt }">{{ n.deliveredAt ? "已交给它" : "等待交付" }}</span></li>
    </ul>
    <div class="row">
      <input v-model="text" class="input sm grow" placeholder="新要求或纠正，原话就行" aria-label="补充给编码 Agent" @keydown.enter="send" />
      <button class="btn sm" :disabled="sending || !text.trim()" @click="send">发送</button>
    </div>
    <div class="row wrap small">
      <span class="muted">之后的评审</span>
      <UiSelect v-model="tier" :options="tierOptions" size="sm" width="170px" aria-label="之后各轮的评审档位" @change="saveReview" />
      <UiCheckbox v-model="split" size="sm" @update:model-value="saveReview">拆需求</UiCheckbox>
      <UiSelect v-model="rotate" :options="ROTATE" size="sm" width="150px" aria-label="之后各轮评审换不换模型" @change="saveReview" />
    </div>
  </section>
</template>

<style scoped>
.steer { display: grid; gap: 8px; }
.flat { margin: 0; }
.grow { flex: 1; min-width: 0; }
.notes { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
.notes li { overflow-wrap: anywhere; }
</style>
