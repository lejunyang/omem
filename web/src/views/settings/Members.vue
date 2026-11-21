<script setup lang="ts">
import { computed } from "vue";
import { useSettings } from "./ctx";
import AgentAccountsAdmin from "../../components/AgentAccountsAdmin.vue";
import MembersSettings from "../../components/MembersSettings.vue";

/** 设置 → 渠道与协作 → 成员: who can log in and how, everyone's roles and spaces, and the members' own AI accounts. */
const { config, profiles, saveConfig } = useSettings();
const names = computed(() => Object.fromEntries(profiles.value.map((p) => [p.id, p.name ?? p.id])));
async function saveIsolation(mode: "prefer" | "require") {
  if (!config.value) return;
  await saveConfig({ agents: { ...config.value.agents, accountIsolation: mode } }, mode === "require" ? "成员的运行不能隔离时不再启动" : "成员的运行不能隔离时照常运行并记一笔");
}
</script>

<template>
  <MembersSettings>
    <template #after-members>
      <AgentAccountsAdmin :names="names" @policies="(v) => config && (config.agents.accounts = v)" @mode="saveIsolation" />
    </template>
  </MembersSettings>
</template>
