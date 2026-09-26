<script setup lang="ts">
defineProps<{ label: string; version?: number }>();
defineEmits<{ open: [] }>();
</script>
<template>
  <button class="om-citation" @click="$emit('open')">
    {{ label }}<sup>{{ version ? "v" + version : "↗" }}</sup>
  </button>
</template>
<style scoped>
.om-citation {
  border: 0;
  border-bottom: 1px solid #888;
  background: var(--om-soft);
  color: var(--om-ink);
  padding: 3px 6px;
  border-radius: 3px;
  text-align: left;
  line-height: 1.8;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.om-citation:hover {
  background: #ddd;
}
sup {
  font-size: 10px;
  margin-left: 6px;
}
</style>
