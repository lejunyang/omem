<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { del, get, post, put } from "../api";
import AiDefaults from "../components/AiDefaults.vue";
import VirtualList from "../components/VirtualList.vue";
import ChipPicker from "../components/ChipPicker.vue";
import Icon from "../components/Icon.vue";
import ReviewSettings from "../components/ReviewSettings.vue";
import Markdown from "../components/Markdown.vue";
import ProfileLearning, { type ProfileDetail } from "../components/ProfileLearning.vue";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSelect from "../components/UiSelect.vue";
import { compactDiff, diffLines } from "../lib/diff";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { state, toast } from "../store";

/**
 * Agent profiles: the specs the owner made, omem's built-in roles (customizable copies with
 * reset / merge when the source changes) and skills. A profile shows who it is (a form, or the
 * raw file), what it has learned and how it is evolving.
 */
type Spec = { name: string; description: string; status: "active" | "draft"; agent?: string; model?: string; effort?: string; tools: string[]; writes: boolean; skills: string[]; mcp: Record<string, unknown>; cwd?: string; space?: string; spaces: string[]; instructions?: string; prompt: string; plugin?: string };
type RoleState = { name: string; description: string; customized: boolean; sourceChanged: boolean };
type Skill = { name: string; description: string; status: "active" | "draft"; files: string[] };
type Options = { backends: { id: string; name: string; installed: boolean; transport?: string; model?: string; effort?: string }[]; defaultBackend: string; globalDefaultBackend: string; tools: { name: string; description: string; write: boolean }[]; defaultTools: string[] };
type SpecDetail = Omit<Spec, "skills"> & ProfileDetail;
type RoleDetail = { defaults: { agent: string; byBackend: Record<string, { model?: string; effort?: string }> }; name: string; description: string; tools: string[]; writes: boolean; body: string } & ProfileDetail & { role: RoleState & { source: string; own: string | null } };

const route = useRoute();
const router = useRouter();
const tab = computed(() => (route.query.tab === "skills" ? "skills" : route.query.tab === "review" ? "review" : "agents"));
const specName = computed(() => (tab.value === "agents" && typeof route.query.name === "string" ? route.query.name : null));
const roleName = computed(() => (tab.value === "agents" && typeof route.query.role === "string" ? route.query.role : null));
const skillName = computed(() => (tab.value === "skills" && typeof route.query.name === "string" ? route.query.name : null));
const creating = computed(() => route.query.new === "1");

const specs = ref<Spec[]>([]);
const roles = ref<RoleState[]>([]);
const skills = ref<Skill[]>([]);
const options = ref<Options>({ backends: [], defaultBackend: "", globalDefaultBackend: "", tools: [], defaultTools: [] });
const loading = ref(true);
async function loadLists() {
  try {
    [specs.value, roles.value, skills.value] = await Promise.all([get<Spec[]>("/api/agents"), get<RoleState[]>("/api/roles"), get<Skill[]>("/api/skills")]);
  } finally {
    loading.value = false;
  }
}

// ---- spec form ------------------------------------------------------------------
const blank = (): Spec => ({ name: "", description: "", status: "active", tools: [], writes: false, skills: [], mcp: {}, spaces: [], prompt: "" });
const form = ref<Spec>(blank());
const specDetail = ref<SpecDetail | null>(null);
const raw = ref("");
const rawMode = ref(false);
const dirty = ref(false);
const detailLoading = ref(false);
const saving = ref(false);

