<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { del, get, put, type Memory } from "../api";
import MemoryCard from "../components/MemoryCard.vue";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import UiSelect from "../components/UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import { toast } from "../store";

type Spec = { name: string; description: string; status: "active" | "draft"; agent?: string; model?: string; tools: string[]; writes: boolean; skills: string[]; mcp: Record<string, unknown>; cwd?: string; space?: string };
type Skill = { name: string; description: string; status: "active" | "draft"; files: string[] };
type AgentMemory = Memory;
type AttachedSkill = { name: string; description: string; status: string; body?: string };
type SpecDetail = Omit<Spec, "skills"> & {
  body?: string;
  skills?: AttachedSkill[];
  availableSkills?: { name: string; description: string; status: string }[];
  memories?: AgentMemory[];
};

const route = useRoute();
const router = useRouter();
const tab = computed(() => (route.query.tab === "skills" ? "skills" : "agents"));
const kind = computed(() => (tab.value === "skills" ? "skill" : "agent"));
const agents = ref<Spec[]>([]);
const skills = ref<Skill[]>([]);
const selected = computed(() => (route.query.name as string | undefined) ?? null);
const raw = ref("");
const dirty = ref(false);
const creating = ref(false);
const newName = ref("");

const loading = ref(true);
const rawLoading = ref(false);
const detail = ref<SpecDetail | null>(null);
async function load() {
  try {
    [agents.value, skills.value] = await Promise.all([get<Spec[]>("/api/agents"), get<Skill[]>("/api/skills")]);
  } finally {
    loading.value = false;
  }
}
async function loadDetail() {
  detail.value = null;
  if (tab.value !== "agents" || !selected.value) return;
  detail.value = await get<SpecDetail>(`/api/agents/${encodeURIComponent(selected.value)}`).catch(() => null);
}
async function loadRaw() {
  dirty.value = false;
  if (!selected.value) return void (raw.value = "");
  rawLoading.value = true;
  try {
    raw.value = (await get<{ raw: string }>(`/api/library-files/${kind.value}/${selected.value}`).catch(() => ({ raw: "" }))).raw;
  } finally {
    rawLoading.value = false;
  }
}
onMounted(async () => {
  await load();
  await Promise.all([loadRaw(), loadDetail()]);
});
watch([selected, tab], () => void Promise.all([loadRaw(), loadDetail()]));
async function refreshAfterSave() {
  await Promise.all([load(), loadDetail()]);
}
async function forgetMemory(m: AgentMemory) {
  if (!(await confirmDialog("撤回这条档案专属记忆？", { message: m.content, okText: "撤回", danger: true }))) return;
  await del(`/api/memories/${m.id}?reason=${encodeURIComponent("网页撤回档案专属记忆")}`);
  toast("已撤回", "ok");
  await loadDetail();
}
async function toggleSkill(name: string, on: boolean) {
  if (!detail.value || !selected.value) return;
  const current = new Set((detail.value.skills ?? []).map((s) => s.name));
  if (on) current.add(name);
  else current.delete(name);
  try {
    await put(`/api/agents/${encodeURIComponent(selected.value)}`, { skills: [...current] });
    toast(on ? "已挂技能" : "已移除技能", "ok");
    await loadDetail();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const addSkillValue = ref<string | null>(null);
const addingSkill = ref(false);
const addableSkills = computed(() =>
  (detail.value?.availableSkills ?? [])
    .filter((s) => !(detail.value?.skills ?? []).some((x) => x.name === s.name))
    .map((s) => ({ value: s.name, label: s.name, hint: s.description })),
);
async function onAddSkill(name: string | null) {
  addingSkill.value = false;
  if (!name) return;
  await toggleSkill(name, true);
  addSkillValue.value = null;
}

const list = computed(() => (tab.value === "agents" ? agents.value : skills.value));
async function openSkill(name: string) {
  router.push({ path: "/agents", query: { tab: "skills", name } });
}
async function open(name: string | null) {
  if (dirty.value && !(await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true }))) return;
  router.replace({ query: { tab: tab.value, ...(name ? { name } : {}) } });
}
async function switchTab(t: string) {
  if (dirty.value && !(await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true }))) return;
  router.replace({ query: { tab: t } });
}

const templates = {
  agent: (name: string) => `---
description: 做什么、什么时候该交给它（一两句话）
# agent: codex          # 后端，不填用默认
# model: gpt-6.1-sol
# effort: low
# tools: [search, read_source, recall]   # 不填为只读检索工具
# writes: false          # 是否允许改工作目录里的文件
# space: personal
# cwd: E:\\Projects\\xxx
# skills: [${name}-steps]
# mcp:
#   github: { command: github-mcp-server, args: [stdio] }
---

你负责……

## 步骤

1. ……

## 输出

……
`,
  skill: (name: string) => `---
name: ${name}
description: 做什么、什么时候用
---

## 什么时候用

……

## 步骤

1. ……

## 检查

- ……
`,
};

