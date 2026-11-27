<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { del, get, post } from "../api";
import { followAdapterJob, jobElapsed, lastLine, type AdapterJob } from "../lib/adapter-job";
import { confirmDialog } from "../lib/dialog";
import { detectProbe, modelName, probes } from "../lib/probes";
import { networkBlock } from "../lib/network-status";
import { aiPolicy, effectiveGroups } from "../lib/ai-policy";
import { state, toast } from "../store";
import { fmt } from "../lib/time";
import Icon from "./Icon.vue";
import MonoLine from "./MonoLine.vue";
import UiSelect from "./UiSelect.vue";
import AiNetworkConditions from "./AiNetworkConditions.vue";
import MachineLogin from "./MachineLogin.vue";

/**
 * One backend in settings → AI: its ACP agent and CLI fallback together (one account, `source`), with
 * everything set per backend: the default model, its command words, the AI groups it is in (edited
 * under 规则), its network condition, how many runs at once, and its account's plan quota.
 */
export type Profile = { id: string; name?: string; transport: string; command: string; args: string[]; model?: string; effort?: string; installed: boolean; install?: string; networkReason?: string | null; peer?: unknown; source?: string; pluginBackend?: { plugin: string; name: string; available: boolean; reason?: string }; canProbe?: boolean };
export type AgentLoad = {
  now: { source: string; model: string; used: number; waiting: number }[];
  recent: { profile: string; model: string; done: number; failed: number; medianMinutes: number | null }[];
  outOfQuota?: { source: string; account?: string; model?: string; until: string; message: string }[];
  quota?: { profile: string; name: string; source: string; plan: string | null; readAt: string | null; windows: { name: string; used: number; model?: string; resetsIn?: string; perDayLeft?: number }[]; avoid?: string; error?: string }[];
  daily?: { profile: string; model: string; perDay: number; used: number }[];
};
type Limit = { profile: string; model?: string; max: number; perDay?: number };

const props = defineProps<{ source: string; profiles: Profile[]; all: Profile[]; config: any; load: AgentLoad | null }>();
const emit = defineEmits<{ save: [agents: Record<string, unknown>, note: string]; reload: []; changed: []; network: [policies: unknown[]] }>();
const open = ref(false);
/** This machine's login is the owner's to start (agents/machine-login.ts). */
const isOwner = computed(() => state.me?.role === "owner" || !state.me);
const ids = computed(() => props.profiles.map((p) => p.id));
/** ACP first: it reports its models and is what a new run picks. */
const primary = computed(() => props.profiles[0]);
const probeable = (p: Profile) => p.transport === "acp" || p.transport === "doubao-cli";
const prober = computed(() => props.profiles.find(probeable));
/** Someone who may only look (`canProbe: false`) sees the cached result settings sent along: nothing is asked. */
const mayProbe = computed(() => prober.value?.canProbe !== false);
const probe = computed(() => (prober.value ? probes.data[prober.value.id] : undefined));
const probing = computed(() => !!(prober.value && probes.pending[prober.value.id]));
const models = computed(() => probe.value?.models ?? []);
const efforts = computed(() => probe.value?.effortsByModel?.[primary.value.model ?? ""] ?? probe.value?.efforts ?? []);
watch(open, (o) => { if (o && prober.value && mayProbe.value) void detectProbe(prober.value.id); });

