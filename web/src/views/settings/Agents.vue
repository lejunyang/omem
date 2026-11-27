<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, post } from "../../api";
import { state, toast } from "../../store";
import { confirmDialog } from "../../lib/dialog";
import { followAdapterJob, jobElapsed, lastLine, type AdapterJob } from "../../lib/adapter-job";
import { aiPolicy, aiText, effectiveGroups, loadAiPolicy, proposalText } from "../../lib/ai-policy";
import { network } from "../../lib/network-status";
import { useBackends, useSettings, type Profile } from "./ctx";
import AiBackend, { type AgentLoad } from "../../components/AiBackend.vue";
import AiCapacity from "../../components/AiCapacity.vue";
import AiModels from "../../components/AiModels.vue";
import AiNetworkConditions from "../../components/AiNetworkConditions.vue";
import AiRouting from "../../components/AiRouting.vue";
import AiRules from "../../components/AiRules.vue";
import HelpText from "../../components/HelpText.vue";
import Icon from "../../components/Icon.vue";
import MonoLine from "../../components/MonoLine.vue";
import SetCard from "../../components/SetCard.vue";
import SetRow from "../../components/SetRow.vue";
import Skeleton from "../../components/Skeleton.vue";
import UiSegmented from "../../components/UiSegmented.vue";
import UiSelect from "../../components/UiSelect.vue";

/** 设置 → 后端与模型: the backends, the default AI, task routing, capacity, fallbacks, adding a backend; the rules and AI groups (规则). */
const { config, profiles, load, saveConfig } = useSettings();
const { installedProfiles, profileOptions, modelOptionsFor, loadProbes } = useBackends(profiles);

// Split by category: the agents (general), the rules and groups, the models omem calls itself, and the API keys.
type AiSection = "general" | "rules" | "voice" | "decision" | "image" | "keys";
const AI_SECTIONS: { value: AiSection; label: string }[] = [
  { value: "general", label: "通用" },
  { value: "rules", label: "规则" },
  { value: "voice", label: "语音" },
  { value: "decision", label: "决策" },
  { value: "image", label: "图片生成" },
  { value: "keys", label: "API key" },
];
/** Cards of the 规则 sub-page: a link to one opens it (`tiers` is the old card the groups took over). */
const RULE_CARDS = ["ai-say", "ai-rules", "ai-groups", "tiers"];
const route = useRoute();
const router = useRouter();
const sectionOf = (v: unknown, card?: unknown): AiSection => (RULE_CARDS.includes(String(card)) ? "rules" : AI_SECTIONS.some((s) => s.value === v) ? (v as AiSection) : "general");
const aiSection = ref<AiSection>(sectionOf(route.query.section, route.query.card));
watch(() => [route.query.section, route.query.card], ([v, card]) => {
  if (v !== undefined || RULE_CARDS.includes(String(card))) aiSection.value = sectionOf(v, card);
});
// The sub-page is in the address, so a link to a card of another sub-page opens it from here too.
watch(aiSection, (v) => {
  if (route.query.section !== v && sectionOf(route.query.section, route.query.card) !== v) void router.replace({ query: { tab: "agents", section: v } });
});
// The backend blocks say which groups each backend is in.
onMounted(() => void loadAiPolicy());

watch(() => profiles.value.length, (n) => { if (n) void loadProbes(); }, { immediate: true });

