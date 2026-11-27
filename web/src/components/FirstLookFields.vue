<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { FIRST_TO_EFFECT, firstLookOptions, type FirstLookFields, type FirstLookOptions, type FirstTo } from "../lib/first-look";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 快速通道's three settings (docs/v2/first-look.md): look first with a fast model, which probes to run
 * before it, and where its first message goes. On a rule's 交给 Agent action, in a 关注's settings and in
 * a 持续跟进 rule's. `where`: what the deeper run is there (the rule's agent, the 关注's batch) for the one-line help.
 * Emits the whole set on every change; `firstTo` left out means the setting (设置 → 代你回复 → 快速通道).
 */
const props = defineProps<{ modelValue: FirstLookFields; where: "rule" | "listen" | "situation"; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [v: FirstLookFields]; change: [v: FirstLookFields] }>();

const options = ref<FirstLookOptions | null>(null);
const failed = ref("");
onMounted(() => void firstLookOptions().then((o) => (options.value = o)).catch((e) => (failed.value = (e as Error).message)));

function set(patch: Partial<FirstLookFields>) {
  const next: FirstLookFields = { ...props.modelValue, ...patch };
  if (!next.firstLook) delete next.firstLook;
  if (!next.probes?.length) delete next.probes;
  if (!next.firstTo) delete next.firstTo;
  emit("update:modelValue", next);
  emit("change", next);
}
const on = computed(() => !!props.modelValue.firstLook);
/** The probes there are, and any this one names that the library no longer has (still shown, so saving says why). */
const probeOptions = computed(() => {
  const list = (options.value?.probes ?? []).map((p) => ({ value: p.name, label: p.name, hint: p.description + (p.direct ? " · 结果直接发" : "") }));
  for (const n of props.modelValue.probes ?? []) if (!list.some((o) => o.value === n)) list.push({ value: n, label: n, hint: "预查库里没有了：保存会被拒绝" });
  return list;
});
const DEST_ORDER: FirstTo[] = ["dm", "ephemeral", "chat"];
const destLabel = (v: FirstTo) => options.value?.destinations.find((d) => d.value === v)?.label ?? { chat: "发到群里", dm: "私聊发给我", ephemeral: "群里只有我看得到" }[v];
const destOptions = computed(() => [
  { value: "", label: `按设置（${options.value ? destLabel(options.value.to) : "…"}）` },
  ...DEST_ORDER.map((v) => ({ value: v, label: destLabel(v) })),
]);
const effective = computed<FirstTo>(() => props.modelValue.firstTo ?? options.value?.to ?? "dm");
const DEEP: Record<typeof props.where, string> = {
  rule: "只有它说要接着查，才交给这个 Agent 按上面的设置深查",
  listen: "只有它说要接着查，才把这几条连同它的结论并进这一批，由这个关注照常处理",
  situation: "不管它答没答完，这一次跟进都照常开始，它的结论和预查结果一起交给处理者",
};
</script>

<template>
  <div class="first-look" :class="{ off: !on }">
    <UiCheckbox :model-value="on" switch size="sm" :disabled="disabled" @change="(v) => set({ firstLook: v })">帮你回复</UiCheckbox>
    <p class="hint">
      {{ on ? "" : "打开后，" }}有消息来先跑选的预查，再让便宜的快模型在 {{ options?.budgetSec ?? 90 }} 秒内看一眼，给出“答完了 / 要接着查 / 要你定”；{{ DEEP[where] }}。<template v-if="where === 'rule'">每条规则每天最多用 {{ options?.rulePerDay ?? 30 }} 次，超过和没有消息的触发照原来的路径走。</template>
    </p>
    <template v-if="on">
      <div class="line">
        <span class="small label">先跑哪些预查</span>
        <UiSelect :model-value="modelValue.probes ?? []" multiple size="sm" width="280px" :disabled="disabled" :options="probeOptions" :search-at="8" placeholder="不跑预查" aria-label="先跑哪些预查" @update:model-value="(v) => set({ probes: (v as string[]).slice(0, 8) })" />
        <router-link to="/rules/probes" class="small">管理预查库</router-link>
      </div>
      <p v-if="!probeOptions.length && options" class="hint">预查库还是空的：预查是你存好的只读脚本，在<router-link to="/rules/probes">规则 → 预查</router-link>里写。不跑预查也能用。</p>
      <div class="line">
        <span class="small label">第一条发到哪</span>
        <UiSegmented class="dest" :model-value="modelValue.firstTo ?? ''" size="sm" :options="destOptions" aria-label="第一条发到哪" @update:model-value="(v) => !disabled && set({ firstTo: (v || undefined) as FirstTo | undefined })" />
      </div>
      <p class="hint">{{ FIRST_TO_EFFECT[effective] }}快模型没给出结论（超时、出错）时什么都不发到群里，只告诉你。</p>
    </template>
    <p v-if="failed" class="hint err">读不到预查库：{{ failed }}</p>
  </div>
</template>

<style scoped>
.first-look {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.label {
  color: var(--ink-2);
}
.dest {
  max-width: 100%;
}
.hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.err {
  color: var(--danger);
}
</style>
