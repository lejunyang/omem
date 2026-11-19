<script setup lang="ts">
import { openImages } from "../lib/image-preview";

/**
 * Screenshots as a grid of small tiles (the top of each, where a page starts), caption under each:
 * a write-up stays readable with many of them, and a click opens all of them in the preview.
 */
type Shot = { id: string; url: string; name: string; caption: string };
const props = defineProps<{ items: Shot[] }>();
const label = (a: Shot) => a.caption || a.name;
const show = (i: number) => openImages(props.items.map((a) => ({ url: a.url, name: a.name, caption: a.caption })), i);
</script>

<template>
  <ul class="shots" :class="{ one: items.length === 1 }">
    <li v-for="(a, i) in items" :key="a.id" class="shot">
      <button type="button" class="thumb" :aria-label="`放大看：${label(a)}`" @click="show(i)">
        <img :src="a.url" :alt="label(a)" loading="lazy" />
      </button>
      <span class="cap" :title="label(a)">{{ label(a) }}</span>
    </li>
  </ul>
</template>

<style scoped>
.shots { list-style: none; padding: 0; margin: 12px 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px 10px; }
.shots.one { grid-template-columns: minmax(0, 320px); }
.shot { display: grid; gap: 4px; min-width: 0; align-content: start; }
.thumb { display: block; width: 100%; aspect-ratio: 4 / 3; padding: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--sunken); cursor: zoom-in; }
.thumb:hover { border-color: var(--line-strong); }
.thumb:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.cap { font-size: 12.5px; line-height: 1.45; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .shots { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .shots.one { grid-template-columns: minmax(0, 1fr); }
}
</style>