const defaultProfile = computed({
  get: () => config.value?.agents.default ?? "",
  set: (v: string) => void saveConfig({ agents: { ...config.value.agents, default: v || undefined } }),
});
type Fallback = { profile: string; model?: string; effort?: string };
const fallbacks = computed<Fallback[]>(() => config.value?.agents.fallback ?? []);
async function saveFallbacks(list: Fallback[], message = "已保存兜底顺序") {
  await saveConfig({ agents: { ...config.value.agents, fallback: list } }, message);
  void load();
}
function setFallback(i: number, patch: Partial<Fallback>) {
  const list = fallbacks.value.map((f, j) => {
    if (j !== i) return f;
    const next = { ...f, ...patch };
    return Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Fallback;
  });
  void saveFallbacks(list);
}
function moveFallback(i: number) {
  const list = [...fallbacks.value];
  [list[i - 1], list[i]] = [list[i], list[i - 1]];
  void saveFallbacks(list);
}
function addFallback() {
  const used = new Set(fallbacks.value.map((f) => f.profile));
  const next = installedProfiles.value.find((p) => !used.has(p.id) && p.id !== config.value.agents.default) ?? installedProfiles.value[0];
  if (next) void saveFallbacks([...fallbacks.value, { profile: next.id }], "已添加兜底");
}
const queueMinuteOptions = computed(() => {
  const cur = config.value?.agents.queueTimeoutMinutes ?? 30;
  return [...new Set([5, 10, 15, 30, 60, 120, 240, cur])].sort((a, b) => a - b).map((v) => ({ value: String(v), label: v < 60 ? `${v} 分钟` : `${v / 60} 小时` }));
});
async function saveQueueMinutes(v: string) {
  await saveConfig({ agents: { ...config.value.agents, queueTimeoutMinutes: Number(v) } }, `排队最多等待 ${v} 分钟`);
  void load();
}
/** The groups as runs see them now, one line each: the old three tiers are edited there (规则 → AI 组). */
const groupLines = computed(() => {
  const backends = aiPolicy.data?.backends ?? [];
  return effectiveGroups(aiPolicy.data?.groups, config.value?.agents.tiers, config.value?.agents.routing?.candidates)
    .map((g) => ({ id: g.id, name: g.name, text: g.items.length ? g.items.slice(0, 2).map((i) => aiText(i, backends)).join("、") + (g.items.length > 2 ? ` 等 ${g.items.length} 个` : "") : "空着" }));
});
const toGroups = () => void router.replace({ query: { tab: "agents", section: "rules", card: "ai-groups" } });
// 总体偏好 with “别用 / 只用” in it: the server says so, and the sentence can go to the rules.
const guidanceWarning = ref("");
async function saveRouting(routing: Record<string, unknown>) {
  const r = await saveConfig({ agents: { ...config.value.agents, routing } }, "已保存任务选型");
  guidanceWarning.value = r?.guidanceWarning ?? "";
}
function toRule(text: string) {
  proposalText.value = text.trim();
  guidanceWarning.value = "";
  void router.replace({ query: { tab: "agents", section: "rules", card: "ai-say" } });
}
function saveCapacity(v: { concurrency: number; interactiveConcurrency: number; perModel: number; quotaAvoidAbove: number; quotaPerDayBelow: number }) {
  const capacity = { ...config.value.agents.capacity, perModel: v.perModel, quotaAvoidAbove: v.quotaAvoidAbove, quotaPerDayBelow: v.quotaPerDayBelow };
  void saveConfig({ concurrency: v.concurrency, interactiveConcurrency: v.interactiveConcurrency, agents: { ...config.value.agents, capacity } }, "已保存并行设置");
}
/** A change from one backend's block (AiBackend.vue): part of config.agents. */
async function saveAgents(patch: Record<string, unknown>, note: string) {
  await saveConfig({ agents: { ...config.value.agents, ...patch } }, note);
  void load();
}
/** The installed backends by account: an ACP agent and its CLI fallback are one (their `source`), ACP first. */
const backendGroups = computed(() => {
  const groups = new Map<string, Profile[]>();
  for (const p of installedProfiles.value) {
    const key = p.source ?? p.id;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups].map(([source, list]) => ({ source, profiles: [...list].sort((a, b) => Number(b.transport === "acp") - Number(a.transport === "acp")) }));
});
/** Backends a network condition names that are not installed here: their conditions are listed apart. */
const orphanNetwork = computed(() => {
  const installed = new Set(installedProfiles.value.map((p) => p.id));
  return [...new Set(network.policies.flatMap((p) => p.backends))].filter((id) => !installed.has(id));
});
const agentLoad = ref<AgentLoad | null>(null);
async function loadAgentLoad() {
  agentLoad.value = await get<AgentLoad>("/api/agents/load").catch(() => null);
}
onMounted(loadAgentLoad);
const missingProfiles = computed(() => profiles.value.filter((p) => !p.installed));

