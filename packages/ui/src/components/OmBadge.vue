<script setup lang="ts">
withDefaults(
  defineProps<{ tone?: "neutral" | "warning" | "danger" | "success" }>(),
  { tone: "neutral" },
);
</script>
<template>
  <span class="om-badge" :class="tone"><slot /></span>
</template>
<style scoped>
.om-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--om-line);
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--om-secondary);
  white-space: nowrap;
}
.warning {
  color: var(--om-warning);
  background: #f6f2e8;
}
.danger {
  color: var(--om-danger);
  background: #fff0f0;
}
.success {
  color: #385f49;
  background: #f1f6f2;
}
</style>
