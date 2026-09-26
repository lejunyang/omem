<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { headers } from "./api";
const props = defineProps<{ id: string; label: string }>();
const url = ref("");
const error = ref("");
let controller: AbortController | undefined;
watch(
  () => props.id,
  async (id) => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    if (url.value) URL.revokeObjectURL(url.value);
    url.value = "";
    error.value = "";
    try {
      const r = await fetch("/api/assets/" + id, {
        headers: headers(),
        signal,
      });
      if (!r.ok) throw Error("图片读取失败");
      const blob = await r.blob();
      if (!signal.aborted) url.value = URL.createObjectURL(blob);
    } catch (e) {
      if (!signal.aborted) error.value = String(e);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  controller?.abort();
  if (url.value) URL.revokeObjectURL(url.value);
});
</script>
<template>
  <figure>
    <img v-if="url" :src="url" :alt="label" />
    <p v-if="error" role="alert">{{ error }}</p>
    <figcaption>{{ label }}</figcaption>
  </figure>
</template>
<style scoped>
figure {
  margin: 20px 0;
}
img {
  display: block;
  max-width: 100%;
  max-height: 450px;
  border: 1px solid var(--om-line);
  border-radius: 6px;
}
figcaption {
  font-size: 12px;
  color: var(--om-muted);
}
</style>
