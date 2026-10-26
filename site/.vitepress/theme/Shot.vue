<script setup lang="ts">
import { withBase } from "vitepress";

/** A screenshot of the app (public/screens/<src>.png, made by scripts/doc-screens.ts), with an optional caption. */
const props = defineProps<{ src: string; caption?: string; phone?: boolean }>();
const url = withBase(`/screens/${props.src}.png`);
</script>

<template>
  <figure class="shot" :class="{ phone }">
    <a :href="url" target="_blank" rel="noopener"><img :src="url" :alt="caption ?? src" loading="lazy" /></a>
    <figcaption v-if="caption">{{ caption }}</figcaption>
  </figure>
</template>
