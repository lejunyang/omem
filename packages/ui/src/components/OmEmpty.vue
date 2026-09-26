<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>
<template>
  <div class="om-empty">
    <h2>{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
    <slot />
  </div>
</template>
<style scoped>
.om-empty {
  padding: 48px 24px;
  text-align: center;
  color: var(--om-secondary);
}
.om-empty h2 {
  color: var(--om-ink);
}
.om-empty p {
  max-width: 480px;
  margin: 0 auto 24px;
}
</style>
