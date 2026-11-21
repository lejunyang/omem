<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, post, put } from "../api";
import { relTime, state, toast } from "../store";
import { targetBody, type SyncProvider, type SyncTarget } from "../lib/item-sync";
import Icon from "./Icon.vue";
import SetCard from "./SetCard.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 设置 → 助手 → 推进工作 → 事项同步 (src/items/providers.ts): entries on a platform (issues, requirements)
 * kept as items. A plugin offers what can be read; the person subscribes a target into one space and
 * says whether new entries wait as candidates and whether status changes made here go back. The card
 * is not rendered until a plugin offers a source or there is a subscription to show.
 */
const providers = ref<SyncProvider[]>([]);
const targets = ref<SyncTarget[] | null>(null);
const error = ref("");
const open = ref<string | null>(null);
const busy = ref<string | null>(null);
const adding = ref(false);
const draft = ref({ provider: "", target: "", spaceId: "", importMode: "candidate" as "candidate" | "direct", mode: "confirm" as "confirm" | "direct" });

async function load() {
  try {
    const r = await get<{ providers: SyncProvider[]; targets: SyncTarget[] }>("/api/item-sync");
    providers.value = r.providers;
    targets.value = r.targets;
    error.value = "";
  } catch (e) {
    targets.value ??= [];
    error.value = (e as Error).message;
  }
}
onMounted(load);

const byId = computed(() => new Map(providers.value.map((p) => [p.id, p])));
const labelOf = (id: string) => byId.value.get(id)?.label ?? id;
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
/** Spaces the person may write items into. */
const spaceOptions = computed(() => state.spaces.filter((s) => !state.me?.writes || state.me.writes.includes(s.id)).map((s) => ({ value: s.id, label: s.name })));
const draftProvider = computed(() => byId.value.get(draft.value.provider) ?? null);
const IMPORT = [{ value: "candidate" as const, label: "先当候选" }, { value: "direct" as const, label: "直接建" }];
const WRITE = [{ value: "confirm" as const, label: "先问我" }, { value: "direct" as const, label: "直接写回" }];

function status(t: SyncTarget): { text: string; cls: string; title?: string } {
  if (!byId.value.has(t.provider)) return { text: "插件停用了", cls: "" };
  if (!t.enabled) return { text: "已暂停", cls: "" };
  if (t.error) return { text: "上次没读到", cls: "bad", title: t.error };
  return { text: t.synced_at ? `${relTime(t.synced_at)}读过` : "还没读过", cls: t.synced_at ? "on" : "" };
}

