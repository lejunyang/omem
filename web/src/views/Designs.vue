<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, type Item } from "../api";
import DesignRow from "../components/DesignRow.vue";
import DesignStart from "../components/DesignStart.vue";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import VirtualList from "../components/VirtualList.vue";
import type { DesignOrigin, DesignSummary } from "../lib/designs";
import { state } from "../store";

/**
 * #/designs — every design the person may read, newest first (docs/v2/coding-plan.md §5): own designs,
 * someone else's assessed ones, and the change descriptions written after coding. Reached from the
 * run page's 编码 view; not in the main menu.
 */
const designs = ref<DesignSummary[]>([]);
const loading = ref(true);
const origin = ref<DesignOrigin | "">("");
const space = ref<string>("");
const starting = ref(false);
const items = ref<Map<string, string>>(new Map());
let seq = 0;
async function load() {
  const my = ++seq;
  try {
    const r = await get<{ designs: DesignSummary[] }>(`/api/designs?limit=500${space.value ? `&space=${encodeURIComponent(space.value)}` : ""}`);
    if (my !== seq) return;
    designs.value = r.designs;
    // The items they hang on, for their titles.
    if (r.designs.some((d) => d.itemId && !items.value.has(d.itemId))) {
      const list = await get<Item[]>("/api/items?status=all").catch(() => [] as Item[]);
      if (my === seq) items.value = new Map(list.map((i) => [i.id, i.title]));
    }
  } catch {
    if (my === seq) designs.value = [];
  } finally {
    if (my === seq) loading.value = false;
  }
}
watch(space, () => { loading.value = true; void load(); }, { immediate: true });
let timer: ReturnType<typeof setTimeout> | undefined;
const off = onServerEvent((e) => {
  if ((e.type === "run" && e.status !== "running") || (e.type === "changed" && (e as { entity?: string }).entity === "design")) {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 800);
  }
});
onBeforeUnmount(() => { ++seq; off(); clearTimeout(timer); });

const shown = computed(() => (origin.value ? designs.value.filter((d) => d.origin === origin.value) : designs.value));
const originOptions = [{ value: "" as const, label: "全部" }, { value: "own" as const, label: "自己的" }, { value: "external" as const, label: "别人的" }, { value: "derived" as const, label: "变更说明" }];
const spaceOptions = computed(() => [{ value: "", label: "所有空间" }, ...state.spaces.filter((s) => s.kind !== "worktree").map((s) => ({ value: s.id, label: s.name, indent: !!s.parentId }))]);
const itemOf = (d: DesignSummary) => (d.itemId ? { id: d.itemId, title: items.value.get(d.itemId) ?? d.itemId } : null);
</script>

<template>
  <div class="designs-page">
    <header class="row wrap head">
      <h1>方案</h1>
      <span class="spacer" />
      <button class="btn sm primary" @click="starting = true"><Icon name="plus" :size="14" />跟进一份技术方案</button>
    </header>
    <p class="muted small intro">自己交办前写的方案、跟进的别人的技术方案、编码后的变更说明都在这里。交办里的方案也在那次交办的“方案”标签里。</p>
    <div class="row wrap filters">
      <UiSegmented v-model="origin" size="sm" :options="originOptions" aria-label="来历" />
      <UiSelect v-model="space" size="sm" width="200px" :options="spaceOptions" :search-at="8" aria-label="空间" />
      <span class="muted small">{{ shown.length }} 份</span>
    </div>
    <Skeleton v-if="loading && !designs.length" :rows="6" />
    <p v-else-if="!shown.length" class="empty muted small">{{ designs.length ? "没有这一类的方案。" : "还没有方案。交办时助手会按需要先写方案；别人写的技术方案可以点“跟进一份技术方案”。" }}</p>
    <div v-else class="list card">
      <VirtualList :items="shown" :item-key="(d) => d.id" :estimate="64">
        <template #default="{ item: d }">
          <DesignRow :design="d" :item="itemOf(d)" :show-space="!space" />
        </template>
      </VirtualList>
    </div>
    <DesignStart v-if="starting" @close="starting = false" />
  </div>
</template>

<style scoped>
.designs-page { max-width: 960px; margin: 0 auto; padding: 20px 24px 40px; display: grid; gap: 12px; min-width: 0; }
.head h1 { margin: 0; font-family: var(--serif); font-size: 22px; }
.intro { margin: 0; }
.filters { gap: 8px; }
.list { padding: 4px; min-width: 0; }
.empty { padding: 14px; border: 1px dashed var(--line-strong); border-radius: var(--radius); margin: 0; }
@media (max-width: 760px) { .designs-page { padding: 14px 12px 32px; } }
</style>
