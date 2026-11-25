<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get } from "../api";
import { state } from "../store";
import { SITUATION_REPLY_OPTIONS, type SituationFormValue } from "../lib/listen";
import FirstLookFields from "./FirstLookFields.vue";
import UiSelect from "./UiSelect.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * What a 持续跟进 rule does when it fires (docs/v2/situations.md), under its action on the rules page:
 * what the owner cares about each time, who handles it, in which space, what may go to this time's
 * group, and 快速通道's three settings. The rule's name, on / off and trigger are the rule's own fields.
 */
const model = defineModel<SituationFormValue>({ required: true });

/** The Agent profiles that may handle it, 主助手 first. */
const specs = ref<{ name: string; description?: string }[]>([]);
onMounted(() => void get<{ name: string; description?: string }[]>("/api/agents").then((r) => (specs.value = r)).catch(() => {}));
const specOptions = computed(() => {
  const list = [{ value: "assistant", label: "主助手", hint: "你的主助手，带着你挂的技能" }];
  for (const s of specs.value) if (s.name !== "assistant") list.push({ value: s.name, label: s.name, hint: s.description ?? "" });
  if (model.value.spec && !list.some((o) => o.value === model.value.spec)) list.push({ value: model.value.spec, label: model.value.spec, hint: "档案不在了" });
  return list;
});
const spaceOptions = computed(() => state.spaces.map((s) => ({ value: s.id, label: s.name })));
</script>

<template>
  <div class="sit-form">
    <label class="field">
      <span>说明</span>
      <textarea v-model="model.note" class="textarea" rows="5" maxlength="2000" placeholder="这类事发生时你在意什么、要盯什么、什么时候告诉你。写意图，不用写步骤" />
      <span class="hint">处理者每一次都带着读；查某个平台的具体做法放在它的技能里，不写在这里。</span>
    </label>
    <div class="two">
      <div class="field"><span>处理者</span><UiSelect v-model="model.spec" :options="specOptions" :search-at="8" aria-label="处理者" /><span class="hint">每一次由它查、复查和写小结。</span></div>
      <div class="field"><span>空间</span><UiSelect v-model="model.spaceId" :options="spaceOptions" aria-label="空间" /><span class="hint">每一次的事项和资料放在这里。</span></div>
    </div>
    <div class="field">
      <span>这一次的群里</span>
      <UiSegmented v-model="model.reply" size="sm" aria-label="这一次的群里" :options="SITUATION_REPLY_OPTIONS" />
      <span class="hint">助手找到这一次对应的群后，把说明里要发到群里的内容发过去；不发时只私下告诉你。</span>
    </div>
    <div class="field">
      <span>快速通道</span>
      <FirstLookFields v-model="model.fast" where="situation" />
    </div>
  </div>
</template>

<style scoped>
.sit-form {
  display: grid;
  gap: 14px;
  min-width: 0;
}
/* Side by side, the controls line up at the top: a field's hint sits under its own control. */
.two {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}
.two > .field {
  align-content: start;
}
.two > * {
  min-width: 0;
}
.textarea {
  min-height: 0;
}
@media (max-width: 560px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
