<script setup lang="ts">
import { ICONS } from "../lib/icons";

/** A named line icon (lib/icons.ts), or an SVG file's URL (a plugin's own icon), drawn in currentColor. */
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
</script>

<template>
  <span v-if="props.name.includes('/')" class="icon mask" :style="{ width: `${props.size}px`, height: `${props.size}px`, maskImage: `url(${JSON.stringify(props.name)})` }" aria-hidden="true" />
  <svg v-else :width="props.size" :height="props.size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon">
    <path :d="ICONS[props.name] ?? ICONS.file" />
  </svg>
</template>

<style scoped>
.icon {
  flex: none;
}
.mask {
  display: inline-block;
  background: currentColor;
  mask: no-repeat center / contain;
  -webkit-mask: no-repeat center / contain;
}
</style>
