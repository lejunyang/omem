<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CodeTabs from "../components/CodeTabs.vue";
import CodeWork, { type WorkTab } from "../components/CodeWork.vue";
import CodeWorkList from "../components/CodeWorkList.vue";
import DelegateDialog from "../components/DelegateDialog.vue";
import Icon from "../components/Icon.vue";
import UiSegmented from "../components/UiSegmented.vue";
import { hasPerm } from "../lib/caps";
import { pageParam } from "../lib/route";
import { state } from "../store";

/**
 * 编码 → 交办 (docs/v2/coding-work.md): every delegation and branch review, one row each grouped by
 * whom it waits on (CodeWorkList), and the one opened (CodeWork). `/code/<run>` is any round of it;
 * a run that is not coding work goes to the run page. The tab of the open work is `?tab=`.
 */
const route = useRoute();
const router = useRouter();
const id = pageParam("/code/:id?");
const keyword = ref("");
const scope = ref<"space" | "all">("space");
/** 交办 hands work to the coding Agent on this machine: the owner, or someone given 交办编码. */
const mayDelegate = computed(() => hasPerm("code.delegate"));
const delegateOpen = ref(false);

// One CodeWork per work: another round of the same work (picked in its activity, or just started from
// it) keeps the view and its state; another work starts afresh.
const rounds = ref(new Set<string>());
const workKey = ref(id.value);
/** The open work's first round: its row in the list. */
const root = ref<string | null>(null);
watch(id, (v) => {
  if (rounds.value.has(v)) return;
  workKey.value = v;
  root.value = null;
});
function onLoaded(rootId: string, ids: string[]) {
  root.value = rootId;
  rounds.value = new Set(ids);
}
function openRound(runId: string) {
  rounds.value = new Set([...rounds.value, runId]);
  void router.push(`/code/${runId}`);
}
const tab = computed<WorkTab | undefined>({
  get: () => (typeof route.query.tab === "string" ? (route.query.tab as WorkTab) : undefined),
  set: (t) => void router.replace({ path: route.path, query: { ...route.query, tab: t === "overview" ? undefined : t } }),
});
// Not coding work after all (an old link, a run id typed in): the run page shows it.
const notWork = () => void router.replace(`/runs/${id.value}`);
</script>

<template>
  <div class="code">
    <aside class="list-col">
      <div class="head">
        <div class="row top"><CodeTabs current="work" /><span class="spacer" /><button v-if="mayDelegate" class="btn sm" title="交办编码任务或评审一个分支" @click="delegateOpen = true"><Icon name="code" :size="14" />交办</button></div>
        <label class="search"><Icon name="search" :size="14" /><input v-model="keyword" placeholder="标题、分支、任务里的字或 id" aria-label="搜索交办" /></label>
        <UiSegmented v-model="scope" size="sm" aria-label="范围" :options="[{ value: 'space', label: '当前空间' }, { value: 'all', label: '所有空间' }]" />
      </div>
      <div class="items">
        <CodeWorkList :space="scope === 'space' ? state.space : null" :q="keyword" :active="root" @pick="(w) => router.push(`/code/${w.latestId}`)" />
      </div>
    </aside>
    <main class="detail">
      <CodeWork v-if="id" :key="workKey" v-model:tab="tab" :run-id="id" @open="openRound" @loaded="onLoaded" @missing="notWork" />
      <div v-else class="empty">
        <Icon name="code" :size="34" />
        <h3>交办</h3>
        <p>每次交办编码和分支评审是一行，按等谁分组，等你决定或确认的在最上面。点开看它现在在做什么、下一步、分支推到哪，以及修改项、评审和每一轮的过程。交办前写的方案在“方案”，挂在事项上的需求点在“需求”。</p>
        <button v-if="mayDelegate" class="btn primary sm" @click="delegateOpen = true"><Icon name="code" :size="14" />交办编码任务</button>
      </div>
    </main>
    <DelegateDialog v-if="delegateOpen && mayDelegate" @close="delegateOpen = false" />
  </div>
</template>

<style scoped>
.code {
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
.head .top {
  width: 100%;
  gap: 8px;
}
.search {
  justify-self: stretch;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--muted);
}
.search:focus-within {
  border-color: var(--accent);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--ink);
}
.items {
  overflow-y: auto;
  padding: 6px;
  flex: 1;
  min-height: 0;
}
.detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 22px 28px 60px;
}
@media (max-width: 760px) {
  .code {
    flex-direction: column;
  }
  .list-col {
    width: 100%;
    max-height: 36vh;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .detail {
    padding: 16px;
  }
}
</style>
