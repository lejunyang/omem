<script setup lang="ts">
import { computed, inject, type ShallowRef } from "vue";
import type { Omem } from "@omem-ai/plugin-sdk";
import type { Material } from "./types";

/** "出自《…》": the source a question, expression or scene was drawn from; opens those lines in omem's source view. */
const props = defineProps<{ material: Material }>();
const api = inject<ShallowRef<Omem | null>>("omem");
const at = computed(() => /^src:([\w-]+)#L(\d+)(?:-L(\d+))?$/.exec(props.material.ref));
function go() {
  const m = at.value;
  if (m) api?.value?.navigate(`/sources/${encodeURIComponent(m[1])}?from=${m[2]}&to=${m[3] ?? m[2]}`);
}
</script>

<template>
  <span class="material small muted">
    出自
    <button v-if="at && api" type="button" class="linkish" :title="material.summary" @click="go">{{ material.title || "原件" }}</button>
    <span v-else :title="material.summary">{{ material.title || "原件" }}</span>
  </span>
</template>

<style scoped>
.material {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: baseline;
  min-width: 0;
  overflow-wrap: anywhere;
}
.linkish {
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.linkish:hover {
  text-decoration: underline;
}
</style>
