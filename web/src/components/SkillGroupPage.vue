<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get, put } from "../api";
import { toast } from "../store";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import VirtualList from "./VirtualList.vue";

/** One skill group (src/agents/agent-skills.ts): its hub's description, purposes and switches. */
type Member = { name: string; description: string; purpose: string; enabled: boolean; origin: string };
type Group = { id: string; title: string; description: string; autoDescription: string; enabled: boolean; count: number; enabledCount: number; purposes: { purpose: string; count: number }[]; skills: Member[] };

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ open: [name: string]; changed: [] }>();
const group = ref<Group | null>(null);
const error = ref("");
const filter = ref("");
const title = ref("");
const description = ref("");
const busy = ref(false);

async function load() {
  error.value = "";
  try {
    const g = await get<Group>(`/api/skill-groups/${encodeURIComponent(props.id)}`);
    group.value = g;
    title.value = g.title === g.id ? "" : g.title;
    description.value = g.description;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
watch(() => props.id, () => { group.value = null; void load(); }, { immediate: true });

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = group.value?.skills ?? [];
  return q ? list.filter((s) => `${s.name} ${s.purpose} ${s.description}`.toLowerCase().includes(q)) : list;
});
const purposes = computed(() => group.value?.purposes.filter((p) => p.purpose) ?? []);

async function saveGroup(patch: { title?: string; description?: string; enabled?: boolean }) {
  busy.value = true;
  try {
    await put(`/api/skill-groups/${encodeURIComponent(props.id)}`, patch);
    await load();
    emit("changed");
    toast("已保存");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function saveSkill(s: Member, patch: { purpose?: string; enabled?: boolean; group?: string | null }) {
  try {
    await put("/api/skill-groups", { skills: [{ name: s.name, ...patch }] });
    Object.assign(s, patch);
    if (patch.group !== undefined) { await load(); emit("changed"); }
  } catch (e) {
    toast((e as Error).message);
  }
}
</script>

<template>
  <div class="page group-page">
    <p v-if="error" class="muted">{{ error }}</p>
    <Skeleton v-else-if="!group" variant="lines" :rows="10" />
    <template v-else>
      <header class="dh row">
        <h2 class="mono">{{ group.id }}</h2>
        <span class="badge">分组 · 启用 {{ group.enabledCount }}/{{ group.count }}</span>
        <span class="spacer" />
        <UiCheckbox :model-value="group.enabled" switch size="sm" :disabled="busy" @change="(v) => saveGroup({ enabled: v })">整组启用</UiCheckbox>
      </header>
      <p class="muted small">Agent 只看到这一组的一个总入口：它的说明决定 Agent 什么时候来读；读了以后按用途找到具体技能，再读那个技能的全文。用途和启用改了以后总入口随之重新生成。</p>
      <div class="form">
        <label class="field"><span>标题</span><input v-model="title" class="input" :placeholder="group.id" /></label>
        <label class="field">
          <span>说明（做哪类事时该读这一组）</span>
          <textarea v-model="description" class="input desc" :placeholder="group.autoDescription" />
          <small class="muted">不写时用上面的自动说明。也可以对助手说“把 {{ group.id }} 这组按用途整理一下，写好说明”。</small>
        </label>
        <div><button class="btn sm primary" :disabled="busy || (title === (group.title === group.id ? '' : group.title) && description === group.description)" @click="saveGroup({ title, description })">保存</button></div>
      </div>
      <p v-if="purposes.length" class="small muted">用途：<span v-for="p in purposes" :key="p.purpose" class="chip">{{ p.purpose }} {{ p.count }}</span></p>
      <input v-model="filter" class="input" placeholder="按名称、用途或说明筛选" aria-label="筛选技能" />
      <div class="skills">
        <VirtualList :items="shown" :item-key="(s) => s.name" :estimate="74">
          <template #default="{ item: s }">
            <div class="skill-row" :class="{ off: !s.enabled }">
              <UiCheckbox :model-value="s.enabled" size="sm" :aria-label="`启用 ${s.name}`" @change="(v) => saveSkill(s, { enabled: v })" />
              <div class="grow">
                <button class="link mono" @click="emit('open', s.name)">{{ s.name }}</button>
                <div class="muted small clamp">{{ s.description }}</div>
              </div>
              <input class="input purpose" :value="s.purpose" placeholder="用途" :aria-label="`${s.name} 的用途`" @change="(e) => saveSkill(s, { purpose: (e.target as HTMLInputElement).value })" />
            </div>
          </template>
        </VirtualList>
      </div>
    </template>
  </div>
</template>

<style scoped>
.group-page { display: grid; gap: 12px; }
.desc { min-height: 72px; resize: vertical; }
.chip { display: inline-block; margin: 0 6px 4px 0; padding: 1px 8px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); }
.skills { max-height: 62vh; overflow: auto; border-top: 1px solid var(--line); }
.skill-row { display: flex; gap: 10px; align-items: center; padding: 8px 2px; border-bottom: 1px solid var(--line); }
.skill-row.off .grow { opacity: 0.55; }
.skill-row .grow { min-width: 0; flex: 1; }
.link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; overflow-wrap: anywhere; text-align: left; }
.purpose { width: 140px; flex: none; }
@media (max-width: 760px) { .purpose { width: 96px; } }
</style>
