<script setup lang="ts">
defineProps<{ title?: string }>();
</script>
<template>
  <section class="om-panel">
    <header v-if="title || $slots.heading">
      <h3 v-if="title">{{ title }}</h3>
      <slot name="heading" />
    </header>
    <div class="panel-content"><slot /></div>
    <footer v-if="$slots.actions"><slot name="actions" /></footer>
  </section>
</template>
<style scoped>
.om-panel {
  padding: 24px;
  border: 1px solid var(--om-line);
  background: var(--om-panel);
  border-radius: var(--om-radius);
  min-width: 0;
}
.panel-content {
  display: grid;
  justify-items: start;
  gap: 16px;
  min-width: 0;
}
.panel-content :deep(> *) {
  min-width: 0;
  margin-block: 0;
}
.panel-content :deep(> :not(.om-badge):not(.om-button):not(.om-citation)) {
  width: 100%;
}
header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
h3 {
  margin: 0;
  font-size: 16px;
}
footer {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 24px;
}
@media (max-width: 700px) {
  .om-panel {
    padding: 20px 16px;
  }
}
</style>
