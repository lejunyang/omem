<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { get, patch, type Item } from "../api";
import Icon from "./Icon.vue";
import UiDateTime from "./UiDateTime.vue";
import UiSelect from "./UiSelect.vue";
import { itemKindLabel, toast } from "../store";
import { itemStatusLabel } from "../lib/work";

/**
 * Editing a line or work item from its page: its name, goal, kind, status, due date and the line it
 * belongs to (PATCH /api/items/:id, which checks the levels). Everything else stays on 事项.
 */
const props = defineProps<{ item: Item & { parentId?: string | null } }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const form = reactive({ title: props.item.title, detail: props.item.detail, kind: props.item.kind, status: props.item.status, dueAt: props.item.dueAt, parent: props.item.parentId ?? "" });
const busy = ref(false);
const panel = ref<HTMLElement>();
const opener = document.activeElement as HTMLElement | null;

// Where it can hang: an open item that is not itself or under it (the host checks the levels).
const items = ref<(Item & { parentId?: string | null })[]>([]);
onMounted(async () => {
  void nextTick(() => panel.value?.querySelector<HTMLInputElement>("input")?.focus());
  items.value = await get<(Item & { parentId?: string | null })[]>("/api/items?status=active").catch(() => []);
});
const under = computed(() => {
  const mine = new Set([props.item.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const i of items.value) if (i.parentId && mine.has(i.parentId) && !mine.has(i.id)) { mine.add(i.id); grew = true; }
  }
  return mine;
});
const parents = computed(() => [
  { value: "", label: "不属于任何线" },
  ...items.value
    .filter((i) => !under.value.has(i.id) && i.status !== "candidate")
    .sort((a, b) => Number(b.kind === "line") - Number(a.kind === "line") || Number(!a.parentId) - Number(!b.parentId) || b.updatedAt.localeCompare(a.updatedAt))
    .map((i) => ({ value: i.id, label: i.title, hint: i.kind === "line" ? "工作线" : i.parentId ? "工作项" : itemKindLabel[i.kind] ?? i.kind })),
]);
const kinds = computed(() => Object.entries(itemKindLabel).map(([value, label]) => ({ value, label })));
const statuses = computed(() => ["open", "waiting", "snoozed", "done", "cancelled"].map((s) => ({ value: s, label: itemStatusLabel[s] })));

async function save() {
  if (!form.title.trim()) return toast("名字不能空着", "error");
  busy.value = true;
  try {
    const body: Record<string, unknown> = {};
    if (form.title.trim() !== props.item.title) body.title = form.title.trim();
    if (form.detail !== props.item.detail) body.detail = form.detail;
    if (form.kind !== props.item.kind) body.kind = form.kind;
    if (form.status !== props.item.status) body.status = form.status;
    if (form.dueAt !== props.item.dueAt) body.dueAt = form.dueAt;
    if (form.parent !== (props.item.parentId ?? "")) body.parent = form.parent || null;
    if (Object.keys(body).length) await patch(`/api/items/${props.item.id}`, body);
    emit("saved");
    emit("close");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); emit("close"); }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => { window.removeEventListener("keydown", onKey); opener?.focus?.(); });
</script>

<template>
  <Teleport to="body">
    <div class="overlay" @mousedown.self="emit('close')">
      <form ref="panel" class="modal" role="dialog" aria-modal="true" aria-labelledby="work-edit-title" @submit.prevent="save">
        <header class="row"><strong id="work-edit-title">编辑</strong><span class="spacer" /><button type="button" class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" /></button></header>
        <label class="field"><span>名字</span><input v-model="form.title" class="input" maxlength="200" /></label>
        <label class="field"><span>目标和背景</span><textarea v-model="form.detail" class="textarea" rows="4" placeholder="第一行是一句话的目标，页面标题下显示它" /></label>
        <div class="grid2">
          <div class="field"><span>类型</span><UiSelect v-model="form.kind" aria-label="类型" :options="kinds" /></div>
          <div class="field"><span>状态</span><UiSelect v-model="form.status" aria-label="状态" :options="statuses" /></div>
          <div class="field"><span>截止时间</span><UiDateTime v-model="form.dueAt" aria-label="截止时间" /></div>
          <div class="field"><span>属于</span><UiSelect v-model="form.parent" aria-label="属于哪条线" :options="parents" :search-at="8" /></div>
        </div>
        <p class="muted small">最多三层：工作线、它下面的工作项（需求、评审、待办）、工作项下面的（缺陷）。提醒、等待对象和材料在 <router-link :to="`/items/${item.id}`" @click="emit('close')">事项</router-link> 里改。</p>
        <div class="row"><span class="spacer" /><button type="button" class="btn" @click="emit('close')">取消</button><button class="btn primary" :disabled="busy">保存</button></div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 35; background: rgba(10, 12, 16, 0.25); display: flex; justify-content: center; align-items: flex-start; padding: 8vh 12px 12px; overflow: auto; }
.modal { width: min(620px, 100%); background: var(--panel); border-radius: 14px; border: 1px solid var(--line); box-shadow: var(--shadow-lg); padding: 16px 18px; display: grid; gap: 12px; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
@media (max-width: 560px) { .grid2 { grid-template-columns: minmax(0, 1fr); } }
</style>