function startAdd() {
  draft.value = { provider: providers.value[0]?.id ?? "", target: "", spaceId: spaceOptions.value.some((s) => s.value === state.space) ? state.space : spaceOptions.value[0]?.value ?? "", importMode: "candidate", mode: "confirm" };
  adding.value = true;
}
async function pull(id: string, quiet = false) {
  try {
    await post(`/api/item-sync/${id}/pull`, {});
    if (!quiet) toast("读过了", "ok");
  } catch (e) {
    toast(`没读成：${(e as Error).message}`, "error");
  }
}
async function add() {
  const d = draft.value;
  if (!d.provider || !d.target.trim() || !d.spaceId || busy.value) return;
  busy.value = "new";
  try {
    const mode = draftProvider.value?.writable ? d.mode : "confirm";
    const saved = await put<{ id: string }>("/api/item-sync", { ...d, target: d.target.trim(), mode, enabled: true });
    adding.value = false;
    await pull(saved.id, true);
    await load();
    const got = targets.value?.find((t) => t.id === saved.id);
    if (got && !got.error) toast(got.items ? `订阅好了，读到 ${got.items} 件${d.importMode === "candidate" ? "，在事项页“可能要跟的”里挑" : ""}` : "订阅好了，那边现在没有条目", "ok");
    open.value = saved.id;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = null;
  }
}
async function change(t: SyncTarget, patch: Parameters<typeof targetBody>[1], note: string) {
  if (busy.value) return;
  busy.value = t.id;
  try {
    await put("/api/item-sync", targetBody(t, patch));
    await load();
    toast(note, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = null;
  }
}
async function pullNow(t: SyncTarget) {
  if (busy.value) return;
  busy.value = t.id;
  await pull(t.id);
  await load();
  busy.value = null;
}
</script>

<template>
  <SetCard v-if="providers.length || targets?.length" id="set-item-sync" title="事项同步">
    <template #aside><button v-if="providers.length && !adding" type="button" class="btn ghost sm" @click="startAdd"><Icon name="plus" :size="13" />订阅</button></template>
    <template #help>把平台上的条目（issue、需求、缺陷）同步成事项，那边的标题和状态变了这边跟着变。能读哪些平台由启用的插件提供，用的是你在账号页连接的那个账号。新条目默认先当候选让你挑；你在这边改了状态，默认先问你要不要写回去。同一个条目只归第一次读到它的空间。</template>

    <p v-if="error" class="set-link" role="alert"><span class="grow">读不到订阅：{{ error }}</span><button class="btn sm" @click="load">重试</button></p>
    <p v-else-if="targets && !targets.length && !adding" class="set-link muted">还没有订阅。</p>

    <form v-if="adding" class="sync-new" @submit.prevent="add">
      <div class="sync-fields">
      <label class="field"><span>读什么</span>
        <UiSelect v-model="draft.provider" :options="providers.map((p) => ({ value: p.id, label: p.label }))" aria-label="读什么" />
      </label>
      <label class="field"><span>{{ draftProvider?.targetHint ?? "哪一个" }}</span>
        <input v-model="draft.target" class="input mono" maxlength="500" required :aria-label="draftProvider?.targetHint ?? '哪一个'" />
      </label>
      <label class="field"><span>放进哪个空间</span>
        <UiSelect v-model="draft.spaceId" :options="spaceOptions" aria-label="放进哪个空间" />
      </label>
      <div class="field"><span>新条目</span>
        <UiSegmented v-model="draft.importMode" size="sm" aria-label="新条目" :options="IMPORT" />
      </div>
      <div v-if="draftProvider?.writable" class="field"><span>这边改了状态</span>
        <UiSegmented v-model="draft.mode" size="sm" aria-label="这边改了状态" :options="WRITE" />
      </div>
      </div>
      <div class="sync-foot">
        <span class="grow" />
        <button type="button" class="btn ghost sm" :disabled="busy === 'new'" @click="adding = false">取消</button>
        <button type="submit" class="btn primary sm" :disabled="busy === 'new' || !draft.provider || !draft.target.trim() || !draft.spaceId">{{ busy === "new" ? "正在读第一遍…" : "订阅" }}</button>
      </div>
    </form>

    <div v-for="t in targets ?? []" :key="t.id" class="sync" :class="{ open: open === t.id, off: !t.enabled }">
      <button type="button" class="sync-row" :aria-expanded="open === t.id" @click="open = open === t.id ? null : t.id">
        <span class="sync-main">
          <span class="sync-name ellipsis"><span class="mono">{{ t.target }}</span></span>
          <span class="sync-meta ellipsis">{{ labelOf(t.provider) }} → {{ spaceName(t.space_id) }} · {{ t.items }} 件</span>
        </span>
        <span class="sync-status" :class="status(t).cls" :title="status(t).title">{{ status(t).text }}</span>
        <Icon name="right" :size="14" class="chev" />
      </button>
      <div v-if="open === t.id" class="sync-body">
        <p v-if="t.error" class="small bad">{{ t.error }}</p>
        <p v-if="!byId.has(t.provider)" class="small muted">提供它的插件没在运行，已有的事项留在原处，不再更新。</p>
        <div class="sync-fields">
        <div class="field"><span>新条目</span>
          <UiSegmented :model-value="t.import_mode" size="sm" aria-label="新条目" :options="IMPORT" @change="(v) => change(t, { importMode: v }, v === 'candidate' ? '新条目先当候选' : '新条目直接建成事项')" />
          <span class="hint">{{ t.import_mode === "candidate" ? "出现在事项页“可能要跟的”里，你说要才算数" : "读到就建成事项" }}</span>
        </div>
        <div class="field"><span>这边改了状态</span>
          <UiSegmented v-if="byId.get(t.provider)?.writable" :model-value="t.mode" size="sm" aria-label="这边改了状态" :options="WRITE" @change="(v) => change(t, { mode: v }, v === 'confirm' ? '写回前先问你' : '状态直接写回')" />
          <span class="hint">{{ !byId.get(t.provider)?.writable ? "这个来源只读，不写回" : t.mode === "confirm" ? "每次问你要不要把那边也改掉" : "下次同步时直接改那边；那边先变了就停下给你看" }}</span>
        </div>
        </div>
        <div class="sync-foot">
          <UiCheckbox :model-value="!!t.enabled" switch size="sm" :disabled="busy === t.id" aria-label="同步" @change="(v) => change(t, { enabled: v }, v ? '继续同步' : '已暂停，事项留在原处')" />
          <span class="small muted">{{ t.enabled ? "同步中" : "已暂停" }}</span>
          <span class="grow" />
          <button type="button" class="btn sm" :disabled="busy === t.id || !t.enabled || !byId.has(t.provider)" @click="pullNow(t)">{{ busy === t.id ? "正在读…" : "现在读一次" }}</button>
        </div>
      </div>
    </div>
  </SetCard>
</template>

<style scoped>
.grow { flex: 1; min-width: 0; }
.mono { font-family: var(--mono); font-size: 13px; }
.sync { border-top: 1px solid var(--line); min-width: 0; }
.sync-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px;
  width: 100%; padding: 10px 20px 10px 18px; border: 0; background: none; font: inherit; text-align: left; color: var(--ink); cursor: pointer; min-width: 0;
}
.sync-main { display: grid; gap: 2px; min-width: 0; }
.sync-name { font-size: 14px; }
.sync.off .sync-name { color: var(--muted); }
.sync-meta { font-size: 12px; color: var(--muted); }
.sync-status { font-size: 13px; color: var(--muted); white-space: nowrap; }
.sync-status.on { color: var(--ok); }
.sync-status.bad, .bad { color: var(--danger); }
.chev { color: var(--muted); transition: transform 0.15s ease; }
.sync.open .chev { transform: rotate(90deg); }
.sync-body, .sync-new { display: grid; gap: 14px; padding: 4px 18px 16px; min-width: 0; }
.sync-new { padding-top: 14px; border-top: 1px solid var(--line); }
.sync-body > p { margin: 0; overflow-wrap: anywhere; }
.sync-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 14px 28px; min-width: 0; }
.sync-fields .field { align-content: start; justify-items: start; min-width: 0; }
.sync-fields .field > :deep(.ui-select) { width: 100%; max-width: 420px; }
.sync-foot { display: flex; align-items: center; gap: 8px; }
.sync-new .input { width: 100%; max-width: 420px; }
@media (max-width: 640px) {
  .sync-row { grid-template-columns: minmax(0, 1fr) auto; padding: 10px 14px; }
  .sync-status { grid-row: 2; grid-column: 1; }
  .chev { grid-row: 1 / span 2; grid-column: 2; }
  .sync-body, .sync-new { padding-left: 14px; padding-right: 14px; }
}
</style>
