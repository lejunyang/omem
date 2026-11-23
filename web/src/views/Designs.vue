<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, type Item } from "../api";
import CodeTabs from "../components/CodeTabs.vue";
import DesignRow from "../components/DesignRow.vue";
import DesignStart from "../components/DesignStart.vue";
import DesignView from "../components/DesignView.vue";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import VirtualList from "../components/VirtualList.vue";
import type { DesignOrigin, DesignSummary } from "../lib/designs";
import { pageParam } from "../lib/route";
import { state } from "../store";

/**
 * 编码 → 方案 (docs/v2/coding-plan.md §5): every design the person may read, newest first — own
 * designs, someone else's assessed ones, and the change descriptions written after coding — with the
 * one opened beside the list (`/code/designs/<id>`, DesignView).
 */
const id = pageParam("/code/designs/:id?");
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
  <div class="designs">
    <aside class="list-col">
      <div class="head">
        <div class="row top"><CodeTabs current="designs" /><span class="spacer" /><button class="btn ghost sm icon" title="跟进一份技术方案" aria-label="跟进一份技术方案" @click="starting = true"><Icon name="plus" :size="15" /></button></div>
        <UiSegmented v-model="origin" size="sm" :options="originOptions" aria-label="来历" />
        <div class="row filter">
          <UiSelect v-model="space" size="sm" width="180px" :options="spaceOptions" :search-at="8" aria-label="空间" />
          <span class="muted small">{{ shown.length }} 份</span>
        </div>
      </div>
      <div class="items">
        <Skeleton v-if="loading && !designs.length" :rows="6" />
        <p v-else-if="!shown.length" class="muted small none">{{ designs.length ? "没有这一类的方案。" : "还没有方案。交办时助手会按需要先写方案；别人写的技术方案点右上角的 + 跟进。" }}</p>
        <VirtualList v-else :items="shown" :item-key="(d) => d.id" :estimate="64">
          <template #default="{ item: d }">
            <DesignRow :design="d" :item="itemOf(d)" :show-space="!space" :active="d.id === id" />
          </template>
        </VirtualList>
      </div>
    </aside>
    <main class="detail">
      <DesignView v-if="id" :key="id" :design-id="id" />
      <div v-else class="empty">
        <Icon name="layers" :size="34" />
        <h3>方案</h3>
        <p>自己交办前写的方案、跟进的别人的技术方案、编码后的变更说明都在这里。交办里用到的方案也在那次交办的“方案”标签里。</p>
        <button class="btn primary sm" @click="starting = true"><Icon name="plus" :size="14" />跟进一份技术方案</button>
      </div>
    </main>
    <DesignStart v-if="starting" @close="starting = false" />
  </div>
</template>

<style scoped>
.designs {
  display: flex;
  height: 100%;
}
.list-col {
  width: 320px;
  flex: none;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 8px;
  justify-items: start;
}
.head .top,
.head .filter {
  width: 100%;
  gap: 8px;
}
.items {
  overflow-y: auto;
  padding: 6px;
  flex: 1;
  min-height: 0;
}
.none {
  padding: 10px;
  margin: 0;
}
.detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 28px 48px;
}
@media (max-width: 760px) {
  .designs {
    flex-direction: column;
  }
  .list-col {
    width: 100%;
    max-height: 36vh;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .detail {
    padding: 14px 12px 32px;
  }
}
</style>