// ---- the npm adapter behind the ACP agent (src/agents/adapter.ts): installed and newest version, upgrade in
// place. The upgrade is a job on the server: the page follows it, and a refresh finds it still running.
type Adapter = { id: string; package: string | null; version?: string | null; latest?: string | null; latestError?: string; upgradable?: boolean; via?: AdapterJob["via"]; job?: AdapterJob | null };
/** How each way installs, for the confirmation, and the verb on the running line. */
const VIA: Record<AdapterJob["via"], { how: string; line: string }> = {
  osdk: { how: "用 osdk 装（osdk 管着这一份），替换这台机器上正在用的那一份", line: "用 osdk " },
  npm: { how: "从 omem 指定的公开 npm 源装，替换这台机器上正在用的那一份", line: "用 npm " },
  download: { how: "从 ACP 注册表下载这个版本的程序，按注册表给的 sha256 校验后换上（上一版留着）", line: "下载并" },
  npx: { how: "把配置里 npx 运行的包换成注册表上的这个版本，下次启动时由 npx 取", line: "" },
  uvx: { how: "把配置里 uvx 运行的包换成注册表上的这个版本，下次启动时由 uvx 取", line: "" },
};
/** Registry backends: “检查更新” asks the registry again instead of the ten-minute copy. */
const fresh = ref(false);
const acp = computed(() => props.profiles.find((p) => p.transport === "acp" && p.installed && !p.peer));
const adapter = ref<Adapter | null>(null);
const checking = ref(false), starting = ref(false);
const job = ref<AdapterJob | null>(null);
const upgrading = computed(() => starting.value || !!job.value?.running);
async function checkAdapter() {
  if (!acp.value) return;
  checking.value = true;
  try {
    adapter.value = await get<Adapter>(`/api/agents/${encodeURIComponent(acp.value.id)}/adapter${fresh.value ? "?fresh=1" : ""}`);
    fresh.value = false;
    if (adapter.value.job) follow(adapter.value.job);
  }
  catch { adapter.value = null; }
  finally { checking.value = false; }
}
watch(open, (o) => { if (o && !adapter.value) void checkAdapter(); });
const follow = followAdapterJob(job, (j) => {
  if (j.probe && acp.value) probes.data[acp.value.id] = j.probe;
  if (j.ok) toast(`${j.package} 已是 ${j.after}`);
  else toast(`升级没成功${j.after ? `，仍是 ${j.after}` : ""}：${j.message ?? lastLine(j.output)}`, "error");
  void checkAdapter();
  if (!j.ok) emit("reload");
});
onBeforeUnmount(() => follow.stop());
/** Models the last detection gave no effort levels for while others have them: an adapter older than the model. */
const noEffort = computed(() => {
  const by = probe.value?.effortsByModel;
  if (!by || !Object.values(by).some((v) => v.length)) return [];
  return models.value.filter((m) => by[m] && !by[m].length);
});
async function upgradeAdapter() {
  const a = adapter.value;
  if (!a?.package || !a.latest || !acp.value) return;
  const how = VIA[a.via ?? "npm"].how;
  if (!(await confirmDialog(`把 ${a.package} 升级到 ${a.latest}？`, { message: `${how}；正在跑的会话不受影响，新会话起用新版。带原生程序的包在慢的源上要装好几分钟，在后台装，可以离开这页。装完会重新检测模型。`, okText: "升级" }))) return;
  starting.value = true;
  try {
    const r = await post<{ job: AdapterJob }>(`/api/agents/${encodeURIComponent(acp.value.id)}/adapter/upgrade`, {});
    follow(r.job);
  } catch (e) {
    toast((e as Error).message, "error");
    void checkAdapter();
  } finally {
    starting.value = false;
  }
}

const name = computed(() => (primary.value.name ?? primary.value.id).replace(/\s*[(（](ACP|CLI|命令行)[)）]\s*$/i, ""));
const KIND: Record<string, string> = { acp: "ACP", "claude-cli": "CLI", "codex-cli": "CLI", "doubao-cli": "CLI", doubao: "OpenAPI" };
const kinds = computed(() => [...new Set(props.profiles.map((p) => KIND[p.transport] ?? p.transport))].join(" · "));
const blocked = computed(() => props.profiles.map((p) => networkBlock(p.id)).find(Boolean) ?? null);
/** Where limits are written: the account (source) when a profile of that id exists, else the profile. */
const limitKey = computed(() => (ids.value.includes(props.source) ? props.source : primary.value.id));
const mineLimit = (l: Limit) => l.profile === props.source || ids.value.includes(l.profile);

