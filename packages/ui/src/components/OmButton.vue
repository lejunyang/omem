<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost";
    loading?: boolean;
    disabled?: boolean;
    type?: "button" | "submit";
  }>(),
  { variant: "secondary", type: "button" },
);
</script>
<template>
  <button
    :type="type"
    class="om-button"
    :class="variant"
    :disabled="disabled || loading"
    :aria-busy="loading"
  >
    <span v-if="loading" aria-hidden="true">◌</span><slot />
  </button>
</template>
<style scoped>
.om-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid var(--om-line);
  background: var(--om-panel);
  color: var(--om-ink);
  font-size: 13px;
}
.om-button:hover {
  background: var(--om-soft);
}
.primary {
  background: var(--om-ink);
  color: white;
  border-color: var(--om-ink);
}
.primary:hover {
  background: #444;
}
.ghost {
  background: transparent;
  border-color: transparent;
}
</style>
