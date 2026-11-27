<script setup lang="ts">
import { computed, onMounted } from "vue";
import { aiPolicy, effectiveGroups, hasOldSettings, loadAiPolicy } from "../lib/ai-policy";
import { useSettings } from "../views/settings/ctx";
import AiClassRules from "./AiClassRules.vue";
import AiGroups from "./AiGroups.vue";
import AiPolicyPropose from "./AiPolicyPropose.vue";
import HelpText from "./HelpText.vue";
import SetCard from "./SetCard.vue";
import SetGate from "./SetGate.vue";
import Skeleton from "./Skeleton.vue";

/**
 * 设置 → 后端与模型 → 规则 (docs/v2/ai-policy.md): a sentence to change the rules, the categories of
 * runs with what each may use, and the AI groups the rules name. The groups start from the old tiers
 * and candidates until they are saved once (lib/ai-policy.ts effectiveGroups).
 */
const { config, profiles, load } = useSettings();
onMounted(() => void loadAiPolicy(true));
const view = computed(() => aiPolicy.data);
const tiers = computed(() => config.value?.agents?.tiers ?? {});
const candidates = computed(() => config.value?.agents?.routing?.candidates ?? []);
const oldSettings = computed(() => hasOldSettings(tiers.value, candidates.value));
const groups = computed(() => effectiveGroups(view.value?.groups, tiers.value, candidates.value));
async function reload() {
  await Promise.all([loadAiPolicy(true), load()]);
}
</script>

<template>
  <div class="stack">
    <HelpText lead>先定每一类运行能用哪些 AI、哪些一定不用，再在这个范围里自动挑或按先后用。没写规则的类别照旧从全部 AI 里选；总体偏好在“通用 → 任务选型”。</HelpText>
    <SetGate v-if="!aiPolicy.missing" :keys="['agents']" owner>
      <SetCard id="set-ai-say" title="用一句话改">
        <template #help>说想要的效果，强组的 AI 对上现有的类别、组和后端起草改动，你在卡片上确认后才保存，原话记在规则上。</template>
        <div class="set-pad"><AiPolicyPropose @changed="reload" /></div>
      </SetCard>
    </SetGate>

    <section v-if="aiPolicy.missing" class="card set-card"><p class="set-link muted">这台 omem 还没有 AI 规则，更新以后再来。</p></section>
    <section v-else-if="aiPolicy.error && !view" class="card set-card"><p class="set-link" role="alert"><span class="grow">读不到 AI 规则：{{ aiPolicy.error }}</span><button class="btn sm" @click="reload">重试</button></p></section>
    <section v-else-if="!view" class="card set-card"><div class="set-pad"><Skeleton variant="list" :rows="6" /></div></section>
    <template v-else>
      <AiClassRules :view="view" :groups="groups" :backends="profiles" :agents="config.agents" @saved="reload" />
      <AiGroups :view="view" :initial="groups" :old-settings="oldSettings" :backends="profiles" @saved="reload" />
    </template>
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
  min-width: 0;
}
</style>