// ---- the default model, for the ACP agent and its CLI fallback at once
async function setDefault(key: "model" | "effort", value: string) {
  const strip = ({ installed, install, networkReason, ...rest }: Profile) => rest;
  const next = props.profiles.map((p) => ({ ...strip(p), [key]: value || undefined, ...(key === "model" ? { effort: p.effort } : {}) }));
  const list = [...props.config.agents.profiles.filter((x: Profile) => !ids.value.includes(x.id)), ...next];
  emit("save", { profiles: list }, `${name.value}：默认${key === "model" ? "模型" : "强度"} ${value || "跟随后端"}`);
}
const editing = ref<string | null>(null);
const editJson = ref("");
function editProfile(p: Profile) {
  const { installed, install, networkReason, ...rest } = p;
  editing.value = editing.value === p.id ? null : p.id;
  editJson.value = JSON.stringify(rest, null, 2);
}
function saveEdit() {
  try {
    const p = JSON.parse(editJson.value);
    if (!p.id) return toast("配置要有 id", "error");
    emit("save", { profiles: [...props.config.agents.profiles.filter((x: Profile) => x.id !== p.id && x.id !== editing.value), p] }, `已保存 ${p.name ?? p.id}`);
    editing.value = null;
  } catch (e) {
    toast(`不是合法的 JSON：${(e as Error).message}`, "error");
  }
}

// ---- the AI groups it is in (and what each entry is for): edited in 规则 → AI 组, one place for them
const routing = computed(() => props.config.agents.routing);
const groups = computed(() => effectiveGroups(aiPolicy.data?.groups, props.config.agents.tiers, routing.value?.candidates));
const memberOf = computed(() => groups.value.flatMap((g) => g.items.flatMap((it, i) => (ids.value.includes(it.profile) ? [{ group: g.name, id: g.id, n: i + 1, model: it.model, effort: it.effort, note: it.note }] : []))));
const memberLine = (m: (typeof memberOf.value)[number]) => [
  `${m.group} · 第 ${m.n} 个`,
  [m.model && modelName(probe.value, m.model), m.effort].filter(Boolean).join(" · "),
].filter(Boolean).join("：");

// ---- command words: `/别名 模型 强度` switches a conversation to it (src/agents/ai-spec.ts)
type Named = Profile & { aliases?: string[] };
/** The words it answers to by itself (its id, name, program, command…): shown, not edited. */
const autoNames = computed(() => [...new Set(props.profiles.flatMap((p) => aiPolicy.data?.backends.find((b) => b.id === p.id)?.names ?? []))].filter((n) => !/\s/.test(n)));
/** Aliases are kept on the ACP (first) profile: two forms of one account may not share a word. */
const savedAliases = computed(() => (primary.value as Named).aliases ?? []);
const aliases = ref<string[]>([]);
const aliasInput = ref("");
watch(() => JSON.stringify(savedAliases.value), () => { aliases.value = [...savedAliases.value]; }, { immediate: true });
const aliasDirty = computed(() => JSON.stringify(aliases.value) !== JSON.stringify(savedAliases.value) || !!aliasInput.value.trim());
function takeAlias() {
  for (const word of aliasInput.value.split(/[\s,，、/]+/).map((w) => w.trim()).filter(Boolean)) {
    const lower = word.toLowerCase();
    if (autoNames.value.includes(lower)) toast(`“${word}”本来就能用`, "info");
    else if (!aliases.value.some((a) => a.toLowerCase() === lower)) aliases.value.push(word);
  }
  aliasInput.value = "";
}
function aliasKey(e: KeyboardEvent) {
  if (e.key === "Backspace" && !aliasInput.value && aliases.value.length) aliases.value.pop();
}
function saveAliases() {
  takeAlias();
  const strip = ({ installed, install, networkReason, ...rest }: Profile) => rest;
  const next = { ...strip(primary.value), aliases: aliases.value.length ? aliases.value : undefined };
  const list = [...props.config.agents.profiles.filter((x: Profile) => x.id !== primary.value.id), next];
  emit("save", { profiles: list }, aliases.value.length ? `${name.value} 的命令别名已保存` : `${name.value} 不用别名了`);
}