// ---- installing a catalog npm package from the page (src/agents/adapter.ts): a job on the server, followed here.
const isOwner = computed(() => state.me?.role === "owner" || !state.me);
const installJobs = ref<Record<string, AdapterJob>>({});
const followers = new Map<string, ReturnType<typeof followAdapterJob>>();
function followInstall(job: AdapterJob) {
  let f = followers.get(job.id);
  if (!f) {
    const target = ref<AdapterJob | null>(null);
    watch(target, (j) => { if (j) installJobs.value = { ...installJobs.value, [j.id]: j }; });
    f = followAdapterJob(target, (j) => {
      if (j.ok) toast(`已装好 ${j.package}${j.after ? ` ${j.after}` : ""}。第一次用前先在终端运行它登录。`, "ok");
      else toast(`${j.package} 没装好：${j.message ?? lastLine(j.output)}`, "error");
      void load();
      if (j.ok) void loadProbes();
    });
    followers.set(job.id, f);
  }
  f(job);
}
onBeforeUnmount(() => followers.forEach((f) => f.stop()));
// A job started before this page opened (or before a refresh) is picked up again.
watch(() => (isOwner.value ? missingProfiles.value.filter((p) => p.installable).map((p) => p.id).join(",") : ""), async (ids) => {
  for (const id of ids ? ids.split(",") : []) {
    if (installJobs.value[id]) continue;
    const r = await get<{ job: AdapterJob | null }>(`/api/agents/${encodeURIComponent(id)}/adapter?quick=1`).catch(() => null);
    if (r?.job) followInstall(r.job);
  }
}, { immediate: true });
async function installBackend(p: Profile) {
  const how = commandHint(p);
  if (!(await confirmDialog(`安装 ${p.name ?? p.id}？`, { message: `${how}。带原生程序的包在慢的源上要装好几分钟，在后台装，可以离开这页。装好后第一次用前要在终端运行它登录。`, okText: "安装" }))) return;
  try {
    const r = await post<{ job: AdapterJob }>(`/api/agents/${encodeURIComponent(p.id)}/install`, {});
    followInstall(r.job);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const commandHint = (p: Profile) => `装 npm 包 ${p.install?.replace(/^npm i -g /, "") ?? p.id}：这台机器有 osdk 和 Node 时用 osdk 装，否则用 npm 从公开源装`;

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
const profileJson = ref("");
const showJson = ref(false);
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
  <Skeleton v-if="!config" :rows="6" />
  <div v-else class="stack">
    <UiSegmented v-model="aiSection" size="sm" aria-label="AI 分类" :options="AI_SECTIONS" />
    <AiRules v-if="aiSection === 'rules'" />
    <AiModels v-else-if="aiSection !== 'general'" :section="aiSection" :config="config" @save="(ai, note) => saveConfig({ ai }, note)" @changed="load" />
    <template v-else>
      <HelpText lead>理解、写作和编码交给 Agent：你已安装并登录的，或用 API key 生成的（在“API key”里添加）。同一个账号的 ACP 和命令行合在一起，点开设置默认模型、命令别名、网络条件和用量。</HelpText>
      <section id="set-backends" class="card set-card backends">
        <header class="set-card-head"><h3 class="set-title">后端</h3></header>
        <div class="set-card-body">
          <AiBackend v-for="g in backendGroups" :key="g.source" :source="g.source" :profiles="g.profiles" :all="profiles" :config="config" :load="agentLoad" @save="saveAgents" @reload="loadAgentLoad" @changed="() => { void load(); void loadAgentLoad(); }" @network="(v) => (config.agents.networkPolicies = v)" />
          <div v-if="!backendGroups.length" class="set-pad muted">还没有可用的 Agent，从下面任选一个安装。</div>
          <div v-if="orphanNetwork.length" class="set-pad">
            <div class="small muted">没装的后端上还有网络条件：</div>
            <AiNetworkConditions :scope="orphanNetwork" :backends="profiles" no-add @saved="(v) => (config.agents.networkPolicies = v)" />
          </div>
          <details v-if="missingProfiles.length" class="more">
            <summary class="small muted">其他支持的 Agent（{{ missingProfiles.length }} 个，未安装）</summary>
            <div v-for="p in missingProfiles" :key="p.id" class="miss">
              <div class="miss-row">
                <strong class="miss-name">{{ p.name ?? p.id }}</strong>
                <MonoLine :text="`${p.command} ${p.args.join(' ')}`.trim()" />
                <button class="btn ghost sm" @click="editProfile(p)">{{ editingProfile === p.id ? "收起" : "编辑" }}</button>
              </div>
              <p v-if="p.pluginBackend" class="small miss-plugin" :class="{ warn: !p.pluginBackend.available }">{{ p.pluginBackend.available ? `来自插件 ${p.pluginBackend.name}` : `来自插件 ${p.pluginBackend.name}，现在用不了：${p.pluginBackend.reason ?? "它的插件停用了"}` }}。<RouterLink :to="{ path: '/settings', query: { tab: 'plugins', plugin: p.pluginBackend.plugin } }">去插件页</RouterLink></p>
              <div v-if="p.install" class="miss-install small muted">
                <span>安装</span><MonoLine :text="p.install" copy />
                <button v-if="p.installable && isOwner" class="btn sm" :disabled="installJobs[p.id]?.running" @click="installBackend(p)">{{ installJobs[p.id]?.running ? "安装中…" : "安装" }}</button>
              </div>
              <div v-if="installJobs[p.id] && (installJobs[p.id].running || installJobs[p.id].ok === false)" class="small" :class="installJobs[p.id].running ? 'muted' : 'warn-text'">
                <template v-if="installJobs[p.id].running">在后台{{ installJobs[p.id].via === "osdk" ? "用 osdk " : "用 npm " }}安装，已 {{ jobElapsed(installJobs[p.id]) }}，可以离开这页<span v-if="installJobs[p.id].output" class="mono job-out" :title="installJobs[p.id].output">{{ lastLine(installJobs[p.id].output) }}</span></template>
                <template v-else>没装好：{{ installJobs[p.id].message ?? lastLine(installJobs[p.id].output) }}</template>
              </div>
              <div v-if="editingProfile === p.id" class="stack edit-box">
                <textarea v-model="editJson" class="textarea mono" rows="9" />
                <div class="row"><span class="spacer" /><button class="btn ghost sm" @click="editingProfile = null">取消</button><button class="btn primary sm" @click="saveEdit">保存</button></div>
              </div>
            </div>
          </details>
        </div>
      </section>

      <SetCard id="set-default-ai" title="默认 AI 与组">
        <SetRow label="默认 Agent">
          <template #hint>各角色用哪个 AI 在 <RouterLink to="/agents">Agent 档案</RouterLink> 里设</template>
          <UiSelect v-model="defaultProfile" size="sm" width="240px" aria-label="默认 Agent" :options="[{ value: '', label: '自动（第一个已安装的）' }, ...profileOptions]" />
        </SetRow>
        <SetRow label="AI 组" hint="流程阶段写的强 / 标准 / 省，和规则、档案用到的组">
          <button class="btn ghost sm" @click="toGroups">在规则里改</button>
        </SetRow>
        <div v-if="groupLines.length" class="set-pad groups">
          <template v-for="g in groupLines" :key="g.id">
            <span class="group-name">{{ g.name }}</span>
            <span class="group-items" :title="g.text">{{ g.text }}</span>
          </template>
        </div>
      </SetCard>

      <AiRouting :value="config.agents.routing" :backends="profiles" :warning="guidanceWarning" @save="saveRouting" @to-rule="toRule" />
      <AiCapacity :value="{ concurrency: config.concurrency, interactiveConcurrency: config.interactiveConcurrency, perModel: config.agents.capacity?.perModel ?? 3, quotaAvoidAbove: config.agents.capacity?.quotaAvoidAbove ?? 90, quotaPerDayBelow: config.agents.capacity?.quotaPerDayBelow ?? 0 }" @save="saveCapacity" />

      <SetCard id="set-fallback" title="排队与兜底">
        <template #help>后端排队、被限流、额度快用完或出故障时换一个后端接着做。配了决策模型时，换谁、按什么顺序由它按任务选型里的总体偏好和候选说明决定；下面是没有决策模型时的顺序，也是决策模型没排到的后端的顺序。模型满了时按这个顺序找有空位的。</template>
        <SetRow label="排队最多等" hint="排队期间不算空闲超时">
          <UiSelect :model-value="String(config.agents.queueTimeoutMinutes ?? 30)" size="sm" width="120px" aria-label="排队最多等待" :options="queueMinuteOptions" @change="saveQueueMinutes" />
        </SetRow>
        <div class="set-pad">
          <div v-for="(f, i) in fallbacks" :key="i" class="fb-row">
            <span class="fb-n small muted">{{ i + 1 }}</span>
            <UiSelect :model-value="f.profile" size="sm" width="200px" aria-label="兜底后端" :options="profileOptions" @change="(v) => setFallback(i, { profile: v, model: undefined, effort: undefined })" />
            <UiSelect :model-value="f.model ?? ''" size="sm" width="180px" aria-label="兜底模型" :options="modelOptionsFor(f.profile, 'model', f.model)" @change="(v) => setFallback(i, { model: v || undefined, effort: undefined })" />
            <UiSelect :model-value="f.effort ?? ''" size="sm" width="120px" aria-label="兜底强度" :options="modelOptionsFor(f.profile, 'effort', f.effort, f.model)" @change="(v) => setFallback(i, { effort: v || undefined })" />
            <span class="spacer" />
            <button class="btn ghost sm" :disabled="i === 0" @click="moveFallback(i)">上移</button>
            <button class="btn ghost sm icon" aria-label="移除" @click="saveFallbacks(fallbacks.filter((_, j) => j !== i), '已移除兜底')"><Icon name="x" :size="14" /></button>
          </div>
          <div class="row"><button class="btn sm" :disabled="!installedProfiles.length" @click="addFallback"><Icon name="plus" :size="13" />添加兜底</button><span v-if="!fallbacks.length" class="muted small">还没有兜底：后端失败时直接报错。</span></div>
        </div>
      </SetCard>

      <SetCard title="添加 Agent">
        <template #help>任何支持 Agent Client Protocol 的 Agent 都能接入：从官方注册表添加（npx / uvx 运行，或下载对应平台的程序到数据目录），或直接写一份配置。</template>
        <SetRow label="ACP 注册表" hint="官方注册表里的 Agent">
          <button class="btn ghost sm" @click="loadRegistry">{{ registry ? "刷新" : "浏览" }}</button>
        </SetRow>
        <div v-if="registry" class="set-pad reg">
          <div v-for="a in registry" :key="a.id" class="reg-row">
            <div class="reg-text">
              <div class="reg-name"><strong>{{ a.name }}</strong> <span class="muted small mono">v{{ a.version }}</span></div>
              <div v-if="a.description" class="muted small reg-desc" :title="a.description">{{ a.description }}</div>
            </div>
            <span v-if="a.added" class="badge ok">已可用</span>
            <template v-else>
              <button v-for="w in a.ways" :key="w" class="btn ghost sm" :disabled="!!registryBusy" @click="addFromRegistry(a, w)">{{ registryBusy === a.id ? "添加中…" : w === "binary" ? "下载" : w }}</button>
              <span v-if="!a.ways.length" class="muted small">本机不可用</span>
            </template>
          </div>
        </div>
        <SetRow label="写一份配置" hint="transport：acp / claude-cli / codex-cli / doubao-cli；同 id 的会被替换">
          <button class="btn ghost sm" :aria-expanded="showJson" @click="showJson = !showJson">{{ showJson ? "收起" : "展开" }}</button>
        </SetRow>
        <div v-if="showJson" class="set-pad">
          <textarea v-model="profileJson" class="textarea mono" rows="8" placeholder='{"id":"codex-sol","name":"Codex · Sol","transport":"acp","command":"codex-acp","args":[],"model":"gpt-6.1-sol","effort":"low"}' />
          <div class="row"><span class="muted small">model、effort 必须是该 Agent 支持的值。</span><span class="spacer" /><button class="btn primary sm" :disabled="!profileJson.trim()" @click="addProfile">保存</button></div>
        </div>
      </SetCard>
    </template>
  </div>
</template>

<style scoped>
.backends .set-card-head {
  padding-bottom: 8px;
}
.backends :deep(.be:first-child) {
  border-top: 1px solid var(--line);
}
.more {
  border-top: 1px solid var(--line);
}
.more summary {
  cursor: pointer;
  padding: 10px 18px;
}
.miss {
  display: grid;
  gap: 4px;
  padding: 8px 18px;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.miss-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.miss-name {
  font-weight: 550;
  white-space: nowrap;
}
.miss-install {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}
.job-out {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.miss-plugin {
  margin: 0;
  color: var(--muted);
}
.miss-plugin.warn {
  color: var(--warn);
}
.edit-box {
  padding: 8px 0;
}
.groups {
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 16px;
  font-size: 13px;
}
.group-name {
  color: var(--ink-2);
}
.group-items {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.fb-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  min-width: 0;
}
.fb-n {
  width: 16px;
}
.reg {
  gap: 0;
  padding-top: 4px;
  padding-bottom: 4px;
}
.reg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  min-width: 0;
}
.reg-row + .reg-row {
  border-top: 1px solid var(--line);
}
.reg-text {
  flex: 1;
  min-width: 0;
}
.reg-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reg-row .btn,
.reg-row .badge {
  flex: none;
}
@media (max-width: 640px) {
  .miss-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .miss-row > .mono-line {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .more summary {
    padding: 10px 14px;
  }
  .miss {
    padding: 8px 14px;
  }
}
</style>
