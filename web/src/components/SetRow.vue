<script setup lang="ts">
/**
 * One setting (styles.css `.set-row`): its name (14px) and at most one sentence (13px, grey) on the
 * left, the control on the right. `block`: text and lists that take several lines go under the name.
 * `off`: the setting does nothing right now (its switch above is off); the name greys out.
 */
defineProps<{ label?: string; hint?: string; block?: boolean; off?: boolean }>();
</script>

<template>
  <div class="set-row" :class="{ block, off }">
    <div class="set-row-text">
      <div class="set-row-label"><slot name="label">{{ label }}</slot></div>
      <div v-if="hint || $slots.hint" class="set-row-hint"><slot name="hint">{{ hint }}</slot></div>
    </div>
    <div class="set-row-ctl"><slot /></div>
  </div>
</template>
