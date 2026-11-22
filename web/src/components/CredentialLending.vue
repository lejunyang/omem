<script setup lang="ts">
import { computed } from "vue";
import { useSettings } from "../views/settings/ctx";
import { settingsKey } from "../lib/caps";
import { ACCOUNTS_DEFAULT, LENDING, type AccountsDefault, type Lending } from "../lib/credentials";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * 设置 → 安全 → 凭据的出借 (docs/v2/credentials.md “接口和设置”): how members' credentials are lent
 * (`credentials.lending`), whether the owner's identity may pull a holder into the asking group
 * (`credentials.confirm.inviteAsOwner`), and what a member's run does on a backend they have not logged
 * in to (`agents.accountsDefault`; per backend in 设置 → 成员 → 成员的 AI 账号). Only the owner changes
 * them; whoever may see the security area gets the same card read-only (SetCard `keys`).
 */
const KEYS = ["credentials", "agents.accountsDefault"];
const { config, ownerName, saveConfig } = useSettings();
/** The server leaves out what only the owner changes when it answers someone else: then the values are not known. */
const cred = computed<{ lending: Lending; confirm: { inviteAsOwner: boolean } } | null>(() => config.value?.credentials ?? null);
const accountsDefault = computed<AccountsDefault | null>(() => config.value?.agents?.accountsDefault ?? null);
const lendingHint = computed(() => LENDING.find((l) => l.value === cred.value?.lending)?.hint ?? "");
const defaultHint = computed(() => ACCOUNTS_DEFAULT.find((a) => a.value === accountsDefault.value)?.hint ?? "");
/** The owner without the values: a server older than credentials, so no card. */
const shown = computed(() => !!cred.value || !settingsKey("credentials").edit);

function setLending(v: Lending) {
  if (!cred.value) return;
  void saveConfig({ credentials: { ...cred.value, lending: v } }, `凭据的出借：${LENDING.find((l) => l.value === v)?.label}`);
}
function setInvite(on: boolean) {
  if (!cred.value) return;
  void saveConfig({ credentials: { ...cred.value, confirm: { ...cred.value.confirm, inviteAsOwner: on } } }, on ? "已打开：拉不进群时用你的身份拉持有人" : "已关闭：只用机器人拉人进群");
}
function setDefault(v: AccountsDefault) {
  void saveConfig({ agents: { accountsDefault: v } }, `成员没登录时：${ACCOUNTS_DEFAULT.find((a) => a.value === v)?.label}`);
}
</script>

<template>
  <SetCard v-if="shown" id="set-credentials" title="凭据的出借" :keys="KEYS">
    <template #help>成员在账号页登录的凭据可以借给同事用，借给谁由各人自己定；这里定借不借、怎么借，以及成员自己没登录 AI 后端时怎么办。</template>
    <p v-if="!cred" class="set-pad small muted">现在的设置只有{{ ownerName }}能看。</p>
    <template v-else>
      <SetRow label="出借方式" :hint="lendingHint">
        <UiSegmented :model-value="cred.lending" size="sm" aria-label="凭据的出借方式" :options="LENDING.map((l) => ({ value: l.value, label: l.label, title: l.hint }))" @change="setLending" />
      </SetRow>
      <SetRow label="拉持有人进群" hint="持有人不在提问的群里、机器人又拉不进来时，用你的身份把他拉进群" :off="cred.lending === 'off'">
        <UiCheckbox :model-value="cred.confirm.inviteAsOwner" switch size="sm" :disabled="cred.lending === 'off'" aria-label="用你的身份拉持有人进群" @change="setInvite" />
      </SetRow>
    </template>
    <SetRow v-if="accountsDefault" label="成员没登录 AI 后端时" :hint="defaultHint">
      <UiSegmented :model-value="accountsDefault" size="sm" aria-label="成员没登录 AI 后端时" :options="ACCOUNTS_DEFAULT.map((a) => ({ value: a.value, label: a.label, title: a.hint }))" @change="setDefault" />
    </SetRow>
    <div class="set-link">
      <span>这是默认做法，逐个后端在</span>
      <RouterLink to="/settings?card=agent-accounts">成员 → 成员的 AI 账号</RouterLink>
      <span>里设。</span>
    </div>
  </SetCard>
</template>
