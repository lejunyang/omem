<script setup lang="ts">
import { computed, inject } from "vue";
import { settingsCard } from "../lib/caps";
import { SET_READONLY } from "../lib/set-readonly";
import { settingsContext } from "../views/settings/ctx";

/**
 * One setting (styles.css `.set-row`): its name (14px) and at most one sentence (13px, grey) on the
 * left, the control on the right. `block`: text and lists that take several lines go under the name.
 * `off`: the setting does nothing right now (its switch above is off); the name greys out.
 * `keys`: a row whose key is in another area than its card's decides for itself (lib/caps.ts); without
 * them it follows its card. A read-only row keeps its control in sight but out of reach (`inert`).
 */
const props = defineProps<{ label?: string; hint?: string; block?: boolean; off?: boolean; keys?: string[] }>();
const card = inject(SET_READONLY, null);
const own = computed(() => (props.keys?.length ? settingsCard(props.keys) : null));
const shown = computed(() => own.value?.view ?? true);
const readonly = computed(() => (own.value ? !own.value.edit : !!card?.value));
/** A row of the owner's own inside a card this person may change: it says whose it is (the card cannot). */
const ownerOnly = computed(() => !!own.value?.ownerOnly && readonly.value && !card?.value);
const ctx = settingsContext();
</script>

<template>
  <div v-if="shown" class="set-row" :class="{ block, off }">
    <div class="set-row-text">
      <div class="set-row-label"><slot name="label">{{ label }}</slot></div>
      <div v-if="hint || $slots.hint" class="set-row-hint"><slot name="hint">{{ hint }}</slot></div>
      <div v-if="ownerOnly" class="set-row-hint">只有{{ ctx?.ownerName.value ?? "主人" }}能改</div>
    </div>
    <div class="set-row-ctl" :class="{ ro: readonly }" :inert="readonly || undefined"><slot /></div>
  </div>
</template>
