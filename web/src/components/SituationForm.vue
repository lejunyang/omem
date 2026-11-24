<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get } from "../api";
import { state } from "../store";
import type { FirstLookFields as FirstLook } from "../lib/first-look";
import FirstLookFields from "./FirstLookFields.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/**
 * A 情境's fields (docs/v2/situations.md), for a new one (SituationDialog) and on its page's 设置: the name,
 * what the owner cares about when it happens, one sentence on how to recognize it (compiled into a rule
 * when saved), who handles it, in which space, 快速通道's three settings, and on or off.
 */
export type SituationFields = { name: string; note: string; recognize: string; spec: string; spaceId: string; fast: FirstLook; active: boolean };
const model = defineModel<SituationFields>({ required: true });
defineProps<{ withName?: boolean }>();

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
    <label v-if="withName" class="field"><span>名字</span><input v-model="model.name" class="input" maxlength="80" placeholder="例如：项目 A 例行演练" /></label>
    <label class="field">
      <span>说明</span>
      <textarea v-model="model.note" class="textarea" rows="5" maxlength="2000" placeholder="这类事发生时你在意什么、要盯什么、什么时候告诉你。写意图，不用写步骤" />
      <span class="hint">处理者每一回都带着读；查某个平台的具体做法放在它的技能里，不写在这里。</span>
    </label>
    <label class="field">
      <span>怎么认出来</span>
      <textarea v-model="model.recognize" class="textarea short" rows="2" maxlength="1000" placeholder="一句话，例如：项目 A 的演练群里有人发“演练开始”，或演练记录表新增了一行" />
      <span class="hint">保存时编成一条规则（规则页里能看到，标着由这个情境生成）：可以是新消息、文档变化、对象状态变化或 omem 里的事。认出一次就开一回，已有进行中的一回时判断是不是同一回。</span>
    </label>
    <div class="two">
      <div class="field"><span>处理者</span><UiSelect v-model="model.spec" :options="specOptions" :search-at="8" aria-label="处理者" /></div>
      <div class="field"><span>空间</span><UiSelect v-model="model.spaceId" :options="spaceOptions" aria-label="空间" /><span class="hint">每一回的事项和资料放在这里。</span></div>
    </div>
    <div class="field">
      <span>快速通道</span>
      <FirstLookFields v-model="model.fast" where="situation" />
    </div>
    <UiCheckbox v-model="model.active" switch size="sm">{{ model.active ? "启用：认出来就开一回" : "停用：不再开新的一回，进行中的照常收尾" }}</UiCheckbox>
  </div>
</template>

<style scoped>
.sit-form {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
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
