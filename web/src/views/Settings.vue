<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { get, patch, post, put, type Space } from "../api";
import Icon from "../components/Icon.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import { fmtTime, kindLabel, loadSpaces, state, toast } from "../store";

type Profile = { id: string; name?: string; transport: string; command: string; args: string[]; model?: string; effort?: string; installed: boolean; install?: string };
type Schedule = { id: string; kind: string; cron: string; enabled: boolean; lastRunAt: string | null; config: Record<string, any> };
const tab = ref<"spaces" | "agents" | "schedules" | "search" | "lark" | "about">("spaces");
const config = ref<any>(null);
const profiles = ref<Profile[]>([]);
const home = ref("");
const schedules = ref<Schedule[]>([]);
const next = ref<Record<string, string | null>>({});
const labels = ref<Record<string, string>>({});
const newSpace = ref({ name: "", kind: "project", rootPath: "", description: "" });
const editing = ref<Space | null>(null);
const guide = ref("");
const profileJson = ref("");
type Policy = "ingest" | "involved" | "store" | "skip";
const larkChats = ref<{ chatId: string; name: string; mode: string; kind: string; muted: boolean; policy: Policy }[]>([]);
type Captured = { chatId: string; name: string; kind: string; muted: boolean; involved: boolean; lastMessageAt: string | null; policy: Policy; own: Policy | null };
const captured = ref<Captured[]>([]);
const capturedFilter = ref("");
const policyOptions: { value: Policy; label: string; hint: string }[] = [
  { value: "ingest", label: "保存并整理", hint: "每批新消息都交给助理整理成记忆和事项" },
  { value: "involved", label: "与我有关时整理", hint: "保存；本人发言、被 @ 或参与的话题有新消息时才整理" },
  { value: "store", label: "只保存", hint: "可检索、可引用，不整理" },
  { value: "skip", label: "不读取", hint: "" },
];
const policyLabel = Object.fromEntries(policyOptions.map((o) => [o.value, o.label])) as Record<Policy, string>;
const chatKindLabel: Record<string, string> = { p2p: "单聊", bot: "机器人单聊", "own-bot": "omem 机器人", group: "群聊", topic: "话题群" };
const policyKinds: [string, string, string][] = [
  ["p2p", "单聊（人）", "和同事的一对一聊天"],
  ["bot", "机器人单聊", "通知、审批、工单助手等应用发来的消息"],
  ["group", "普通群", ""],
  ["topic", "话题群", "按话题回复的群"],
  ["muted", "免打扰的会话", "你设置了免打扰的群和单聊，优先于上面的类型"],
];
async function loadCaptured() {
  captured.value = (await get<{ chats: Captured[] }>("/api/lark/captured").catch(() => ({ chats: [] as Captured[] }))).chats;
}
async function setChatPolicy(c: { chatId: string }, policy: Policy | "") {
  await put(`/api/lark/chats/${c.chatId}/policy`, { policy: policy || null });
  toast(policy ? `已改为：${policyLabel[policy]}` : "已恢复默认", "ok");
  void loadCaptured();
  if (larkChats.value.length) void loadLarkChats();
}
function setKindPolicy(kind: string, policy: Policy) {
  const capture = config.value.lark.capture;
  void saveConfig({ lark: { ...config.value.lark, capture: { ...capture, policies: { ...capture.policies, [kind]: policy } } } }, "已保存采集方式");
}
const shownCaptured = computed(() => {
  const f = capturedFilter.value.trim().toLowerCase();
  return captured.value.filter((c) => !f || c.name.toLowerCase().includes(f)).slice(0, 200);
});
const larkSubs = ref<{ chatId: string; name: string; spaceId: string; since?: string }[]>([]);
const larkError = ref("");
async function loadLark() {
  larkSubs.value = (await get<{ subscriptions: typeof larkSubs.value }>("/api/lark/subscriptions")).subscriptions;
}
async function loadLarkChats() {
  larkError.value = "";
  try {
    larkChats.value = (await get<{ chats: typeof larkChats.value }>("/api/lark/chats")).chats;
  } catch (e) {
    larkError.value = (e as Error).message;
  }
}
function subOf(chatId: string) {
  return larkSubs.value.find((s) => s.chatId === chatId);
}
async function toggleSub(c: { chatId: string; name: string }, spaceId?: string) {
  const exists = subOf(c.chatId);
  const next = exists && !spaceId ? larkSubs.value.filter((s) => s.chatId !== c.chatId) : [...larkSubs.value.filter((s) => s.chatId !== c.chatId), { chatId: c.chatId, name: c.name, spaceId: spaceId ?? state.space }];
  larkSubs.value = (await put<{ subscriptions: typeof larkSubs.value }>("/api/lark/subscriptions", { subscriptions: next })).subscriptions;
}
async function pollNow() {
  try {
    await post("/api/lark/poll");
    toast("采集完成，新消息交给助理整理", "ok");
    void loadLark();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

const roles = [
  ["assistant", "日常助理（问答、记忆、事项）"],
  ["ingest", "整理新材料"],
  ["wiki-planner", "规划 Wiki"],
  ["wiki-writer", "写 Wiki 页面"],
  ["wiki-linter", "检查受影响页面"],
  ["heartbeat", "巡检"],
  ["dreamer", "整理记忆"],
  ["coder", "编码"],
  ["reviewer", "评审"],
  ["tutor", "生成卡片"],
  ["brief", "简报"],
  ["curator", "筛选飞书群"],
  ["summarizer", "会话摘要"],
  ["memory-reviewer", "复核记忆"],
];

async function load() {
  const s = await get<{ config: any; agents: Profile[]; home: string }>("/api/settings");
  config.value = s.config;
  profiles.value = s.agents;
  home.value = s.home;
  const sc = await get<{ schedules: Schedule[]; next: Record<string, string | null>; labels: Record<string, string> }>("/api/schedules");
  schedules.value = sc.schedules;
  next.value = sc.next;
  labels.value = sc.labels;
}
onMounted(() => {
  void load();
  void loadLark();
  void loadCaptured();
});
// Opening the Agent tab fills role dropdowns from cached probes (probing once when there is none).
watch(
  () => [tab.value, profiles.value.length] as const,
  ([t]) => {
    if (t === "agents" && profiles.value.length) void loadProbes();
  },
);

async function saveConfig(partial: Record<string, unknown>, note = "已保存") {
  try {
    const r = await put<{ config: any }>("/api/settings", partial);
    config.value = r.config;
    toast(`${note}（部分设置需重启服务生效）`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function createSpace() {
  try {
    await post("/api/spaces", { name: newSpace.value.name, kind: newSpace.value.kind, rootPath: newSpace.value.rootPath || undefined, description: newSpace.value.description });
    toast(newSpace.value.rootPath ? "已创建，正在导入目录" : "已创建空间", "ok");
    newSpace.value = { name: "", kind: "project", rootPath: "", description: "" };
    await loadSpaces();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function openSpace(s: Space) {
  editing.value = { ...s, settings: { ...s.settings } };
  guide.value = (await get<{ guide: string }>(`/api/spaces/${s.id}`)).guide;
}
async function saveSpace() {
  if (!editing.value) return;
  await patch(`/api/spaces/${editing.value.id}`, { name: editing.value.name, description: editing.value.description, settings: editing.value.settings, guide: guide.value });
  toast("空间已保存", "ok");
  editing.value = null;
  await loadSpaces();
}
async function toggleSchedule(s: Schedule) {
  await put(`/api/schedules/${s.id}`, { enabled: !s.enabled });
  void load();
}
async function saveCron(s: Schedule, cron: string) {
  try {
    await put(`/api/schedules/${s.id}`, { cron });
    toast("已更新", "ok");
    void load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function saveScheduleConfig(s: Schedule, config: Record<string, unknown>) {
  await put(`/api/schedules/${s.id}`, { config: { ...s.config, ...config } });
  toast("已保存", "ok");
  void load();
}
async function runNow(s: Schedule) {
  await post(`/api/schedules/${s.id}/run`);
  toast("已触发", "ok", "#/runs");
}
const defaultProfile = computed({
  get: () => config.value?.agents.default ?? "",
  set: (v: string) => saveConfig({ agents: { ...config.value.agents, default: v || undefined } }),
});
function setRole(role: string, id: string) {
  const roles = { ...config.value.agents.roles };
  if (id) roles[role] = id;
  else delete roles[role];
  void saveConfig({ agents: { ...config.value.agents, roles } });
  const p = installedProfiles.value.find((x) => x.id === id);
  if (p && !probes.value[p.id]) void probe(p, false);
}
// Which backend a role actually uses (its own pick, else default, else first installed).
function roleProfileId(role: string): string {
  return config.value.agents.roles[role] ?? config.value.agents.default ?? installedProfiles.value[0]?.id ?? "";
}
function roleOverride(role: string): { model?: string; effort?: string } {
  return config.value.agents.roleModels?.[role]?.[roleProfileId(role)] ?? {};
}
/** Offered values for a role's backend; keeps a saved value visible even if the agent stopped listing it. */
function roleChoices(role: string, key: "model" | "effort"): { list: string[]; state: "ok" | "loading" | "none" } {
  const id = roleProfileId(role);
  const pr = probes.value[id];
  const saved = roleOverride(role)[key];
  if (pr?.loading && !pr.data) return { list: saved ? [saved] : [], state: "loading" };
  const offered = (key === "model" ? pr?.data?.models : pr?.data?.efforts) ?? [];
  const list = saved && !offered.includes(saved) ? [saved, ...offered] : offered;
  return { list, state: offered.length ? "ok" : "none" };
}
function profileDefault(role: string, key: "model" | "effort") {
  const p = profiles.value.find((x) => x.id === roleProfileId(role));
  return (key === "model" ? p?.model : p?.effort) ?? "";
}
async function setRoleModel(role: string, key: "model" | "effort", value: string) {
  await put("/api/agent-role-model", { role, profile: roleProfileId(role), [key]: value.trim() || null });
  toast(`已保存：${role} 的${key === "model" ? "模型" : "思考强度"}`, "ok");
  void load();
}
const fallbackText = computed({
  get: () => JSON.stringify(config.value?.agents.fallback ?? [], null, 2),
  set: (v: string) => (fallbackDraft.value = v),
});
const fallbackDraft = ref("");
const queueMinutes = computed({
  get: () => String(config.value?.agents.queueTimeoutMinutes ?? 30),
  set: () => {},
});
async function saveFallback() {
  let parsed: unknown;
  try {
    parsed = fallbackDraft.value.trim() ? JSON.parse(fallbackDraft.value) : [];
  } catch (e) {
    return toast(`JSON 不合法：${(e as Error).message}`, "error");
  }
  await saveConfig({ agents: { ...config.value.agents, fallback: parsed } }, "已保存兜底链");
  void load();
}
async function saveQueueMinutes() {
  const v = Math.max(1, Math.min(240, Number((document.getElementById("queue-min") as HTMLInputElement)?.value ?? 30) || 30));
  await saveConfig({ agents: { ...config.value.agents, queueTimeoutMinutes: v } }, `排队最多等待 ${v} 分钟`);
  void load();
}
async function addProfile() {
  try {
    const p = JSON.parse(profileJson.value);
    const list = [...config.value.agents.profiles.filter((x: Profile) => x.id !== p.id), p];
    await saveConfig({ agents: { ...config.value.agents, profiles: list } }, "已保存 Agent 配置");
    profileJson.value = "";
    void load();
  } catch (e) {
    toast(`配置不是合法 JSON：${(e as Error).message}`, "error");
  }
}
type ProbeData = { agent: string; models: string[]; efforts: string[]; error?: string; at?: string };
const probes = ref<Record<string, { loading?: boolean; error?: string; data?: ProbeData }>>({});
async function probe(p: Profile, refresh = true) {
  if (p.transport !== "acp") return;
  probes.value[p.id] = { ...(probes.value[p.id] ?? {}), loading: true };
  try {
    const data = await post<ProbeData>(`/api/agents/${p.id}/probe`, { refresh });
    probes.value[p.id] = data.error ? { error: data.error } : { data };
  } catch (e) {
    probes.value[p.id] = { error: (e as Error).message };
  }
}
/** Read cached probes (or probe once) for every installed ACP agent so role dropdowns can fill. */
async function loadProbes() {
  await Promise.all(installedProfiles.value.filter((p) => p.transport === "acp" && !probes.value[p.id]).map((p) => probe(p, false)));
}
async function setProfileOption(p: Profile, key: "model" | "effort", value: string) {
  const { installed, install, ...rest } = p;
  const next = { ...rest, [key]: value === "default" ? undefined : value };
  const list = [...config.value.agents.profiles.filter((x: Profile) => x.id !== p.id), next];
  await saveConfig({ agents: { ...config.value.agents, profiles: list } }, `${p.name ?? p.id}：${key} = ${value}`);
  void load();
}
const installedProfiles = computed(() => profiles.value.filter((p) => p.installed));
const profileOptions = computed(() => installedProfiles.value.map((p) => ({ value: p.id, label: p.name ?? p.id, hint: p.id })));
function saveReview(patch: Record<string, unknown>) {
  const memory = config.value.memory;
  void saveConfig({ memory: { ...memory, review: { ...memory.review, ...patch } } }, "已保存记忆复核设置");
}
const compareDraft = ref({ profile: "", model: "", effort: "" });
function addCompare() {
  if (!compareDraft.value.profile) return;
  const c = { profile: compareDraft.value.profile, ...(compareDraft.value.model.trim() ? { model: compareDraft.value.model.trim() } : {}), ...(compareDraft.value.effort.trim() ? { effort: compareDraft.value.effort.trim() } : {}) };
  void saveConfig({ memory: { ...config.value.memory, compare: [...config.value.memory.compare, c] } }, "已添加对比模型");
  compareDraft.value = { profile: "", model: "", effort: "" };
}
function removeCompare(i: number) {
  void saveConfig({ memory: { ...config.value.memory, compare: config.value.memory.compare.filter((_: unknown, j: number) => j !== i) } }, "已移除对比模型");
}
function modelOptionsFor(profileId: string | undefined, key: "model" | "effort", current?: string) {
  const offered = (key === "model" ? probes.value[profileId ?? ""]?.data?.models : probes.value[profileId ?? ""]?.data?.efforts) ?? [];
  const list = current && !offered.includes(current) ? [current, ...offered] : offered;
  return [{ value: "", label: "跟随默认" }, ...list.map((v) => ({ value: v, label: v }))];
}
const missingProfiles = computed(() => profiles.value.filter((p) => !p.installed));
type RegistryAgent = { id: string; name: string; version: string; description?: string; website?: string; added: boolean; ways: string[] };
const registry = ref<RegistryAgent[] | null>(null);
const registryBusy = ref("");
async function loadRegistry() {
  try {
    registry.value = await get("/api/agent-registry");
  } catch (e) {
    toast(`读取 ACP 注册表失败：${(e as Error).message}`, "error");
  }
}
async function addFromRegistry(a: RegistryAgent, via?: string) {
  registryBusy.value = a.id;
  try {
    const r = await post<{ profile: Profile }>(`/api/agent-registry/${a.id}`, via ? { via } : {});
    toast(`已添加 ${a.name}：${r.profile.command} ${r.profile.args.join(" ")}。第一次用前先在终端运行它登录。`);
    a.added = true;
    void load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    registryBusy.value = "";
  }
}
const editingProfile = ref<string | null>(null);
const editJson = ref("");
function editProfile(p: Profile) {
  const { installed, install, ...rest } = p;
  editingProfile.value = editingProfile.value === p.id ? null : p.id;
  editJson.value = JSON.stringify(rest, null, 2);
}
async function saveEdit() {
  try {
    const p = JSON.parse(editJson.value);
    if (!p.id) return toast("配置需要 id", "error");
    const list = [...config.value.agents.profiles.filter((x: Profile) => x.id !== p.id && x.id !== editingProfile.value), p];
    await saveConfig({ agents: { ...config.value.agents, profiles: list } }, `已保存 ${p.name ?? p.id}`);
    editingProfile.value = null;
    void load();
  } catch (e) {
    toast(`配置不是合法 JSON：${(e as Error).message}`, "error");
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head"><div><h1>设置</h1><p v-if="home" class="mono small">数据目录：{{ home }}</p></div></div>
    <div class="tabs">
      <button v-for="[k, l] in [['spaces', '空间'], ['agents', 'Agent'], ['schedules', '定时任务'], ['search', '检索'], ['lark', '渠道'], ['about', '外观与说明']]" :key="k" :class="{ on: tab === k }" @click="tab = k as any">{{ l }}</button>
    </div>

    <section v-if="tab === 'spaces'" class="stack">
      <p class="muted">空间把不同领域的知识分开：每个空间有自己的原件、Wiki、记忆和事项。助理默认只在当前空间调查，需要时才跨空间。代码仓库空间关联一个本地目录，可定期同步。</p>
      <div class="spaces">
        <div v-for="s in state.spaces" :key="s.id" class="card pad sp">
          <div class="row"><strong>{{ s.name }}</strong><span class="badge">{{ kindLabel[s.kind] ?? s.kind }}</span><span class="spacer" /><button class="btn ghost sm" @click="openSpace(s)"><Icon name="edit" :size="14" />设置</button></div>
          <div class="muted small">{{ s.description || "（没有说明）" }}</div>
          <div class="muted small mono" v-if="s.rootPath">{{ s.rootPath }}</div>
          <div class="muted small">{{ s.sources ?? 0 }} 份原件 · {{ s.pages ?? 0 }} 个页面</div>
        </div>
      </div>
      <form class="card pad stack" @submit.prevent="createSpace">
        <strong>新建空间</strong>
        <div class="grid2">
          <label class="field"><span>名称</span><input v-model="newSpace.name" class="input" required placeholder="例如：项目A、英语学习、omem 仓库" /></label>
          <div class="field"><span>类型</span><UiSelect v-model="newSpace.kind" aria-label="空间类型" :options="[{ value: 'project', label: '项目' }, { value: 'repo', label: '代码仓库' }, { value: 'learning', label: '学习' }, { value: 'topic', label: '主题' }]" /></div>
        </div>
        <label class="field"><span>关联目录（代码仓库或文档目录，可选）</span><input v-model="newSpace.rootPath" class="input mono" placeholder="E:\Projects\omem 或 /home/me/code/app" /><span class="hint">填写后会导入目录下的文本文件（遵守 .gitignore），之后可同步更新。</span></label>
        <label class="field"><span>说明</span><input v-model="newSpace.description" class="input" placeholder="这个空间收什么、给谁读" /></label>
        <div class="row"><span class="spacer" /><button class="btn primary" :disabled="!newSpace.name">创建</button></div>
      </form>
    </section>

    <section v-else-if="tab === 'agents' && config" class="stack">
      <p class="muted">omem 不内置模型：理解、写作和编码交给你已安装并登录的 Agent（通过 ACP 或命令行）。不同角色可以用不同 Agent，例如问答用快的模型，Wiki 和评审用强的模型。</p>
      <div class="card">
        <template v-for="p in installedProfiles" :key="p.id">
          <div class="prow">
            <span class="badge ok">已安装</span>
            <div class="grow">
              <div><strong>{{ p.name ?? p.id }}</strong> <span class="muted small mono">{{ p.id }}</span></div>
              <div class="muted small mono">{{ p.transport }} · {{ p.command }} {{ p.args.join(" ") }}<template v-if="p.model"> · {{ p.model }}</template><template v-if="p.effort"> · {{ p.effort }}</template></div>
            </div>
            <button v-if="p.transport === 'acp'" class="btn ghost sm" :disabled="probes[p.id]?.loading" @click="probe(p)">{{ probes[p.id]?.loading ? "检测中…" : "检测模型" }}</button>
            <button class="btn ghost sm" @click="editProfile(p)">{{ editingProfile === p.id ? "收起" : "编辑" }}</button>
          </div>
          <div v-if="editingProfile === p.id" class="edit-box stack">
            <textarea v-model="editJson" class="textarea mono" rows="9" />
            <div class="row"><span class="muted small">model、effort 写 Agent 支持的值；不区分大小写和点/连字符。</span><span class="spacer" /><button class="btn ghost sm" @click="editingProfile = null">取消</button><button class="btn primary sm" @click="saveEdit">保存</button></div>
          </div>
        </template>
        <div v-if="!installedProfiles.length" class="prow muted">还没有可用的 Agent，从下面任选一个安装。</div>
        <details v-if="missingProfiles.length" class="more">
          <summary class="small muted">其他支持的 Agent（{{ missingProfiles.length }} 个，未安装）</summary>
          <div v-for="p in missingProfiles" :key="p.id" class="prow">
            <span class="badge">未找到</span>
            <div class="grow">
              <div><strong>{{ p.name ?? p.id }}</strong> <span class="muted small mono">{{ p.command }} {{ p.args.join(" ") }}</span></div>
              <div v-if="p.install" class="muted small mono">安装：{{ p.install }}</div>
            </div>
            <button class="btn ghost sm" @click="editProfile(p)">{{ editingProfile === p.id ? "收起" : "编辑" }}</button>
          </div>
          <template v-for="p in missingProfiles" :key="'edit-' + p.id">
            <div v-if="editingProfile === p.id" class="edit-box stack">
              <textarea v-model="editJson" class="textarea mono" rows="9" />
              <div class="row"><span class="spacer" /><button class="btn ghost sm" @click="editingProfile = null">取消</button><button class="btn primary sm" @click="saveEdit">保存</button></div>
            </div>
          </template>
        </details>
        <template v-for="p in profiles" :key="'probe-' + p.id">
          <div v-if="probes[p.id]?.data || probes[p.id]?.error" class="probe">
            <div class="small muted">{{ p.name ?? p.id }}：{{ probes[p.id].error ?? probes[p.id].data!.agent }}</div>
            <div v-if="probes[p.id].data?.models.length" class="row wrap small">
              <span class="muted">默认模型：</span>
              <button v-for="v in probes[p.id].data!.models" :key="v" class="chip" :class="{ on: p.model === v }" @click="setProfileOption(p, 'model', v)">{{ v }}</button>
            </div>
            <div v-if="probes[p.id].data?.efforts.length" class="row wrap small">
              <span class="muted">默认思考强度：</span>
              <button v-for="v in probes[p.id].data!.efforts" :key="v" class="chip" :class="{ on: p.effort === v }" @click="setProfileOption(p, 'effort', v)">{{ v }}</button>
            </div>
          </div>
        </template>
      </div>
      <div class="card pad stack">
        <div class="row"><div class="section-title grow">ACP 注册表</div><button class="btn ghost sm" @click="loadRegistry">{{ registry ? "刷新" : "浏览" }}</button></div>
        <p class="muted small">任何支持 Agent Client Protocol 的 Agent 都能接入。这里列出官方注册表里的 Agent，可以用 npx / uvx 运行，或下载对应平台的程序到数据目录。</p>
        <div v-for="a in registry ?? []" :key="a.id" class="prow">
          <div class="grow">
            <div><strong>{{ a.name }}</strong> <span class="muted small mono">{{ a.id }} v{{ a.version }}</span></div>
            <div v-if="a.description" class="muted small">{{ a.description }}</div>
          </div>
          <span v-if="a.added" class="badge ok">已可用</span>
          <template v-else>
            <button v-for="w in a.ways" :key="w" class="btn ghost sm" :disabled="!!registryBusy" @click="addFromRegistry(a, w)">{{ registryBusy === a.id ? "添加中…" : w === "binary" ? "下载" : w }}</button>
            <span v-if="!a.ways.length" class="muted small">本机不可用</span>
          </template>
        </div>
      </div>
      <div class="field"><span>默认 Agent</span>
        <UiSelect v-model="defaultProfile" width="320px" aria-label="默认 Agent" :options="[{ value: '', label: '自动（第一个已安装的）' }, ...profileOptions]" />
      </div>
      <div class="card pad">
        <div class="section-title">按角色指定</div>
        <p class="muted small">每类任务可以用不同 Agent，并单独选该 Agent 的模型和思考强度。可选项来自 Agent 自己的检测结果（缓存，在上面点“检测模型”可刷新）；不选则跟随 Agent 默认。</p>
        <div class="roles">
          <div v-for="[r, l] in roles" :key="r" class="role-row">
            <div class="row role"><span class="grow">{{ l }}</span>
              <UiSelect :model-value="config.agents.roles[r] ?? ''" size="sm" width="200px" :aria-label="`${l} 的 Agent`" :options="[{ value: '', label: '默认' }, ...profileOptions]" @change="(v) => setRole(r, v)" />
            </div>
            <div class="row role-model">
              <template v-for="k in (['model', 'effort'] as const)" :key="k">
                <UiSelect
                  v-if="roleChoices(r, k).state !== 'none'"
                  :model-value="roleOverride(r)[k] ?? ''"
                  size="sm"
                  :aria-label="k === 'model' ? '模型' : '思考强度'"
                  :disabled="roleChoices(r, k).state === 'loading'"
                  :options="[{ value: '', label: roleChoices(r, k).state === 'loading' ? '检测中…' : `跟随默认${profileDefault(r, k) ? `（${profileDefault(r, k)}）` : ''}` }, ...roleChoices(r, k).list.map((v) => ({ value: v, label: v }))]"
                  @change="(v) => setRoleModel(r, k, v)"
                />
                <input v-else class="input sm" :value="roleOverride(r)[k] ?? ''" :placeholder="k === 'model' ? '模型（Agent 未报出可选项，可手填）' : '思考强度'" @change="setRoleModel(r, k, ($event.target as HTMLInputElement).value)" />
              </template>
            </div>
          </div>
        </div>
      </div>
      <div class="card pad stack">
        <div class="section-title">排队与兜底</div>
        <p class="muted small">主后端排队（traex 资源队列）或被限流时，按顺序换下面的后端/模型重试一轮；Agent 档案任务不自动改道。排队时普通空闲计时暂停，最多等设定的分钟数。</p>
        <label class="field"><span>排队最多等待（分钟，1–240）</span>
          <input id="queue-min" class="input" style="width: 120px" type="number" inputmode="numeric" min="1" max="240" :value="queueMinutes" @change="saveQueueMinutes" />
        </label>
        <textarea class="textarea mono" rows="7" :value="fallbackText" @input="fallbackDraft = ($event.target as HTMLTextAreaElement).value" placeholder='[{"profile":"traex","model":"Doubao-Seed-2.1-Pro"}]&#10;[{"profile":"codex-sol","effort":"low"}]' />
        <div class="row"><span class="muted small">每项：后端 id 必填，model/effort 可覆盖。留空数组 [] 表示不兜底。</span><span class="spacer" /><button class="btn primary sm" @click="saveFallback">保存兜底链</button></div>
      </div>
      <div v-if="config.memory" class="card pad stack">
        <div class="section-title">记忆质量</div>
        <p class="muted small">新记忆写入前会先过一遍规则检查（免责式、太长、转述原件、事件复述、无来源、重复），不合格的退回给模型并说明原因。之后每小时由复核模型逐条保留、改写或撤回；复核模型最好和写入的不是同一个，避免一个模型的习惯由它自己评判。结果在“记忆 → 质量”里按模型统计。</p>
        <UiCheckbox :model-value="config.memory.review.enabled" switch @change="(v) => saveReview({ enabled: v })">复核新记忆（只有复核保留或本人写的经验、偏好才会放进每次运行的提示里）</UiCheckbox>
        <div class="row wrap">
          <span class="small muted">复核用</span>
          <UiSelect :model-value="config.memory.review.profile ?? ''" size="sm" width="200px" aria-label="复核后端" :options="[{ value: '', label: '按角色“复核记忆”的设置' }, ...profileOptions]" @change="(v) => saveReview({ profile: v || undefined })" />
          <UiSelect :model-value="config.memory.review.model ?? ''" size="sm" width="180px" aria-label="复核模型" :options="modelOptionsFor(config.memory.review.profile, 'model', config.memory.review.model)" @change="(v) => saveReview({ model: v || undefined })" />
          <UiSelect :model-value="config.memory.review.effort ?? ''" size="sm" width="120px" aria-label="复核强度" :options="modelOptionsFor(config.memory.review.profile, 'effort', config.memory.review.effort)" @change="(v) => saveReview({ effort: v || undefined })" />
        </div>
        <div class="section-title" style="margin-top: 8px">对比运行</div>
        <p class="muted small">每次整理新材料时，再用下面的模型各跑一遍：它们的写入只记录不生效，经过同样的检查和复核，用来横向比较哪个模型记得更好。每多一个模型，整理的花费多一份。</p>
        <div v-for="(c, i) in config.memory.compare" :key="i" class="row cmp-row">
          <span class="mono small grow">{{ [c.profile, c.model, c.effort].filter(Boolean).join(" · ") }}</span>
          <button class="btn ghost sm icon" aria-label="移除" @click="removeCompare(i)"><Icon name="x" :size="14" /></button>
        </div>
        <div class="row wrap">
          <UiSelect v-model="compareDraft.profile" size="sm" width="200px" aria-label="对比后端" placeholder="选择后端" :options="profileOptions" />
          <UiSelect v-if="(probes[compareDraft.profile]?.data?.models.length ?? 0) > 0" v-model="compareDraft.model" size="sm" width="180px" aria-label="对比模型" :options="modelOptionsFor(compareDraft.profile, 'model')" />
          <input v-else v-model="compareDraft.model" class="input sm-input" placeholder="模型（可选）" />
          <input v-model="compareDraft.effort" class="input sm-input" style="width: 110px" placeholder="强度（可选）" />
          <button class="btn sm" :disabled="!compareDraft.profile" @click="addCompare">添加</button>
        </div>
      </div>
      <div class="card pad stack">
        <div class="section-title">添加或修改 Agent 配置</div>
        <textarea v-model="profileJson" class="textarea mono" rows="9" placeholder='{"id":"codex-sol","name":"Codex · Sol","transport":"acp","command":"codex-acp","args":[],"model":"gpt-6.1-sol","effort":"low"}' />
        <div class="row"><span class="muted small">transport：acp / claude-cli / codex-cli。model、effort 必须是该 Agent 支持的值。</span><span class="spacer" /><button class="btn primary sm" :disabled="!profileJson.trim()" @click="addProfile">保存</button></div>
      </div>
    </section>

    <section v-else-if="tab === 'schedules'" class="stack">
      <p class="muted">后台任务按 cron 运行（时区：{{ config?.timezone }}）。巡检只在到期提醒或关注对象有新材料时才调用 Agent。</p>
      <div v-for="s in schedules" :key="s.id" class="card pad sched">
        <div class="row wrap">
          <UiCheckbox :model-value="s.enabled" switch @change="toggleSchedule(s)"><strong>{{ labels[s.kind] ?? s.kind }}</strong></UiCheckbox>
          <span class="spacer" />
          <input class="input mono cron" :value="s.cron" @change="saveCron(s, ($event.target as HTMLInputElement).value)" />
          <button class="btn sm" @click="runNow(s)"><Icon name="play" :size="13" />立即运行</button>
        </div>
        <label v-if="s.kind === 'lark-curate'" class="field"><span>筛选方向</span><textarea class="textarea" rows="2" :value="s.config.direction ?? ''" placeholder="例如：和项目A、后端架构、我负责的模块相关的群；需要我回复或决定的讨论" @change="saveScheduleConfig(s, { direction: ($event.target as HTMLTextAreaElement).value })" /></label>
        <div class="muted small">上次：{{ s.lastRunAt ? fmtTime(s.lastRunAt) : "从未" }}<template v-if="next[s.id]"> · 下次：{{ fmtTime(next[s.id]) }}</template></div>
      </div>
    </section>

    <section v-else-if="tab === 'search' && config" class="stack">
      <p class="muted">全文检索始终可用（中文按双字切分，代码按标识符切分）。开启向量检索可改善换说法的提问，向量在后台逐步生成。</p>
      <div class="field"><span>向量检索</span>
        <UiSegmented :model-value="config.embeddings.provider" aria-label="向量检索" :options="[{ value: 'none', label: '关闭' }, { value: 'local', label: '本地模型（transformers.js）' }, { value: 'openai', label: 'OpenAI 兼容接口' }]" @change="(v) => saveConfig({ embeddings: { ...config.embeddings, provider: v } })" />
      </div>
      <label class="field"><span>模型</span><input class="input mono" :value="config.embeddings.model" @change="saveConfig({ embeddings: { ...config.embeddings, model: ($event.target as HTMLInputElement).value } })" /><span class="hint">本地默认 Xenova/bge-small-zh-v1.5（首次使用会下载约 100MB，也可以填本地目录）。</span></label>
      <label v-if="config.embeddings.provider === 'openai'" class="field"><span>接口地址</span><input class="input mono" :value="config.embeddings.url ?? ''" placeholder="https://api.openai.com/v1" @change="saveConfig({ embeddings: { ...config.embeddings, url: ($event.target as HTMLInputElement).value } })" /></label>
    </section>

    <section v-else-if="tab === 'lark' && config" class="stack">
      <p class="muted">飞书机器人是日常指挥入口：私聊可以提问、交代事项、交办任务；机器人所在的群聊会被保存为聊天原件并交给助理整理。通知也会发到私聊。</p>
      <UiCheckbox :model-value="config.lark.enabled" switch @change="(v) => saveConfig({ lark: { ...config.lark, enabled: v } })">启用飞书机器人</UiCheckbox>
      <div class="card pad stack">
        <div class="row">
          <strong>机器人应用</strong><span class="spacer" />
          <span v-if="config.lark.appId" class="badge">已绑定 {{ config.lark.appId }} · {{ config.lark.ownerOpenId ? '本人已确认' : '待确认本人' }}</span>
          <span v-else class="badge">未绑定</span>
        </div>
        <p class="muted small">在终端运行 <span class="mono">omem setup</span> → 渠道 → 飞书机器人：扫码创建新机器人，或绑定 lark-cli 里已有的应用；权限、长连接事件和卡片回调一并申请，不用在开放平台手工配置，也不用复制 App Secret。密钥只存在本机 <span class="mono">secrets/lark.json</span>（环境变量 {{ config.lark.appSecretEnv }} 可覆盖）。</p>
        <label class="field"><span>本人 open_id（setup 扫码通常自动填）</span><input class="input mono" :value="config.lark.ownerOpenId ?? ''" placeholder="不知道可先私聊机器人一句，再运行 omem setup" @change="saveConfig({ lark: { ...config.lark, ownerOpenId: ($event.target as HTMLInputElement).value } })" /></label>
      </div>
      <div class="field"><span>默认空间</span><UiSelect :model-value="config.lark.defaultSpace" width="240px" aria-label="默认空间" :options="state.spaces.map((s) => ({ value: s.id, label: s.name }))" @change="(v) => saveConfig({ lark: { ...config.lark, defaultSpace: v } })" /></div>

      <div class="card pad stack">
        <div class="row wrap"><strong>个人消息采集（只读）</strong><span class="spacer" /><button class="btn sm" @click="loadLarkChats">读取最近会话</button><button class="btn sm" @click="pollNow">立即采集</button></div>
        <p class="muted small">使用本机 lark-cli 的个人登录读取会话，从不以你的身份发消息；定时采集在“定时任务”中开启。omem 机器人自己的私聊和它在群里发的消息不会被采集。</p>
        <div class="field">
          <span>采集范围</span>
          <UiSegmented
            :model-value="config.lark.capture.mode"
            aria-label="采集范围"
            :options="[{ value: 'all', label: '所有有新消息的会话' }, { value: 'subscribed', label: '只读订阅的会话' }, { value: 'off', label: '关闭' }]"
            @change="(v) => saveConfig({ lark: { ...config.lark, capture: { ...config.lark.capture, mode: v } } }, '已保存采集范围')"
          />
          <span class="hint">任何范围下，群里 @你 的消息都会单独读取（不读的会话除外）。</span>
        </div>
        <div class="field">
          <span>按会话类型处理</span>
          <div class="policies">
            <div v-for="[k, l, h] in policyKinds" :key="k" class="policy-row">
              <div class="grow"><div>{{ l }}</div><div v-if="h" class="muted small">{{ h }}</div></div>
              <UiSelect :model-value="config.lark.capture.policies?.[k] ?? 'ingest'" size="sm" width="180px" :aria-label="`${l} 的处理方式`" :options="policyOptions" @change="(v) => setKindPolicy(k, v)" />
            </div>
          </div>
          <span class="hint">订阅的会话按“保存并整理”。单个会话可以在下面单独设置，优先于类型。</span>
        </div>
        <div v-if="larkError" class="badge danger">{{ larkError }}</div>
        <template v-if="larkSubs.length">
          <div class="section-title">订阅的会话</div>
          <div v-for="s in larkSubs" :key="s.chatId" class="row sub">
            <UiCheckbox :model-value="true" size="sm" aria-label="取消订阅" @change="toggleSub(s)" /><span class="grow ellipsis">{{ s.name }}</span>
            <UiSelect :model-value="s.spaceId" size="sm" width="160px" aria-label="空间" :options="state.spaces.map((sp) => ({ value: sp.id, label: sp.name }))" @change="(v) => toggleSub(s, v)" />
            <span class="muted small">{{ s.since ? `已采集到 ${fmtTime(s.since)}` : "尚未采集" }}</span>
          </div>
        </template>
        <template v-if="larkChats.length">
          <div class="section-title">最近会话</div>
          <template v-for="c in larkChats" :key="c.chatId">
            <div v-if="!subOf(c.chatId)" class="row sub">
              <UiCheckbox :model-value="false" size="sm" aria-label="订阅" @change="toggleSub(c)" /><span class="grow ellipsis">{{ c.name }}</span>
              <span class="badge">{{ chatKindLabel[c.kind] ?? c.kind }}</span>
              <span v-if="c.muted" class="badge warn">免打扰</span>
              <UiSelect :model-value="c.policy" size="sm" width="150px" aria-label="处理方式" :options="policyOptions" @change="(v) => setChatPolicy(c, v)" />
            </div>
          </template>
        </template>
        <template v-if="captured.length">
          <div class="row"><div class="section-title grow">已采集过的会话（{{ captured.length }}）</div><div class="search-mini row"><Icon name="search" :size="13" /><input v-model="capturedFilter" placeholder="筛选" aria-label="筛选会话" /></div></div>
          <div class="captured">
            <div v-for="c in shownCaptured" :key="c.chatId" class="row sub">
              <span class="grow ellipsis">{{ c.name || c.chatId }}</span>
              <span class="badge">{{ chatKindLabel[c.kind] ?? c.kind }}</span>
              <span v-if="c.muted" class="badge warn">免打扰</span>
              <span v-if="c.involved" class="badge accent" title="你在这里发过言或被 @ 过">参与过</span>
              <span class="muted small nowrap">{{ c.lastMessageAt ? fmtTime(c.lastMessageAt) : "" }}</span>
              <UiSelect
                :model-value="c.own ?? ''"
                size="sm"
                width="170px"
                aria-label="处理方式"
                :options="[{ value: '', label: `默认（${policyLabel[c.policy]}）` }, ...policyOptions]"
                @change="(v) => setChatPolicy(c, v)"
              />
            </div>
          </div>
        </template>
      </div>

      <div class="card pad stack">
        <UiCheckbox :model-value="config.telegram.enabled" switch @change="(v) => saveConfig({ telegram: { ...config.telegram, enabled: v } })"><strong>Telegram 机器人</strong></UiCheckbox>
        <p class="muted small">用 @BotFather 创建机器人，把 token 放在环境变量 <span class="mono">{{ config.telegram.tokenEnv }}</span>。首次给机器人发消息会回复你的 chat id。</p>
        <label class="field"><span>本人 chat id</span><input class="input mono" :value="config.telegram.ownerChatId ?? ''" @change="saveConfig({ telegram: { ...config.telegram, ownerChatId: ($event.target as HTMLInputElement).value || undefined } })" /></label>
      </div>

      <div class="card pad stack">
        <UiCheckbox :model-value="config.onebot.enabled" switch @change="(v) => saveConfig({ onebot: { ...config.onebot, enabled: v } })"><strong>QQ / 微信（OneBot v11）</strong></UiCheckbox>
        <p class="muted small">连接 NapCat、LLOneBot、Lagrange 等 OneBot 实现（正向 WebSocket）。私聊里只有本人能指挥助理；群消息保存为聊天原件并交给助理整理。</p>
        <div class="grid2">
          <label class="field"><span>WebSocket 地址</span><input class="input mono" :value="config.onebot.url ?? ''" placeholder="ws://127.0.0.1:3001" @change="saveConfig({ onebot: { ...config.onebot, url: ($event.target as HTMLInputElement).value || undefined } })" /></label>
          <label class="field"><span>显示名</span><input class="input" :value="config.onebot.name" @change="saveConfig({ onebot: { ...config.onebot, name: ($event.target as HTMLInputElement).value } })" /></label>
        </div>
        <label class="field"><span>本人账号（QQ 号 / 微信 id）</span><input class="input mono" :value="config.onebot.ownerUserId ?? ''" @change="saveConfig({ onebot: { ...config.onebot, ownerUserId: ($event.target as HTMLInputElement).value || undefined } })" /></label>
      </div>
    </section>

    <section v-else-if="tab === 'about'" class="stack">
      <div class="field"><span>主题</span><UiSegmented v-model="state.theme" aria-label="主题" :options="[{ value: 'auto', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]" /></div>
      <div class="card pad small stack">
        <div><kbd>Ctrl K</kbd> 搜索或提问 · <kbd>Ctrl J</kbd> 保存材料 · <kbd>Esc</kbd> 关闭引用层</div>
        <div class="muted">omem 也可以作为 MCP 服务给其他 Agent 使用：<span class="mono">omem mcp</span>（加 <span class="mono">--read-only</span> 只开放读取）。</div>
      </div>
    </section>

    <div v-if="editing" class="modal-overlay" @mousedown.self="editing = null">
      <div class="modal stack">
        <div class="row"><strong>空间设置：{{ editing.id }}</strong><span class="spacer" /><button class="btn ghost sm icon" @click="editing = null"><Icon name="x" /></button></div>
        <label class="field"><span>名称</span><input v-model="editing.name" class="input" /></label>
        <label class="field"><span>说明</span><input v-model="editing.description" class="input" /></label>
        <label class="field"><span>空间指南（SPACE.md，Agent 每次工作前都会读）</span><textarea v-model="guide" class="textarea mono" rows="10" /></label>
        <UiCheckbox :model-value="editing.settings.autoIngest !== false && (editing.kind !== 'repo' || editing.settings.autoIngest === true)" @change="(v) => (editing!.settings.autoIngest = v)">新材料保存后让助理整理（更新记忆、事项、相关页面）</UiCheckbox>
        <label v-if="editing.rootPath" class="field"><span>检查命令（交办编码后运行）</span><input v-model="editing.settings.checkCommand" class="input mono" placeholder="npm test" /></label>
        <UiCheckbox v-if="editing.rootPath" :model-value="editing.settings.autoLint !== false" @change="(v) => (editing!.settings.autoLint = v)">同步后自动检查受影响的 Wiki 页面</UiCheckbox>
        <div class="row"><span class="spacer" /><button class="btn primary" @click="saveSpace">保存</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spaces {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.sp {
  display: grid;
  gap: 4px;
}
.grid2 {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 12px;
}
.prow {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.prow:last-child {
  border-bottom: 0;
}
.grow {
  flex: 1;
  min-width: 0;
}
.prow .grow .mono {
  overflow-wrap: anywhere;
}
.prow .badge,
.prow .btn {
  flex-shrink: 0;
}
.more summary {
  cursor: pointer;
  padding: 8px 12px;
}
.probe {
  padding: 10px 16px;
  border-top: 1px dashed var(--line);
  display: grid;
  gap: 6px;
}
.chip {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 999px;
  padding: 1px 10px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 12px;
}
.chip.on {
  background: var(--ink);
  color: var(--bg);
  border-color: var(--ink);
}
.edit-box {
  padding: 10px 14px 14px;
  border-top: 1px solid var(--line);
  background: var(--hover);
}
.roles {
  display: grid;
  gap: 6px;
}
.role-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(0, 1.4fr);
  gap: 10px;
  align-items: center;
}
.role-model {
  display: grid;
  grid-template-columns: 1fr 110px;
  gap: 6px;
}
.policies {
  display: grid;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.policy-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
.policy-row:last-child {
  border-bottom: 0;
}
.captured {
  max-height: 420px;
  overflow-y: auto;
  display: grid;
}
.sub {
  padding: 4px 0;
  min-width: 0;
  flex-wrap: wrap;
}
.sub > .grow {
  min-width: 140px;
}
.nowrap {
  white-space: nowrap;
}
.search-mini {
  height: 28px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  padding: 0 8px;
  color: var(--muted);
  gap: 4px;
}
.search-mini input {
  border: 0;
  outline: 0;
  background: none;
  color: var(--ink);
  width: 120px;
}
.sm-input {
  width: 160px;
  height: 30px;
  padding: 4px 9px;
  font-size: 13px;
}
.cmp-row {
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
@media (max-width: 760px) {
  .role-row {
    grid-template-columns: 1fr;
  }
}
.sched {
  display: grid;
  gap: 6px;
}
.cron {
  width: 160px;
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 55;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 6vh;
}
.modal {
  width: min(640px, calc(100vw - 24px));
  max-height: 88vh;
  overflow: auto;
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 18px;
}
@media (max-width: 640px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
  .policy-row {
    flex-wrap: wrap;
  }
}
</style>