async function create() {
  const name = newName.value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) return toast("名称只能用小写字母、数字和连字符", "error");
  creating.value = false;
  newName.value = "";
  raw.value = templates[kind.value](name);
  await router.replace({ query: { tab: tab.value, name } });
  raw.value = templates[kind.value](name);
  dirty.value = true;
}
async function save() {
  if (!selected.value) return;
  try {
    await put(`/api/library-files/${kind.value}/${selected.value}`, { raw: raw.value });
    dirty.value = false;
    toast("已保存（知识库 Git 中有历史）", "ok");
    await refreshAfterSave();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function approve() {
  const next = raw.value.replace(/^status:\s*draft\s*\n/m, "");
  raw.value = next;
  await save();
}
async function remove() {
  if (!selected.value || !(await confirmDialog(`删除 ${selected.value}？`, { message: "文件的历史仍保留在 Git 中。", okText: "删除", danger: true }))) return;
  await del(`/api/${tab.value}/${selected.value}`);
  open(null);
  await load();
}
const current = computed(() => list.value.find((x) => x.name === selected.value));
</script>

<template>
  <div class="agents">
    <aside class="list-col">
      <div class="head">
        <div class="tabs row">
          <button class="tab" :class="{ on: tab === 'agents' }" @click="switchTab('agents')">Agent 档案</button>
          <button class="tab" :class="{ on: tab === 'skills' }" @click="switchTab('skills')">技能</button>
          <span class="spacer" />
          <button class="btn ghost sm icon" title="新建" @click="creating = !creating"><Icon name="plus" :size="15" /></button>
        </div>
        <form v-if="creating" class="row" @submit.prevent="create">
          <input v-model="newName" class="input" placeholder="名称，如 weekly-report" autofocus />
          <button class="btn sm">创建</button>
        </form>
      </div>
      <div class="items">
        <button v-for="x in list" :key="x.name" class="li" :class="{ on: x.name === selected }" @click="open(x.name)">
          <div class="grow">
            <div class="row"><strong class="ellipsis">{{ x.name }}</strong><span v-if="x.status === 'draft'" class="badge">草稿</span></div>
            <div class="muted small clamp">{{ x.description }}</div>
          </div>
        </button>
        <Skeleton v-if="loading" :rows="5" />
        <div v-else-if="!list.length" class="empty small">
          <p v-if="tab === 'agents'">还没有 Agent 档案。可以对助理说“建一个负责代码评审的 Agent，用 codex，只读”。</p>
          <p v-else>还没有技能。可以对助理说“把刚才整理周报的做法记成技能”，做梦整理时也会起草。</p>
        </div>
      </div>
    </aside>
    <main class="detail">
      <div v-if="rawLoading && !raw" class="pad"><Skeleton variant="lines" :rows="14" /></div>
      <div v-else-if="!selected" class="empty">
        <Icon name="layers" :size="34" />
        <h3>{{ tab === "agents" ? "Agent 档案" : "技能" }}</h3>
        <p v-if="tab === 'agents'">专门做某类事的 Agent：system prompt、后端与模型、可用工具、技能、MCP、工作目录。在问答里 <code>/as 名称</code> 让它接管会话，<code>/as 名称 任务</code> 交给它做一件事；助理也会按用途委派。</p>
        <p v-else>可复用的做法（SKILL.md）。所有 Agent 都能看到技能目录，做对应的事之前读全文照做。草稿需要启用后才会出现在目录里。</p>
      </div>
      <template v-else>
        <header class="row dh">
          <h2 class="mono">{{ selected }}</h2>
          <span v-if="current?.status === 'draft'" class="badge">草稿</span>
          <span class="spacer" />
          <button v-if="current?.status === 'draft'" class="btn sm" @click="approve"><Icon name="check" :size="14" />启用</button>
          <button class="btn sm primary" :disabled="!dirty" @click="save">保存</button>
          <button v-if="current" class="btn ghost sm icon danger" title="删除" @click="remove"><Icon name="trash" :size="14" /></button>
        </header>
        <p v-if="tab === 'agents' && current" class="muted small meta">
          后端 {{ current && "agent" in current ? (current as Spec).agent ?? "默认" : "" }} · 工具 {{ (current as Spec).tools?.length ? (current as Spec).tools.join(", ") : "默认只读" }}<span v-if="(current as Spec).writes"> · 可改文件</span>
        </p>
        <div v-if="tab === 'agents' && detail" class="learn">
          <details class="learn-block" open>
            <summary>挂载技能（{{ detail.skills?.length ?? 0 }}）<span class="muted small">可复用的做法；点击名字去技能页查看与编辑</span></summary>
            <div class="chips">
              <button
                v-for="s in detail.skills"
                :key="s.name"
                type="button"
                class="chip"
                :class="{ missing: s.status === 'missing' }"
                :title="s.status === 'missing' ? '技能已不存在，点击右侧 × 移除' : s.description"
                @click="openSkill(s.name)"
              >
                {{ s.name }}
                <span class="x" role="button" tabindex="0" :title="s.status === 'missing' ? '技能不存在，点此移除' : '从该档案移除'" @click.stop="toggleSkill(s.name, false)">×</span>
              </button>
              <UiSelect
                v-if="addingSkill && addableSkills.length"
                v-model="addSkillValue"
                size="sm"
                width="220px"
                placeholder="选择技能…"
                :options="addableSkills"
                :search-at="6"
                @change="onAddSkill"
              />
              <button
                v-else
                type="button"
                class="chip add-chip"
                :disabled="!addableSkills.length"
                :title="addableSkills.length ? '挂载一个已有技能' : '所有技能都已挂载'"
                @click="addingSkill = true"
              >＋</button>
            </div>
            <p v-if="!(detail.skills?.length)" class="muted small empty-line">还没有挂载技能。点 ＋ 选一个已有技能，或让助理 <code>save_skill(agent="档案名")</code> 保存并自动挂载。</p>
          </details>
          <details class="learn-block" open>
            <summary>专属记忆（{{ detail.memories?.length ?? 0 }}）<span class="muted small">只有这个档案能看到的偏好与经验；共享记忆在「记忆」页</span></summary>
            <div v-if="detail.memories?.length" class="mems">
              <MemoryCard
                v-for="m in detail.memories"
                :key="m.id"
                :m="m"
                compact
                @retract="forgetMemory($event)"
              />
            </div>
            <p v-else class="muted small empty-line">还没有专属记忆。你纠正它的偏好或风格后，助理会用 <code>remember(agent="档案名")</code> 记在这里。</p>
          </details>
        </div>
        <textarea v-model="raw" class="editor mono" spellcheck="false" @input="dirty = true" />
      </template>
    </main>
  </div>
</template>

<style scoped>
.agents {
  display: flex;
  height: 100%;
}
.list-col {
  width: 300px;
  flex: none;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  padding: 12px;
  display: grid;
  gap: 8px;
  border-bottom: 1px solid var(--line);
}
.tab {
  border: 0;
  background: none;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--ink-2);
  font-size: 13px;
}
.tab.on {
  background: var(--hover);
  color: var(--ink);
  font-weight: 600;
}
.items {
  overflow-y: auto;
  padding: 6px;
  flex: 1;
}
.li {
  display: flex;
  width: 100%;
  text-align: left;
  border: 0;
  background: none;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--ink);
  min-width: 0;
}
.li:hover {
  background: var(--hover);
}
.li.on {
  background: var(--accent-soft);
}
.grow {
  min-width: 0;
  flex: 1;
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  gap: 8px;
}
.dh h2 {
  margin: 0;
  font-size: 18px;
}
.meta {
  margin: 0;
}
.editor {
  flex: 1;
  width: 100%;
  resize: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  font-size: 13px;
  line-height: 1.6;
  background: var(--panel, var(--bg));
  color: var(--ink);
}
.empty {
  max-width: 560px;
  margin: 60px auto;
  text-align: center;
  color: var(--ink-2);
}
.empty.small {
  margin: 20px 10px;
  text-align: left;
}
@media (max-width: 760px) {
  .agents {
    flex-direction: column;
  }
  .list-col {
    width: 100%;
    max-height: 40vh;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
}

.learn {
  display: grid;
  gap: 8px;
  flex: none;
  padding: 0 0 4px;
}
.learn-block {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel, var(--bg));
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.learn-block summary {
  cursor: pointer;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  list-style: none;
}
.learn-block[open] {
  max-height: 32vh;
}
.learn-block > .chips,
.learn-block > .mems {
  overflow-y: auto;
  min-height: 0;
}
.learn-block summary::before {
  content: "▸ ";
  color: var(--ink-2);
}
.learn-block[open] summary::before {
  content: "▾ ";
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 12px 10px;
  align-items: center;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--hover);
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 2px 6px 2px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  color: inherit;
}
.chip:hover {
  border-color: var(--line-strong, var(--line));
  background: var(--sunken, var(--hover));
}
.chip.missing {
  color: var(--danger, #c0392b);
  text-decoration: line-through;
}
.add-chip {
  padding: 2px 10px;
  font-size: 15px;
  line-height: 1.3;
  border: 1px dashed var(--line-strong, var(--line));
  background: transparent;
  color: var(--ink-2);
  min-width: 32px;
  justify-content: center;
}
.add-chip:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft, var(--hover));
}
.add-chip:disabled {
  opacity: 0.4;
  cursor: default;
}
.chip .x {
  border: 0;
  background: none;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: var(--ink-2);
  padding: 0 2px;
}
.chip .x:hover {
  color: var(--danger, #c0392b);
}
.mems {
  display: grid;
  padding: 0 12px 8px;
}
.mems :deep(.mem) {
  padding: 8px 0;
}
.empty-line {
  padding: 0 12px 10px;
  margin: 0;
}
</style>