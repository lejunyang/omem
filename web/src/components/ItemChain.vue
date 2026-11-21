<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, onServerResync } from "../api";
import { chainEmpty, chainRoute, chainSummary, connected, SEGMENTS, type ChainEntry, type ChainGroup, type ItemChain } from "../lib/chain";
import Icon from "./Icon.vue";

/**
 * 需求 → 发现 → 方案 → 交付 on a work item (GET /api/items/:id/chain): what is linked already, read
 * only. One line of counts until opened; opened, four columns of compact rows, each going to its own
 * page. Pointing at a row (or focusing it) lights what it is linked to along the chain. Not shown at all
 * when nothing is linked.
 */
const props = defineProps<{ itemId: string }>();
const chain = ref<ItemChain | null>(null);
const open = ref(false);
/** The row pointed at: its group and key. */
const hover = ref<{ group: number; key: string } | null>(null);
let seq = 0;

async function load() {
  const request = ++seq, id = props.itemId;
  try {
    const c = await get<ItemChain>(`/api/items/${encodeURIComponent(id)}/chain`);
    if (request === seq && id === props.itemId) chain.value = c;
  } catch {
    // Not part of what the page needs: on an error the block stays away.
    if (request === seq) chain.value = null;
  }
}
watch(() => props.itemId, () => { ++seq; chain.value = null; hover.value = null; open.value = false; void load(); }, { immediate: true });
const off = onServerEvent((e) => { if (e.type === "changed" && e.entity === "item" && e.id === props.itemId) void load(); });
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++seq; off(); resync(); });

const summary = computed(() => (chain.value ? chainSummary(chain.value.counts) : ""));
const lit = computed(() => {
  const h = hover.value, c = chain.value;
  return h && c?.groups[h.group] ? connected(c.groups[h.group], h.key) : null;
});
const rowsOf = (g: ChainGroup, key: (typeof SEGMENTS)[number]["key"]): ChainEntry[] => g[key];
const point = (group: number, e: ChainEntry | null) => { hover.value = e ? { group, key: e.key } : null; };
const state = (gi: number, e: ChainEntry) => (!lit.value || hover.value?.group !== gi ? "" : lit.value.has(e.key) ? "lit" : "dim");
</script>

<template>
  <section v-if="!chainEmpty(chain)" class="item-chain" aria-label="需求到交付">
    <button type="button" class="chain-sum" :aria-expanded="open" aria-controls="item-chain-body" @click="open = !open">
      <span class="chain-label">需求到交付</span>
      <span class="chain-text">{{ summary }}</span>
      <Icon :name="open ? 'down' : 'right'" :size="14" />
    </button>
    <div v-if="open && chain" id="item-chain-body" class="chain-body">
      <div v-for="(g, gi) in chain.groups" :key="g.item.id" class="chain-group">
        <router-link v-if="chain.line" :to="`/work/${g.item.id}`" class="chain-gtitle">{{ g.item.title }}</router-link>
        <div class="chain-cols">
          <div v-for="s in SEGMENTS" :key="s.key" class="chain-col">
            <div class="chain-h">{{ s.label }}<span class="chain-n">{{ rowsOf(g, s.key).length }}</span></div>
            <p v-if="!rowsOf(g, s.key).length" class="chain-none">还没有</p>
            <ul v-else class="chain-rows" :aria-label="s.label">
              <li v-for="e in rowsOf(g, s.key)" :key="e.key">
                <component
                  :is="chainRoute(e.href) ? 'router-link' : 'a'"
                  v-bind="chainRoute(e.href) ? { to: chainRoute(e.href) } : { href: e.href, target: '_blank', rel: 'noopener noreferrer' }"
                  class="chain-row" :class="state(gi, e)"
                  @mouseenter="point(gi, e)" @mouseleave="point(gi, null)" @focus="point(gi, e)" @blur="point(gi, null)"
                >
                  <span class="chain-title" :title="e.title">{{ e.title }}</span>
                  <span class="badge chain-status" :class="e.cls">{{ e.status }}</span>
                  <span v-if="e.now" class="chain-now" :title="e.now">{{ e.now }}</span>
                </component>
              </li>
            </ul>
          </div>
        </div>
        <p v-if="g.more" class="chain-more">每段只列前几条，另有 {{ g.more }} 条在各自的页面上。</p>
      </div>
      <p v-if="chain.moreGroups" class="chain-more">另有 {{ chain.moreGroups }} 个工作项也有关联，打开它们看。</p>
    </div>
  </section>
</template>

<style scoped>
.item-chain { display: grid; gap: 8px; min-width: 0; }
/* Collapsed: one line, the counts. */
.chain-sum { display: flex; align-items: baseline; gap: 8px; width: 100%; min-width: 0; padding: 8px 0; border: 0; border-top: 1px solid var(--line); background: none; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.chain-sum:hover .chain-text { color: var(--ink); }
.chain-sum :deep(svg) { flex: none; align-self: center; color: var(--muted); }
.chain-label { flex: none; font-size: 13px; font-weight: 650; }
.chain-text { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chain-body { display: grid; gap: 16px; }
.chain-group { display: grid; gap: 8px; min-width: 0; }
.chain-gtitle { font-size: 13px; font-weight: 650; color: var(--ink); }
/* Four columns side by side, left to right as the work goes; one column on a narrow screen. */
.chain-cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.chain-col { display: grid; align-content: start; gap: 4px; min-width: 0; }
.chain-h { display: flex; align-items: baseline; gap: 4px; font-size: 12px; color: var(--muted); padding-bottom: 4px; border-bottom: 1px solid var(--line); }
.chain-n { font-variant-numeric: tabular-nums; }
.chain-none { margin: 0; font-size: 12px; color: var(--muted); }
.chain-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.chain-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 0 8px; padding: 4px 0; border-radius: 4px; color: var(--ink); text-decoration: none; transition: opacity 0.12s; }
.chain-row:hover .chain-title, .chain-row:focus-visible .chain-title { text-decoration: underline; }
.chain-row.lit { box-shadow: -4px 0 0 0 var(--accent-soft), 4px 0 0 0 var(--accent-soft); background: var(--accent-soft); }
.chain-row.dim { opacity: 0.45; }
.chain-title { min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chain-status { flex: none; }
.chain-now { grid-column: 1 / -1; min-width: 0; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chain-more { margin: 0; font-size: 12px; color: var(--muted); }
@media (max-width: 760px) {
  .chain-cols { grid-template-columns: minmax(0, 1fr); gap: 12px; }
}
@media (prefers-reduced-motion: reduce) { .chain-row { transition: none; } }
</style>