/** `quiet`: refresh in place (after a change on the page), keeping the scroll position. */
async function loadSpec(quiet = false) {
  if (!quiet) specDetail.value = null;
  if (!specName.value) return;
  detailLoading.value = !quiet;
  try {
    const d = await get<SpecDetail>(`/api/agents/${encodeURIComponent(specName.value)}`);
    specDetail.value = d;
    form.value = { ...blank(), ...d, tools: [...d.tools], spaces: [...(d.spaces ?? [])], skills: d.skills.map((s) => s.name) } as Spec;
    raw.value = (await get<{ raw: string }>(`/api/library-files/agent/${encodeURIComponent(specName.value)}`)).raw;
    dirty.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    detailLoading.value = false;
  }
}
function startNew() {
  form.value = { ...blank(), prompt: "你负责……\n\n## 做法\n\n1. ……\n\n## 输出\n\n……" };
  rawMode.value = false;
  dirty.value = false;
}
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const reserved = computed(() => new Set(roles.value.map((r) => r.name)));
const nameError = computed(() => (!creating.value ? "" : !form.value.name ? "" : !NAME.test(form.value.name) ? "只能用小写字母、数字和连字符" : specs.value.some((s) => s.name === form.value.name) ? "已有同名档案" : reserved.value.has(form.value.name) ? "这是内置角色的名字" : ""));
async function saveSpec() {
  const name = creating.value ? form.value.name.trim() : specName.value!;
  if (creating.value && (!name || nameError.value)) return toast(nameError.value || "先填名称", "error");
  if (!form.value.description.trim()) return toast("写一句用途：做什么、什么时候交给它", "error");
  saving.value = true;
  try {
    if (rawMode.value && !creating.value) await put(`/api/library-files/agent/${encodeURIComponent(name)}`, { raw: raw.value });
    else {
      const f = form.value;
      await put(`/api/agents/${encodeURIComponent(name)}`, {
        description: f.description.trim(),
        agent: f.agent ?? "",
        model: f.model?.trim() ?? "",
        effort: f.effort ?? "",
        tools: f.tools,
        writes: f.writes,
        space: f.space ?? "",
        spaces: f.spaces,
        cwd: f.cwd?.trim() ?? "",
        instructions: f.instructions?.trim() ?? "",
        prompt: f.prompt,
        ...(creating.value ? { status: "active", skills: f.skills } : {}),
      });
    }
    dirty.value = false;
    toast(creating.value ? "已创建" : "已保存（知识库 Git 中有历史）", "ok");
    await loadLists();
    if (creating.value) await router.replace({ query: { tab: "agents", name } });
    else await loadSpec();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
async function approveSpec() {
  await put(`/api/agents/${encodeURIComponent(specName.value!)}`, { status: "active" });
  toast("已启用", "ok");
  await Promise.all([loadLists(), loadSpec()]);
}
async function removeSpec() {
  if (!specName.value || !(await confirmDialog(`删除 ${specName.value}？`, { message: "文件的历史仍保留在知识库 Git 中；它的专属记忆不受影响。", okText: "删除", danger: true }))) return;
  await del(`/api/agents/${encodeURIComponent(specName.value)}`);
  dirty.value = false;
  await router.replace({ query: { tab: "agents" } });
  await loadLists();
}
function toggleRaw() {
  if (dirty.value) return toast("先保存或放弃当前修改，再切换", "error");
  rawMode.value = !rawMode.value;
}

const spaceOptions = computed(() => [{ value: "", label: "交办时所在的空间" }, ...state.spaces.map((s) => ({ value: s.id, label: s.name, hint: s.id }))]);
const readableOptions = computed(() => [{ value: "*", label: "全部空间" }, ...state.spaces.map((s) => ({ value: s.id, label: s.name, hint: s.id }))]);
const toolOptions = computed(() => options.value.tools.map((t) => ({ value: t.name, hint: `${t.write ? "（写）" : ""}${t.description}` })));
const skillOptions = computed(() => skills.value.map((s) => ({ value: s.name, hint: s.description })));
const formTools = computed({ get: () => form.value.tools, set: (v) => ((form.value.tools = v), (dirty.value = true)) });
const formSpaces = computed({ get: () => form.value.spaces, set: (v) => ((form.value.spaces = v), (dirty.value = true)) });
const formSkills = computed({ get: () => form.value.skills, set: (v) => ((form.value.skills = v), (dirty.value = true)) });
const mcpNames = computed(() => Object.keys(form.value.mcp ?? {}));

// ---- built-in role ----------------------------------------------------------------
const roleDetail = ref<RoleDetail | null>(null);
const roleText = ref("");
const roleAi = ref({ agent: "", model: "", effort: "" });
const roleAiDirty = ref(false);
function updateRoleAi(v: { agent?: string; model?: string; effort?: string }) {
  if (v.agent !== roleAi.value.agent) {
    const saved = roleDetail.value?.defaults.byBackend[v.agent || options.value.globalDefaultBackend];
    roleAi.value = { agent: v.agent ?? "", model: saved?.model ?? "", effort: saved?.effort ?? "" };
  } else roleAi.value = { agent: v.agent ?? "", model: v.model ?? "", effort: v.effort ?? "" };
  roleAiDirty.value = true; dirty.value = true;
}
async function saveRoleAi() {
  saving.value = true;
  try {
    await put(`/api/roles/${encodeURIComponent(roleName.value!)}/defaults`, { ...roleAi.value, profile: roleAi.value.agent || options.value.globalDefaultBackend });
    roleAiDirty.value = false;
    dirty.value = roleText.value !== (roleDetail.value?.role.own ?? roleDetail.value?.role.source);
    if (roleDetail.value) roleDetail.value.defaults = { agent: roleAi.value.agent, byBackend: { ...roleDetail.value.defaults.byBackend, [roleAi.value.agent || options.value.globalDefaultBackend]: { model: roleAi.value.model, effort: roleAi.value.effort } } };
    toast("默认 AI 已保存", "ok");
  } catch (e) { toast((e as Error).message, "error"); }
  finally { saving.value = false; }
}
const showSource = ref(false);
async function loadRole(quiet = false) {
  if (!quiet) roleDetail.value = null;
  if (!roleName.value) return;
  detailLoading.value = !quiet;
  try {
    roleDetail.value = await get<RoleDetail>(`/api/roles/${encodeURIComponent(roleName.value)}`);
    const ai = roleDetail.value.defaults;
    const saved = ai.byBackend[ai.agent || options.value.globalDefaultBackend];
    roleAi.value = { agent: ai.agent, model: saved?.model ?? "", effort: saved?.effort ?? "" };
    roleAiDirty.value = false;
    roleText.value = roleDetail.value.role.own ?? roleDetail.value.role.source;
    dirty.value = false;
    showSource.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    detailLoading.value = false;
  }
}
async function roleAction(action: "customize" | "reset" | "merge") {
  const name = roleName.value!;
  if (action === "reset" && !(await confirmDialog(`把 ${name} 恢复为源码版本？`, { message: "你的自定义内容会移出知识库（Git 历史里仍可找回）；它的专属记忆和挂载技能的记录不受影响，但挂载写在自定义文件里，恢复后需要重新挂。", okText: "恢复源码版本", danger: true }))) return;
  try {
    const r = await post<{ merged?: boolean; conflicts?: number; runId?: string }>(`/api/roles/${encodeURIComponent(name)}/${action}`);
    if (action === "merge") toast(r.merged ? "已合并源码更新，没有冲突" : `${r.conflicts} 处冲突，已交给模型合并`, "ok", r.runId ? `#/runs/${r.runId}` : undefined);
    else toast(action === "customize" ? "已复制到知识库，可以改了" : "已恢复源码版本", "ok");
    await Promise.all([loadLists(), loadRole(true)]);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function saveRole() {
  saving.value = true;
  try {
    if (roleAiDirty.value) { await saveRoleAi(); if (roleAiDirty.value) return; }
    await put(`/api/roles/${encodeURIComponent(roleName.value!)}`, { raw: roleText.value });
    toast("已保存（之后的运行使用这个版本）", "ok");
    await Promise.all([loadLists(), loadRole()]);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
const sourceDiff = computed(() => (roleDetail.value ? compactDiff(diffLines(roleDetail.value.role.source, roleText.value)) : []));
const roleCustomized = computed(() => !!roleDetail.value?.role.customized);

// ---- skills ---------------------------------------------------------------------
const skillRaw = ref("");
const skillPath = ref("SKILL.md");
const skillFiles = ref<{ path: string; type: "file" | "directory" }[]>([]);
const collapsed = ref(new Set<string>());
const fileError = ref("");
const fileLoading = ref(false);
let fileRequest = 0;
const visibleFiles = computed(() => skillFiles.value.filter((f) => ![...collapsed.value].some((p) => f.path.startsWith(p + "/"))));
async function openSkillFile(path: string) {
  if (dirty.value && !(await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true }))) return;
  const request = ++fileRequest;
  skillPath.value = path; skillRaw.value = ""; dirty.value = false; fileError.value = ""; fileLoading.value = true;
  try {
    const result = await get<{ raw: string }>(`/api/skills/${encodeURIComponent(skillName.value!)}/file?path=${encodeURIComponent(path)}`);
    if (request === fileRequest) skillRaw.value = result.raw;
  } catch (e) { if (request === fileRequest) fileError.value = (e as Error).message; }
  finally { if (request === fileRequest) fileLoading.value = false; }
}
function pickSkillFile(f: { path: string; type: string }) {
  if (f.type === "directory") { if (collapsed.value.has(f.path)) collapsed.value.delete(f.path); else collapsed.value.add(f.path); }
  else void openSkillFile(f.path);
}
async function newSkillFile() {
  const path = await promptDialog("新建技能文件", { message: "填写相对路径，如 references/checklist.md；目录会自动创建。", placeholder: "references/checklist.md" });
  if (!path) return;
  if (dirty.value && !(await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true }))) return;
  try {
    await put(`/api/skills/${encodeURIComponent(skillName.value!)}/file`, { path, raw: "", create: true });
    skillFiles.value = await get(`/api/skills/${encodeURIComponent(skillName.value!)}/files`);
    dirty.value = false; await openSkillFile(path); await loadLists();
  } catch (e) { toast((e as Error).message, "error"); }
}
async function removeSkillFile() {
  if (!(await confirmDialog("删除这个文件？", { message: skillPath.value, danger: true, okText: "删除" }))) return;
  try {
    await del(`/api/skills/${encodeURIComponent(skillName.value!)}/file?path=${encodeURIComponent(skillPath.value)}`);
    dirty.value = false; await loadSkill(); await loadLists();
  } catch (e) { toast((e as Error).message, "error"); }
}
const newSkill = ref({ name: "", description: "", body: "## 什么时候用\n\n……\n\n## 步骤\n\n1. ……\n\n## 检查\n\n- ……" });
async function loadSkill() {
  skillRaw.value = "";
  if (!skillName.value) return;
  detailLoading.value = true;
  try {
    skillFiles.value = await get(`/api/skills/${encodeURIComponent(skillName.value)}/files`);
    dirty.value = false; collapsed.value.clear();
    await openSkillFile("SKILL.md");
    dirty.value = false;
  } finally {
    detailLoading.value = false;
  }
}
async function saveSkill() {
  saving.value = true;
  try {
    if (creating.value) {
      const s = newSkill.value;
      if (!NAME.test(s.name)) throw new Error("名称只能用小写字母、数字和连字符");
      if (skills.value.some((x) => x.name === s.name)) throw new Error("已有同名技能");
      if (!s.description.trim()) throw new Error("写一句：做什么、什么时候用");
      await put(`/api/library-files/skill/${s.name}`, { raw: `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description.trim())}\n---\n\n${s.body.trim()}\n` });
      dirty.value = false;
      await loadLists();
      await router.replace({ query: { tab: "skills", name: s.name } });
    } else {
      await put(`/api/skills/${encodeURIComponent(skillName.value!)}/file`, { path: skillPath.value, raw: skillRaw.value });
      dirty.value = false;
      await loadLists();
    }
    toast("已保存（知识库 Git 中有历史）", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
const currentSkill = computed(() => skills.value.find((s) => s.name === skillName.value));
async function approveSkill() {
  if (skillPath.value !== "SKILL.md") { await openSkillFile("SKILL.md"); if (skillPath.value !== "SKILL.md") return; }
  skillRaw.value = skillRaw.value.replace(/^status:\s*draft\s*\n/m, "");
  await saveSkill();
}
async function removeSkill() {
  if (!skillName.value || !(await confirmDialog(`删除技能 ${skillName.value}？`, { message: "文件的历史仍保留在知识库 Git 中；挂载它的档案会显示为已不存在。", okText: "删除", danger: true }))) return;
  await del(`/api/skills/${encodeURIComponent(skillName.value)}`);
  dirty.value = false;
  await router.replace({ query: { tab: "skills" } });
  await loadLists();
}

// ---- navigation -------------------------------------------------------------------
async function go(query: Record<string, string>) {
  if (dirty.value && !(await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true }))) return;
  dirty.value = false;
  await router.replace({ query });
}
onBeforeRouteLeave(async () => !dirty.value || (await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true })));
async function loadCurrent() {
  rawMode.value = false;
  if (creating.value) {
    if (tab.value === "agents") startNew();
    else newSkill.value = { name: "", description: "", body: newSkill.value.body };
    return;
  }
  await Promise.all([loadSpec(), loadRole(), loadSkill()]);
}
onMounted(async () => {
  await Promise.all([loadLists(), get<Options>("/api/profile-options").then((o) => (options.value = o)).catch(() => {})]);
  await loadCurrent();
});
watch(() => [route.query.tab, route.query.name, route.query.role, route.query.new], () => void loadCurrent());
const empty = computed(() => !creating.value && !specName.value && !roleName.value && !skillName.value);
</script>

<template>
  <ReviewSettings v-if="tab === 'review'">
    <template #tabs>
      <div class="head row">
        <button class="tab" @click="go({ tab: 'agents' })">Agent 档案</button>
        <button class="tab" @click="go({ tab: 'skills' })">技能</button>
        <button class="tab on">评审</button>
      </div>
    </template>
  </ReviewSettings>
  <div v-else class="agents">
    <aside class="list-col">
      <div class="head row">
        <button class="tab" :class="{ on: tab === 'agents' }" @click="go({ tab: 'agents' })">Agent 档案</button>
        <button class="tab" :class="{ on: tab === 'skills' }" @click="go({ tab: 'skills' })">技能</button>
        <button class="tab" @click="go({ tab: 'review' })">评审</button>
        <span class="spacer" />
        <button class="btn ghost sm icon" :title="tab === 'agents' ? '新建 Agent 档案' : '新建技能'" @click="go({ tab, new: '1' })"><Icon name="plus" :size="15" /></button>
      </div>
      <div class="items">
        <Skeleton v-if="loading" :rows="6" />
        <template v-else-if="tab === 'agents'">
          <div class="group">我的档案</div>
          <button v-for="x in specs" :key="x.name" class="li" :class="{ on: x.name === specName }" @click="go({ tab: 'agents', name: x.name })">
            <div class="grow">
              <div class="row"><strong class="ellipsis">{{ x.name }}</strong><span v-if="x.status === 'draft'" class="badge">草稿</span><span v-if="x.plugin" class="badge" :title="`来自插件 ${x.plugin}`">插件</span></div>
              <div class="muted small clamp">{{ x.description }}</div>
            </div>
          </button>
          <p v-if="!specs.length" class="muted small hint">还没有。点右上角 ＋ 新建，或对助理说“建一个负责代码评审的 Agent，用 codex，只读”。</p>
          <div class="group">内置角色</div>
          <button v-for="r in roles" :key="r.name" class="li" :class="{ on: r.name === roleName }" @click="go({ tab: 'agents', role: r.name })">
            <div class="grow">
              <div class="row">
                <strong class="ellipsis mono">{{ r.name }}</strong>
                <span v-if="r.sourceChanged" class="badge warn" title="自定义之后源码有更新">源码有更新</span>
                <span v-else-if="r.customized" class="badge accent">已自定义</span>
              </div>
              <div class="muted small clamp">{{ r.description }}</div>
            </div>
          </button>
        </template>
        <template v-else>
          <button v-for="x in skills" :key="x.name" class="li" :class="{ on: x.name === skillName }" @click="go({ tab: 'skills', name: x.name })">
            <div class="grow">
              <div class="row"><strong class="ellipsis">{{ x.name }}</strong><span v-if="x.status === 'draft'" class="badge">草稿</span></div>
              <div class="muted small clamp">{{ x.description }}</div>
            </div>
          </button>
          <p v-if="!skills.length" class="muted small hint">还没有技能。点 ＋ 新建，或对助理说“把刚才整理周报的做法记成技能”。</p>
        </template>
      </div>
    </aside>

    <main class="detail">
      <div v-if="empty" class="empty">
        <Icon name="layers" :size="34" />
        <h3>{{ tab === "agents" ? "Agent 档案" : "技能" }}</h3>
        <p v-if="tab === 'agents'">专门做某类事的 Agent：用途、提示词、后端与模型、可用工具、技能、工作目录。内置角色是 omem 自己调用的（独立评审、编码、整理…），也可以自定义。它们都会随使用积累专属记忆，复盘后提出改进建议。</p>
        <p v-else>可复用的做法（SKILL.md）。挂到档案上，它做对应的事之前会先读全文照做。草稿启用后才会出现在目录里。</p>
        <button class="btn" @click="go({ tab, new: '1' })"><Icon name="plus" :size="14" />{{ tab === "agents" ? "新建 Agent 档案" : "新建技能" }}</button>
      </div>
      <div v-else-if="detailLoading" class="pad"><Skeleton variant="lines" :rows="14" /></div>

      <!-- agent spec: new or existing -->
      <div v-else-if="tab === 'agents' && (creating || specDetail)" class="page">
        <header class="dh row">
          <h2 v-if="creating">新建 Agent 档案</h2>
          <h2 v-else class="mono">{{ specName }}</h2>
          <span v-if="specDetail?.status === 'draft'" class="badge">草稿</span>
          <span class="spacer" />
          <button v-if="!creating" class="btn ghost sm" @click="toggleRaw">{{ rawMode ? "表单" : "原文" }}</button>
          <button v-if="specDetail?.status === 'draft'" class="btn sm" @click="approveSpec"><Icon name="check" :size="14" />启用</button>
          <button class="btn sm primary" :disabled="saving || (!creating && !dirty)" @click="saveSpec">{{ creating ? "创建" : "保存" }}</button>
          <button v-if="!creating" class="btn ghost sm icon danger" title="删除" @click="removeSpec"><Icon name="trash" :size="14" /></button>
        </header>

        <textarea v-if="rawMode" v-model="raw" class="editor mono raw" spellcheck="false" aria-label="档案原文" @input="dirty = true" />
        <div v-else class="form">
          <label v-if="creating" class="field">
            <span>名称</span>
            <input v-model.trim="form.name" class="input mono" placeholder="如 code-reviewer" autofocus @input="dirty = true" />
            <small v-if="nameError" class="error">{{ nameError }}</small>
            <small v-else class="muted">小写字母、数字和连字符；在聊天里用 <code>/as 名称</code> 叫它</small>
          </label>
          <label class="field">
            <span>用途</span>
            <textarea v-model="form.description" class="input" rows="2" placeholder="做什么、什么时候交给它（助理按这句挑人）" @input="dirty = true" />
          </label>
          <AiDefaults :model-value="form" :backends="options.backends" :default-backend="options.defaultBackend" @update:model-value="(v) => Object.assign(form, v)" @change="dirty = true" />
          <div class="grid">
            <div class="field">
              <span>空间</span>
              <UiSelect :model-value="form.space ?? ''" :options="spaceOptions" aria-label="空间" @change="(v) => ((form.space = v || undefined), (dirty = true))" />
            </div>
          </div>
          <label class="field">
            <span>工作目录</span>
            <input v-model="form.cwd" class="input mono" placeholder="不填：空间关联的目录（代码仓库空间就是仓库）" @input="dirty = true" />
          </label>
          <div class="field">
            <span>omem 工具</span>
            <ChipPicker v-model="formTools" :options="toolOptions" add-label="＋ 工具" />
            <small class="muted">不选时用默认的只读工具（{{ options.defaultTools.length }} 个：检索、读原件、读记忆和会话等）</small>
          </div>
          <div class="field">
            <span>还能读的空间</span>
            <ChipPicker v-model="formSpaces" :options="readableOptions" add-label="＋ 空间" />
          </div>
          <div v-if="creating" class="field">
            <span>技能</span>
            <ChipPicker v-model="formSkills" :options="skillOptions" add-label="＋ 技能" />
          </div>
          <div class="field switch">
            <UiCheckbox v-model="form.writes" switch @change="dirty = true">可以改工作目录里的文件</UiCheckbox>
          </div>
          <p v-if="mcpNames.length" class="muted small">额外 MCP：{{ mcpNames.join("、") }}（在“原文”里改）</p>
          <label class="field">
            <span>提示词</span>
            <textarea v-model="form.prompt" class="editor mono" spellcheck="false" @input="dirty = true" />
            <small class="muted">只写稳定的职责和工作原则；可复用的步骤做成技能，偏好和经验让它记成专属记忆。</small>
          </label>
          <details class="field" :open="!!form.instructions">
            <summary class="small">工作约定（AGENTS.md 式，可选）</summary>
            <textarea v-model="form.instructions" class="input mono" rows="5" @input="dirty = true" />
          </details>
        </div>

        <ProfileLearning v-if="specDetail && !creating" :name="specName!" :detail="specDetail" :current-prompt="specDetail.prompt" @changed="loadSpec(true)" />
      </div>

      <!-- built-in role -->
      <div v-else-if="tab === 'agents' && roleDetail" class="page">
        <header class="dh row">
          <h2 class="mono">{{ roleName }}</h2>
          <span class="badge">内置</span>
          <span v-if="roleDetail.role.sourceChanged" class="badge warn">源码有更新</span>
          <span v-else-if="roleCustomized" class="badge accent">已自定义</span>
          <span class="spacer" />
          <template v-if="!roleCustomized">
            <button class="btn sm primary" @click="roleAction('customize')"><Icon name="edit" :size="14" />自定义</button>
          </template>
          <template v-else>
            <button v-if="roleDetail.role.sourceChanged" class="btn sm" title="把源码的更新合并进你的版本；冲突交给模型" @click="roleAction('merge')">合并源码更新</button>
            <button class="btn ghost sm" @click="showSource = !showSource">{{ showSource ? "编辑" : "对比源码" }}</button>
            <button class="btn ghost sm" @click="roleAction('reset')">恢复源码版本</button>
            <button class="btn sm primary" :disabled="saving || !dirty" @click="saveRole">保存</button>
          </template>
        </header>
        <div class="card pad role-ai">
          <div class="row wrap"><strong>默认 AI</strong><span class="spacer" /><button class="btn sm primary" :disabled="saving || !roleAiDirty" @click="saveRoleAi">保存默认 AI</button></div>
          <p class="muted small">这个角色平时用的 AI。助手为某个任务临时换用时不改这里。</p>
          <AiDefaults :model-value="roleAi" :backends="options.backends" :default-backend="options.globalDefaultBackend" @update:model-value="updateRoleAi" />
        </div>
        <p class="muted small meta">{{ roleDetail.description }} · 工具 {{ roleDetail.tools.length ? roleDetail.tools.join(", ") : "无" }}<span v-if="roleDetail.writes"> · 可改文件</span></p>
        <p v-if="!roleCustomized" class="muted small">这是 omem 源码里的版本。自定义会把它复制到知识库（<code>_roles/{{ roleName }}.md</code>），之后的运行用你的版本；omem 更新了这个角色时这里会提示，可以合并或恢复。</p>
        <div v-if="!roleCustomized" class="card pad doc"><Markdown :source="roleDetail.body" /></div>
        <div v-else-if="showSource" class="diff">
          <div v-for="(l, i) in sourceDiff" :key="i" :class="l.op === '+' ? 'a' : l.op === '-' ? 'r' : l.op === '…' ? 'gap' : ''">{{ l.op === "…" ? "…" : `${l.op === "=" ? " " : l.op} ${l.text}` }}</div>
          <p v-if="!sourceDiff.some((l) => l.op === '+' || l.op === '-')" class="muted small pad">和源码一样。</p>
        </div>
        <textarea v-else v-model="roleText" class="editor mono raw" spellcheck="false" aria-label="角色原文" @input="dirty = true" />
        <ProfileLearning :name="roleName!" :detail="roleDetail" :current-prompt="roleDetail.body" @changed="loadRole(true)" />
      </div>

      <!-- skill -->
      <div v-else-if="tab === 'skills' && creating" class="page">
        <header class="dh row">
          <h2>新建技能</h2>
          <span class="spacer" />
          <button class="btn sm primary" :disabled="saving" @click="saveSkill">创建</button>
        </header>
        <div class="form">
          <label class="field"><span>名称</span><input v-model.trim="newSkill.name" class="input mono" placeholder="如 weekly-report" autofocus @input="dirty = true" /></label>
          <label class="field"><span>说明</span><input v-model="newSkill.description" class="input" placeholder="做什么、什么时候用" @input="dirty = true" /></label>
          <label class="field"><span>正文</span><textarea v-model="newSkill.body" class="editor mono" spellcheck="false" @input="dirty = true" /></label>
        </div>
      </div>
      <div v-else-if="tab === 'skills' && skillName" class="page">
        <header class="dh row">
          <h2 class="mono">{{ skillName }}</h2>
          <span v-if="currentSkill?.status === 'draft'" class="badge">草稿</span>
          <span class="spacer" />
          <button v-if="currentSkill?.status === 'draft'" class="btn sm" @click="approveSkill"><Icon name="check" :size="14" />启用</button>
          <button class="btn sm primary" :disabled="saving || !dirty" @click="saveSkill">保存</button>
          <button v-if="currentSkill" class="btn ghost sm icon danger" title="删除" @click="removeSkill"><Icon name="trash" :size="14" /></button>
        </header>
        <div class="skill-workspace">
          <nav class="file-tree" aria-label="技能文件目录">
            <button class="btn ghost sm" @click="newSkillFile"><Icon name="plus" :size="14" />新建文件</button>
            <VirtualList :items="visibleFiles" :item-key="(f) => f.path" :estimate="34">
              <template #default="{ item: f }"><button class="file-row" :class="{ selected: f.path === skillPath }" :style="{ paddingLeft: `${8 + Math.min(f.path.split('/').length - 1, 6) * 12}px` }" :aria-expanded="f.type === 'directory' ? !collapsed.has(f.path) : undefined" :title="f.path" @click="pickSkillFile(f)"><span>{{ f.type === 'directory' ? (collapsed.has(f.path) ? '▸' : '▾') : '·' }}</span><span class="file-name">{{ f.path.split('/').at(-1) }}</span></button></template>
            </VirtualList>
          </nav>
          <div class="file-editor">
            <div class="row wrap small"><code class="file-name">{{ skillPath }}</code><span class="spacer" /><button v-if="skillPath !== 'SKILL.md' && !fileError && !fileLoading" class="btn ghost sm danger" @click="removeSkillFile">删除文件</button></div>
            <Skeleton v-if="fileLoading" variant="lines" :rows="10" />
            <p v-else-if="fileError" class="muted">{{ fileError }}</p>
            <textarea v-else v-model="skillRaw" class="editor mono raw" spellcheck="false" :aria-label="`技能文件 ${skillPath}`" @input="dirty = true" />
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.role-ai { margin-bottom: 20px; }
.skill-workspace { display: grid; grid-template-columns: minmax(140px, 210px) minmax(0, 1fr); gap: 16px; }
.file-tree { max-height: 560px; overflow: auto; border-right: 1px solid var(--line); padding-right: 8px; }
.file-row { display: flex; gap: 6px; width: 100%; text-align: left; padding: 7px 8px; border: 0; background: transparent; color: var(--ink-2); border-radius: 4px; }
.file-row.selected { background: var(--accent-soft); color: var(--accent); }
.file-name { overflow-wrap: anywhere; min-width: 0; }
.file-editor { min-width: 0; }
.file-editor > .row { margin-bottom: 10px; }
.dh { flex-wrap: wrap; }
.dh h2 { overflow-wrap: anywhere; min-width: 0; }
@media (max-width: 760px) { .skill-workspace { grid-template-columns: 1fr; } .file-tree { max-height: 220px; border-right: 0; border-bottom: 1px solid var(--line); padding-bottom: 10px; } }

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
  padding: 10px 12px;
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
.group {
  font-size: 11px;
  color: var(--muted);
  padding: 10px 10px 4px;
  letter-spacing: 0.04em;
}
.hint {
  padding: 2px 10px 6px;
  margin: 0;
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
  overflow-y: auto;
}
.page {
  max-width: 920px;
  padding: 16px 24px 40px;
  display: grid;
  gap: 14px;
}
.dh {
  flex-wrap: wrap;
  gap: 8px;
}
.dh h2 {
  margin: 0;
  font-size: 18px;
}
.meta {
  margin: -6px 0 0;
}
.form {
  display: grid;
  gap: 12px;
}
.field {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.field > span,
.field > summary {
  font-size: 12px;
  color: var(--ink-2);
}
.field.switch {
  display: flex;
}
.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.error {
  color: var(--danger);
}
.editor {
  width: 100%;
  min-height: 280px;
  resize: vertical;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  font-size: 13px;
  line-height: 1.6;
  background: var(--panel, var(--bg));
  color: var(--ink);
}
.editor.raw {
  min-height: 420px;
}
.diff {
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 0;
  max-height: 520px;
  overflow: auto;
}
.diff > div {
  padding: 0 12px;
}
.diff .a {
  background: var(--ok-soft);
}
.diff .r {
  background: var(--danger-soft);
}
.diff .gap {
  color: var(--muted);
}
.doc {
  max-height: 420px;
  overflow: auto;
}
.empty {
  max-width: 560px;
  margin: 60px auto;
  text-align: center;
  color: var(--ink-2);
  padding: 0 16px;
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
  .page {
    padding: 12px 16px 32px;
  }
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
