<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { closePreview, preview } from "../lib/image-preview";
import Icon from "./Icon.vue";

/**
 * The picture preview over the current page (lib/image-preview.ts opens it): one picture fitted to
 * the window, ← → or the side buttons go through the rest, Esc or a click outside closes and gives
 * focus back. Clicking the picture shows it at its own size (scroll to read a long screenshot).
 */
const box = ref<HTMLElement>();
const actual = ref(false);
const open = computed(() => preview.index >= 0 && !!preview.list[preview.index]);
const cur = computed(() => preview.list[preview.index]);
const many = computed(() => preview.list.length > 1);

watch(open, async (v) => {
  if (!v) return;
  await nextTick();
  box.value?.focus();
});
watch(() => preview.index, () => (actual.value = false));

function step(d: number) {
  const n = preview.list.length;
  if (n > 1) preview.index = (preview.index + d + n) % n;
}
function key(e: KeyboardEvent) {
  if (e.key === "Escape") { e.stopPropagation(); closePreview(); }
  else if (e.key === "ArrowRight") step(1);
  else if (e.key === "ArrowLeft") step(-1);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open && cur" ref="box" class="preview" role="dialog" aria-modal="true" :aria-label="cur.caption || cur.name || '图片预览'" tabindex="-1" @keydown="key">
      <div class="bar">
        <span v-if="many" class="count small muted">{{ preview.index + 1 }} / {{ preview.list.length }}</span>
        <span class="title small" :title="cur.caption || cur.name">{{ cur.name && cur.caption ? `${cur.name} · ` : "" }}{{ cur.caption || cur.name }}</span>
        <span class="spacer" />
        <button type="button" class="btn ghost sm" :aria-pressed="actual" @click="actual = !actual">{{ actual ? "适应窗口" : "原始大小" }}</button>
        <a class="btn ghost sm" :href="cur.url" target="_blank" rel="noopener noreferrer"><Icon name="external" :size="14" />新标签</a>
        <button type="button" class="btn ghost sm icon" aria-label="关闭" @click="closePreview"><Icon name="x" :size="16" /></button>
      </div>
      <div class="stage" :class="{ actual }" @click.self="closePreview">
        <img :key="cur.url" :src="cur.url" :alt="cur.caption || cur.name || ''" @click="actual = !actual" />
        <button v-if="many" type="button" class="nav prev" aria-label="上一张" @click="step(-1)"><Icon name="left" :size="22" /></button>
        <button v-if="many" type="button" class="nav next" aria-label="下一张" @click="step(1)"><Icon name="right" :size="22" /></button>
      </div>
      <div v-if="many" class="strip" aria-label="全部图片">
        <button v-for="(p, i) in preview.list" :key="`${i}-${p.url}`" type="button" class="thumb" :class="{ on: i === preview.index }" :aria-label="`第 ${i + 1} 张${p.caption ? `：${p.caption}` : ''}`" :aria-current="i === preview.index" @click="preview.index = i">
          <img :src="p.url" alt="" loading="lazy" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.preview { position: fixed; inset: 0; z-index: 80; display: grid; grid-template-rows: auto 1fr auto; background: rgb(12 12 14 / .94); outline: none; }
.bar { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }
.count { flex: none; font-variant-numeric: tabular-nums; }
.title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stage { position: relative; display: grid; place-items: center; min-height: 0; padding: 16px 64px; overflow: hidden; }
.stage img { max-width: 100%; max-height: 100%; object-fit: contain; background: var(--panel); box-shadow: 0 8px 40px rgb(0 0 0 / .45); border-radius: 4px; cursor: zoom-in; }
.stage.actual { overflow: auto; place-items: start center; }
.stage.actual img { max-width: none; max-height: none; cursor: zoom-out; }
.nav { position: fixed; top: 50%; transform: translateY(-50%); width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); color: var(--ink); display: grid; place-items: center; cursor: pointer; box-shadow: var(--shadow); }
.nav:hover { border-color: var(--line-strong); }
.nav:focus-visible, .thumb:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.prev { left: 12px; }
.next { right: 12px; }
.strip { display: flex; gap: 6px; padding: 8px 14px; overflow-x: auto; border-top: 1px solid var(--line); background: var(--panel); }
.thumb { flex: none; width: 64px; height: 44px; padding: 0; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; background: var(--sunken); cursor: pointer; opacity: .65; }
.thumb.on { opacity: 1; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
@media (max-width: 760px) {
  .stage { padding: 8px 8px 56px; }
  .nav { top: auto; bottom: 64px; transform: none; }
}
</style>