// ---- runs at once and the account's quota
const capacity = computed(() => props.config.agents.capacity);
const cap = ref<string>(""), modelLimits = ref<Limit[]>([]), avoidAbove = ref<string>(""), perDayBelow = ref<string>("");
function resetUsage() {
  const mine = (capacity.value.limits as Limit[]).filter(mineLimit);
  const whole = mine.find((l) => !l.model);
  cap.value = whole ? String(whole.max) : "";
  modelLimits.value = mine.filter((l) => l.model).map((l) => ({ ...l }));
  const own = capacity.value.quotaBySource?.[props.source] ?? {};
  avoidAbove.value = own.avoidAbove !== undefined ? String(own.avoidAbove) : "";
  perDayBelow.value = own.perDayBelow !== undefined ? String(own.perDayBelow) : "";
}
watch(() => JSON.stringify([capacity.value.limits, capacity.value.quotaBySource?.[props.source]]), resetUsage, { immediate: true });
const clamp = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
function addModelLimit() {
  const free = models.value.find((m) => !modelLimits.value.some((l) => l.model === m));
  modelLimits.value.push({ profile: limitKey.value, model: free ?? "", max: capacity.value.perModel ?? 3 });
}
function saveUsage() {
  if (modelLimits.value.some((l) => !l.model)) return toast("每一行都要选模型", "error");
  const own: Limit[] = [
    ...(cap.value.trim() !== "" ? [{ profile: limitKey.value, max: clamp(cap.value, 0, 32) }] : []),
    ...modelLimits.value.map((l) => {
      const perDay = l.perDay !== undefined && String(l.perDay) !== "" ? clamp(l.perDay, 0, 100000) : undefined;
      return { profile: limitKey.value, model: l.model, max: clamp(l.max, 0, 32), ...(perDay !== undefined ? { perDay } : {}) };
    }),
  ];
  const limits = [...(capacity.value.limits as Limit[]).filter((l) => !mineLimit(l)), ...own];
  const bySource = { ...(capacity.value.quotaBySource ?? {}) };
  const t = {
    ...(avoidAbove.value.trim() !== "" ? { avoidAbove: clamp(avoidAbove.value, 50, 100) } : {}),
    ...(perDayBelow.value.trim() !== "" ? { perDayBelow: Math.max(0, Math.min(100, Number(perDayBelow.value) || 0)) } : {}),
  };
  if (Object.keys(t).length) bySource[props.source] = t;
  else delete bySource[props.source];
  emit("save", { capacity: { ...capacity.value, limits, quotaBySource: bySource } }, `已保存 ${name.value} 的用量设置`);
}
const now = computed(() => props.load?.now.filter((n) => n.source === props.source) ?? []);
const running = computed(() => now.value.reduce((s, n) => s + n.used, 0));
const recent = (model: string) => props.load?.recent.find((r) => r.profile === props.source && r.model === model);
const today = (l: Limit) => props.load?.daily?.find((d) => (d.profile === l.profile || ids.value.includes(d.profile)) && d.model === l.model);
const quota = computed(() => props.load?.quota?.find((q) => q.source === props.source));
const spent = computed(() => props.load?.outOfQuota?.filter((q) => q.source === props.source || q.account === props.source) ?? []);
const windowLabel = (n: string) => n.replace(/^5h/, "5 小时").replace(/^7d/, "一周");
const quotaShort = computed(() => {
  const w = quota.value?.windows ?? [];
  if (!w.length) return "";
  const top = [...w].sort((a, b) => b.used - a.used)[0];
  return `${windowLabel(top.name)}已用 ${top.used}%`;
});
const reading = ref(false);
async function readQuota() {
  reading.value = true;
  try { await post("/api/agents/quota/refresh", {}); emit("reload"); }
  catch (e) { toast((e as Error).message, "error"); }
  finally { reading.value = false; }
}
async function useAgain(source: string) {
  await del(`/api/agents/quota/${encodeURIComponent(source)}`);
  emit("reload");
}
const when2 = (iso: string) => fmt(iso, { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const chosen = computed(() => routing.value.automatic && memberOf.value.some((m) => m.id === "candidates"));
</script>

<template>
  <div class="be" :class="{ open }">
    <button type="button" class="be-head" :aria-expanded="open" @click="open = !open">
      <Icon name="right" :size="14" class="chev" />
      <span class="be-name"><strong>{{ name }}</strong><span class="muted small">（{{ kinds }}）</span></span>
      <span class="be-meta small muted mono">{{ [primary.model && modelName(probe, primary.model), primary.effort].filter(Boolean).join(" · ") || "后端默认模型" }}</span>
      <span class="be-tags">
        <span v-if="running" class="badge">在用 {{ running }}</span>
        <span v-if="chosen" class="badge">候选</span>
        <span v-if="quotaShort" class="badge" :class="{ warn: quota?.avoid }">{{ quotaShort }}</span>
        <span v-if="spent.length" class="badge danger">额度用完</span>
        <span v-if="blocked" class="badge warn" :title="blocked">网络不符</span>
        <span v-if="primary.pluginBackend" class="badge" :class="{ warn: !primary.pluginBackend.available }" :title="primary.pluginBackend.reason">{{ primary.pluginBackend.available ? `来自插件 ${primary.pluginBackend.name}` : "插件停用了" }}</span>
      </span>
    </button>
    <div v-if="open" class="be-body">
      <p v-if="blocked" class="small warn-text">{{ blocked }}</p>
      <p v-if="primary.pluginBackend" class="small" :class="primary.pluginBackend.available ? 'muted' : 'warn-text'">{{ primary.pluginBackend.available ? `这个后端来自插件 ${primary.pluginBackend.name}，启动命令写在它的清单里。` : `现在用不了：${primary.pluginBackend.reason ?? "它的插件停用了"}（来自插件 ${primary.pluginBackend.name}）。` }}<RouterLink :to="{ path: '/settings', query: { tab: 'plugins', plugin: primary.pluginBackend.plugin } }">去插件页</RouterLink></p>

      <MachineLogin v-if="isOwner && !primary.peer" :backend="source" @changed="emit('changed')" />

      <section class="part">
        <h4>默认模型</h4>
        <div v-if="models.length" class="row wrap small">
          <span class="muted lbl">模型</span>
          <button v-for="m in models" :key="m" type="button" class="chip" :class="{ on: primary.model === m }" @click="setDefault('model', m)">{{ modelName(probe, m) }}</button>
        </div>
        <div v-if="efforts.length" class="row wrap small">
          <span class="muted lbl">强度</span>
          <button v-for="v in efforts" :key="v" type="button" class="chip" :class="{ on: primary.effort === v }" @click="setDefault('effort', v)">{{ v }}</button>
        </div>
        <p v-if="noEffort.length" class="small warn-text">{{ noEffort.join("、") }} 没检测到思考强度{{ adapter?.upgradable ? `：适配器 ${adapter.version} 可能比这个模型旧，升级到 ${adapter.latest} 后会重新检测。` : "，可能是适配器还不认识这个模型。" }}</p>
        <p v-if="probe?.error" class="small warn-text">读不到模型列表：{{ probe.error }}</p>
        <p v-else-if="!prober" class="small muted">这个后端不报告模型列表，在下面的配置里写 model、effort。</p>
        <div class="row wrap small">
          <span v-if="profiles.length > 1" class="muted grow">ACP 和命令行用同一个默认值。</span><span v-else class="grow" />
          <button v-if="prober && mayProbe" class="btn ghost sm" :disabled="probing" @click="detectProbe(prober.id, true)">{{ probing ? "检测中…" : "重新检测" }}</button>
        </div>
        <div v-for="p in profiles" :key="p.id" class="cmd">
          <div class="row small">
            <span class="badge">{{ KIND[p.transport] ?? p.transport }}</span>
            <MonoLine class="cmd-line" :text="`${p.command} ${p.args.join(' ')}`.trim()" copy />
            <button class="btn ghost sm" @click="editProfile(p)">{{ editing === p.id ? "收起" : "编辑配置" }}</button>
          </div>
          <div v-if="p === acp && (checking || adapter?.package)" class="row wrap small adapter">
            <span class="muted">适配器</span>
            <span v-if="!adapter" class="muted">查询版本…</span>
            <template v-else>
              <span class="mono">{{ adapter.package }} {{ adapter.version ?? "" }}</span>
              <span v-if="adapter.upgradable" class="badge warn">有新版 {{ adapter.latest }}</span>
              <span v-else-if="adapter.latest" class="muted">已是最新</span>
              <span v-else-if="adapter.latestError" class="muted ell" :title="adapter.latestError">查不到最新版</span>
            </template>
            <span class="spacer" />
            <button v-if="upgrading" class="btn sm" disabled>升级中…</button>
            <button v-else-if="adapter?.upgradable" class="btn sm" @click="upgradeAdapter">升级到 {{ adapter.latest }}</button>
            <button v-else-if="adapter" class="btn ghost sm" :disabled="checking" @click="fresh = true; checkAdapter()">{{ checking ? "查询中…" : "检查更新" }}</button>
          </div>
          <div v-if="p === acp && job && (job.running || job.ok === false)" class="small job" :class="{ 'warn-text': job.ok === false }">
            <template v-if="job.running">在后台{{ VIA[job.via].line }}升级，已 {{ jobElapsed(job) }}，可以离开这页<span v-if="job.output" class="muted mono ell job-out" :title="job.output">{{ lastLine(job.output) }}</span></template>
            <template v-else>上次升级没成功（{{ jobElapsed(job) }}）：{{ job.message ?? lastLine(job.output) }}</template>
          </div>
          <div v-if="editing === p.id" class="stack">
            <textarea v-model="editJson" class="textarea mono" rows="9" />
            <div class="row"><span class="muted small">model、effort 写后端支持的值，不区分大小写和点 / 连字符。</span><span class="spacer" /><button class="btn ghost sm" @click="editing = null">取消</button><button class="btn primary sm" @click="saveEdit">保存</button></div>
          </div>
        </div>
      </section>

      <section class="part">
        <h4>命令别名</h4>
        <p class="small muted">在对话里发 <code>/别名 模型 强度</code> 就换到这个后端（模型和强度可以不写）。</p>
        <div class="tags" @click="($event.currentTarget as HTMLElement).querySelector('input')?.focus()">
          <span v-for="n in autoNames" :key="`auto-${n}`" class="tag auto" title="自动有的，不用加">{{ n }}</span>
          <span v-for="(a, i) in aliases" :key="a" class="tag">{{ a }}<button type="button" class="tag-x" :aria-label="`去掉别名 ${a}`" @click.stop="aliases.splice(i, 1)">×</button></span>
          <input v-model="aliasInput" class="tag-input" maxlength="120" aria-label="加一个别名" placeholder="加别名，回车" @keydown.enter.prevent="takeAlias" @keydown="aliasKey" @blur="takeAlias" />
        </div>
        <div class="row wrap">
          <span class="small muted grow">灰色的是自动有的。别名不能和命令、组名或别的后端的名字重复。</span>
          <button class="btn primary sm" :disabled="!aliasDirty" @click="saveAliases">保存</button>
        </div>
      </section>

      <section class="part">
        <h4>在哪些 AI 组里</h4>
        <ul v-if="memberOf.length" class="member small">
          <li v-for="m in memberOf" :key="`${m.id}-${m.n}`"><span>{{ memberLine(m) }}</span><span v-if="m.note" class="muted">：{{ m.note }}</span></li>
        </ul>
        <p v-else class="small muted">还不在任何组里。</p>
        <p class="small muted">组和每一项适合做什么在 <RouterLink :to="{ path: '/settings', query: { tab: 'agents', section: 'rules', card: 'ai-groups' } }">规则 → AI 组</RouterLink> 里改{{ routing.automatic ? "" : "；任务选型的自动选择关着，“候选”组现在不起作用" }}。</p>
      </section>

      <section class="part">
        <h4>网络条件</h4>
        <AiNetworkConditions :scope="ids" :backends="all" @saved="(v) => emit('network', v)" />
      </section>

      <section class="part">
        <h4>用量</h4>
        <div v-if="now.length" class="lines small">
          <template v-for="n in now" :key="n.model">
            <span class="mono">{{ n.model ? modelName(probe, n.model) : "默认模型" }}</span>
            <span>正在用 {{ n.used }}<template v-if="n.waiting">，等 {{ n.waiting }}</template><span v-if="recent(n.model)" class="muted">（近 7 天完成 {{ recent(n.model)!.done }}、失败 {{ recent(n.model)!.failed }}）</span></span>
          </template>
        </div>
        <label class="row small"><span>整个账号同时最多</span><input v-model="cap" class="input sm num" type="number" inputmode="numeric" min="0" max="32" placeholder="不限" aria-label="整个账号同时最多" /><span>个</span><span class="muted">（每个模型默认最多 {{ capacity.perModel ?? 3 }} 个）</span></label>
        <div v-for="(l, i) in modelLimits" :key="i" class="row wrap small">
          <UiSelect v-if="models.length" :model-value="l.model ?? ''" size="sm" width="180px" aria-label="模型" :options="[...new Set([...(l.model ? [l.model] : []), ...models])].map((m) => ({ value: m, label: m }))" @change="(v) => (l.model = v)" />
          <input v-else v-model="l.model" class="input sm-input mono" placeholder="模型" aria-label="模型" />
          <label class="row">同时最多<input v-model.number="l.max" class="input sm num" type="number" inputmode="numeric" min="0" max="32" aria-label="同时最多" />个</label>
          <label class="row">每天最多<input v-model.number="l.perDay" class="input sm num" type="number" inputmode="numeric" min="0" placeholder="不限" aria-label="每天最多" />次<span v-if="today(l)" class="muted">（今天 {{ today(l)!.used }}）</span></label>
          <span class="spacer" />
          <button class="btn ghost sm icon" aria-label="移除" @click="modelLimits.splice(i, 1)"><Icon name="x" :size="14" /></button>
        </div>
        <p class="small muted">设成 0 的不会被自动选中，只在你点名时用。有的模型每天限次数却不告诉剩多少：填“每天最多”，omem 自己数，到了当天不再自动选它。</p>
        <template v-if="quota">
          <div class="row wrap small">
            <span class="grow">
              <span class="muted">账号额度{{ quota.plan ? `（${quota.plan}）` : "" }}：</span>
              <template v-if="quota.windows.length"><span v-for="(w, i) in quota.windows" :key="w.name">{{ i ? "；" : "" }}{{ windowLabel(w.name) }}已用 {{ w.used }}%<span v-if="w.resetsIn" class="muted">，{{ w.resetsIn }}后重置</span><span v-if="w.perDayLeft !== undefined" class="muted">，每天约 {{ w.perDayLeft }}%</span></span></template>
              <span v-else class="muted">{{ quota.error ? `读不到：${quota.error.slice(0, 80)}` : "还没读过" }}</span>
            </span>
            <button class="btn ghost sm" :disabled="reading" @click="readQuota">{{ reading ? "读取中…" : "现在读取" }}</button>
          </div>
          <p v-if="quota.avoid" class="small warn-text">排到最后：{{ quota.avoid }}</p>
          <label class="row small"><span>任一窗口用到</span><input v-model="avoidAbove" class="input sm num" type="number" inputmode="numeric" min="50" max="100" :placeholder="String(capacity.quotaAvoidAbove ?? 90)" aria-label="任一窗口用到多少以上时排到最后" /><span>% 以上时排到最后</span></label>
          <label class="row small"><span>周额度每天剩不到</span><input v-model="perDayBelow" class="input sm num" type="number" inputmode="decimal" min="0" max="100" step="0.5" :placeholder="String(capacity.quotaPerDayBelow ?? 0)" aria-label="周额度每天剩不到多少时排到最后" /><span>% 时排到最后</span></label>
          <p class="small muted">留空用并行设置里的默认值。排到最后时后台任务先用别的后端，你自己的对话和点名用它的任务不受影响。</p>
        </template>
        <div v-for="q in spent" :key="q.source" class="row wrap small">
          <span class="danger-text">{{ q.model ? `${modelName(probe, q.model)} ` : "" }}额度用完，{{ when2(q.until) }} 恢复</span><span class="spacer" />
          <button class="btn ghost sm" @click="useAgain(q.source)">现在恢复使用</button>
        </div>
        <div class="row wrap">
          <button class="btn ghost sm" :disabled="modelLimits.length >= 50" @click="addModelLimit"><Icon name="plus" :size="13" />给某个模型设上限</button>
          <span class="spacer" />
          <button class="btn primary sm" @click="saveUsage">保存</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.be { border-top: 1px solid var(--line); }
.be:first-child { border-top: 0; }
.be-head {
  display: grid; grid-template-columns: auto minmax(0, auto) minmax(0, 1fr) auto; align-items: center; gap: 10px;
  width: 100%; padding: 12px 16px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.be-head:hover { background: var(--hover, color-mix(in srgb, var(--fg) 4%, transparent)); }
.chev { transition: transform 0.15s ease; color: var(--muted); }
.open .chev { transform: rotate(90deg); }
.be-name { white-space: nowrap; }
.be-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.be-tags { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.be-body { display: grid; gap: 4px; padding: 0 16px 16px 40px; }
.part { display: grid; gap: 8px; padding: 12px 0; border-top: 1px dashed var(--line); min-width: 0; }
.part:first-of-type { border-top: 0; }
.part h4 { margin: 0; font-size: 13px; font-weight: 600; }
.part p { margin: 0; }
.lbl { min-width: 2.5em; }
.cmd { display: grid; gap: 8px; min-width: 0; }
/* The command line can be a long path: it stays on its row, ellipsized, whole on hover and copyable. */
.cmd > .row { min-width: 0; }
.cmd-line { flex: 1 1 0; }
.be-body > * { min-width: 0; }
.adapter { padding-left: 2px; }
.job { display: grid; gap: 2px; padding-left: 2px; min-width: 0; }
.job-out { display: block; }
.ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.tags {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0;
  padding: 4px 6px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); cursor: text;
}
.tag {
  display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 2px 0 8px; border-radius: 999px;
  background: var(--accent-soft); color: var(--ink); font-family: var(--mono); font-size: 12px; white-space: nowrap; max-width: 100%;
}
.tag.auto { padding-right: 8px; background: var(--sunken); color: var(--muted); }
.tag-x { width: 18px; height: 18px; border: 0; border-radius: 50%; background: none; color: var(--muted); font: inherit; line-height: 1; cursor: pointer; }
.tag-x:hover { color: var(--ink); }
.tag-input { flex: 1 1 120px; min-width: 80px; height: 24px; border: 0; outline: 0; background: none; color: inherit; font: inherit; font-size: 13px; }
.grow { flex: 1 1 auto; min-width: 0; }
.member { margin: 0; padding-left: 18px; display: grid; gap: 2px; color: var(--ink-2); }
.num { width: 72px; margin: 0 4px; }
.sm-input { width: 180px; }
.lines { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; align-items: baseline; }
.danger-text { color: var(--danger); }
.chip { border: 1px solid var(--line); background: var(--panel); color: inherit; border-radius: 999px; padding: 1px 10px; cursor: pointer; font-family: var(--mono); font-size: 12px; }
.chip.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
@media (max-width: 640px) {
  .be-head { grid-template-columns: auto minmax(0, 1fr); padding: 12px; }
  .be-meta { grid-column: 2; }
  .be-tags { grid-column: 2; justify-content: flex-start; }
  .be-body { padding: 0 12px 12px; }
  .lines { grid-template-columns: minmax(0, 1fr); gap: 0; }
}
</style>
