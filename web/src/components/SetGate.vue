<script setup lang="ts">
import { hasPerm } from "../lib/caps";
import { useSetAccess } from "../lib/set-readonly";

/**
 * Around a settings component that is not one SetCard (a list with its own cards, an older card):
 * shown when any of `keys` may be seen (lib/caps.ts `settingsCard`), its SetRows read-only and the rest
 * out of reach when they may only be read. `owner`: what it shows comes from interfaces that answer the
 * owner (or the old `settings.manage`) only, so nobody else gets it.
 */
const props = defineProps<{ keys: string[]; owner?: boolean }>();
const { access, readonly } = useSetAccess(() => props.keys);
</script>

<template>
  <div v-if="access.view && (!owner || hasPerm('settings.manage'))" class="set-gate" :inert="readonly || undefined"><slot /></div>
</template>

<style scoped>
.set-gate {
  display: contents;
}
</style>
