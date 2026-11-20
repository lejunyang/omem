<script setup lang="ts">
import { useSettings } from "./ctx";
import AgentAccountsAdmin from "../../components/AgentAccountsAdmin.vue";
import MembersSettings from "../../components/MembersSettings.vue";

/** 设置 → 渠道与协作 → 成员: who can log in and how, everyone's roles and spaces, and the members' own AI accounts. */
const { config } = useSettings();
</script>

<template>
  <MembersSettings>
    <template #after-members>
      <AgentAccountsAdmin @policies="(v) => config && (config.agents.accounts = v)" />
    </template>
  </MembersSettings>
</template>
