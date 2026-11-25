<script setup lang="ts">
import PluginPack from "./PluginPack.vue";
import PluginSettings from "./PluginSettings.vue";
import { useRoute } from "vue-router";
import HelpText from "./HelpText.vue";
import { nextTick, onMounted, ref, watch } from "vue";
import { del, get, post, put } from "../api";
import { PLUGIN_ICONS } from "../lib/icons";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { fmt } from "../lib/time";
import { state, toast } from "../store";
import Icon from "./Icon.vue";
import MonoLine from "./MonoLine.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";

/**
 * Settings → 插件 (docs/v2/plugins.md): installing someone else's plugin (an npm package or a GitHub tag),
 * turning plugins on and off, trusting the code of plugins in the data directory (and withdrawing it),
 * updating or removing installed ones. A card's face says what the plugin is, whether it is on and what
 * waits for the owner (trust, a callback without a secret, a failed delivery); what it may do and what it
 * brings (tools, profiles, skills, services, callbacks, its directory) is under 详情.
 * Its callbacks (api.hook): the address to give the platform (at `webUrl` when configured), the secret made
 * here and shown once, and the latest deliveries.
 */
type Delivery = { id: string; receivedAt: number; status: string; attempts: number; durationMs: number | null; error: string | null; retryAt: number | null; duplicates: number };
type Hook = { name: string; label: string | null; headerPath: string; url: string | null; secretHeader: string; ack: "first" | null;
  rateLimit: { perMinute: number; burst?: number }; secret: { createdAt: string; usedAt: string | null } | null;
  lastDelivery: { at: number; status: string; error: string | null } | null };
type Service = { name: string; description: string; command: string; running: boolean; startedAt: string | null; streams: number; log: string[] };
type Plugin = {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "data";
  /** Linked for development (omem plugin link): read where it is, trusted by directory. */
  linked?: boolean;
  /** Its blocks on omem's own pages (api.slot). */
  slots?: { at: string; block: string }[];
  dir: string | null;
  icon: string;
  iconChosen: boolean;
  trust: "builtin" | "none" | "trusted" | "required" | "changed";
  agents: { name: string; description?: string }[];
  skills: string[];
  spaces: { id: string; name: string; status: string }[];
  settings: boolean;
  flows?: { id: string; added: boolean; kept: boolean; exists: boolean; error: string | null }[];
  rules: { file: string; id: string | null; name: string; enabled: boolean; created: boolean; error?: string | null }[];
  mcp: { name: string; added: boolean; missing: string[] }[];
  tools: string[];
  page: { title: string } | null;
  services: { name: string; description: string; command: string }[];
  streams: { name: string; service: string }[];
  hooks?: Hook[];
  enabled: boolean;
  runMode: "isolated" | "inprocess" | null;
  /** Trusted for good: later code changes load without asking again. */
  permanentTrust?: boolean;
  version: string | null;
  installed: { source: string; version: string; installedAt: string } | null;
  /** AI backends it declares (docs/v2/plugins.md 声明式 ACP 后端): the command is code, read before trusting. */
  backends?: { id: string; name: string; command: string; args: string[] }[];
  permissions: { flow?: { signal?: boolean; run?: boolean; gate?: boolean }; tools: { name: string; write: boolean; approval: boolean }[]; writes: boolean; hostTools: string[]; providers: string[]; platforms: string[]; agentLogin?: string[]; credential?: boolean; uses: string[]; services: string[]; space: string | null };
};

const route = useRoute();
const editing = ref<Plugin | null>(null);
const plugins = ref<Plugin[] | null>(null);
const services = ref<Record<string, Service[]>>({});
/** Cards with 详情 open. */
const open = ref<Record<string, boolean>>({});
/** A callback's secret right after it was made: shown this once. */
const freshHook = ref<{ key: string; secret: string; legacyUrl: string } | null>(null);
/** Recent deliveries per callback (`<plugin>/<name>`); null while loading. */
const deliveries = ref<Record<string, Delivery[] | null>>({});
const allDeliveries = ref<Record<string, boolean>>({});
const deliverySeq: Record<string, number> = {};
const openLog = ref<string | null>(null);
const picking = ref<string | null>(null);
const source = ref("");
const busy = ref(false);

// ------------------------------------------------------------------ what a plugin may do and brings

/** Its own tools, in one line (the trust dialog). */
function toolLine(p: Plugin) {
  const m = p.permissions;
  const writes = m.tools.filter((t) => t.write).map((t) => t.name);
  if (m.tools.length) return `自己的工具 ${m.tools.length} 个${writes.length ? `，其中会写入的：${writes.join("、")}` : "，都只读"}${m.tools.some((t) => t.approval) ? "；有的每次要你批准" : ""}`;
  return m.writes ? "声明了会写入的工具（代码还没运行，看不到具体是哪些）" : "";
}
/** Commands it runs on this machine that are not one of its services (those show their own command): MCP ones. */
const otherCommands = (p: Plugin) => p.permissions.services.filter((c) => !p.services.some((s) => s.command === c));
/** What else it may do, besides its tools: each a sentence. `detail`: leave out what 详情 shows elsewhere. */
function permissionNotes(p: Plugin, detail = false) {
  const m = p.permissions;
  const commands = detail ? otherCommands(p) : m.services;
  return [
    m.providers.length ? `带来可连接的平台：${m.providers.length > 6 ? `${m.providers.length} 个` : m.providers.join("、")}` : "",
    m.platforms.length ? `给这些平台加读取和同步：${m.platforms.map((x) => x.replace(/^connect-/, "")).join("、")}` : "",
    m.agentLogin?.length ? `给成员登录这些 AI 后端，把凭据写进他们的账号目录：${m.agentLogin.join("、")}` : "",
    m.credential ? "给成员登记凭据：成员授权一次，凭据写进他们的账号目录，供给 AI 后端和命令行" : "",
    m.uses.length ? `以你的身份调用：${m.uses.join("、")}` : "",
    commands.length ? `在这台机器上运行：${commands.join("；")}` : "",
    m.space && !(detail && p.spaces.length) ? `用自己的空间 ${m.space}` : "",
    m.flow && (m.flow.signal || m.flow.run || m.flow.gate) ? `参与流程：${[m.flow.signal ? "判断阶段是否做完" : "", m.flow.run ? "执行你交给它的阶段（每次要你在确认卡上启用）" : "", m.flow.gate ? "阶段交结果前再检查一遍" : ""].filter(Boolean).join("、")}` : "",
  ].filter(Boolean);
}
/** Everything it may do, for the trust dialog. */
function permissionLines(p: Plugin) {
  const m = p.permissions;
  return [toolLine(p), m.hostTools.length ? `它的 Agent 还能用：${m.hostTools.join("、")}` : "", ...permissionNotes(p)].filter(Boolean);
}

/** What it brings, counted: “页面 · 2 个档案 · 9 个工具”. */
function summary(p: Plugin) {
  const n = (count: number, unit: string) => (count ? `${count} ${unit}` : "");
  return [
    p.page ? "页面" : "",
    n(p.agents.length, "个档案"),
    n(p.skills.length, "个技能"),
    n(p.permissions.tools.length || p.tools.length, "个工具"),
    n(p.rules.length, "条规则"),
    n(p.flows?.length ?? 0, "个流程"),
    n(p.spaces.length, "个空间"),
    n(p.mcp.length, "个 MCP"),
    n(p.backends?.length ?? 0, "个 AI 后端"),
    n(p.services.length, "个服务"),
    n(p.hooks?.length ?? 0, "个回调"),
    n(p.slots?.length ?? 0, "个页面块"),
    n(p.permissions.providers.length, "个可连接的平台"),
    n(p.permissions.platforms.length, "个平台的读取和同步"),
  ].filter(Boolean).join(" · ");
}

/** Short, where it came from: 内置 / 开发中 / npm · 1.2.0. The full source is in 详情. */
function sourceTag(p: Plugin) {
  if (p.source === "builtin") return { text: "内置", tone: "", title: "随 omem 更新" };
  if (p.linked) return { text: "开发中", tone: "accent", title: "omem plugin link 链接的目录：不复制，改了就重新加载；只在这台设备上" };
  if (p.installed) {
    const s = p.installed.source;
    const kind = s.startsWith("github:") ? "GitHub" : s.startsWith("npm:") ? "npm" : "本地";
    return { text: [kind, p.installed.version || p.version].filter(Boolean).join(" · "), tone: "", title: s };
  }
  return { text: "数据目录", tone: "", title: "放在数据目录 plugins/ 里的插件" };
}

type Need = { key: string; text: string; detail?: string; tone: "warn" | "danger"; act?: () => void; actText?: string; to?: string };
/** What waits for the owner on this plugin, shown on the card's face. */
function needs(p: Plugin): Need[] {
  const out: Need[] = [];
  if (p.trust === "required") out.push({ key: "trust", text: "带代码，你确认之前不运行", tone: "warn" });
  if (p.trust === "changed") out.push({ key: "trust", text: p.linked && !p.permissions.credential ? "链接的目录换了，要重新确认才运行" : "代码改过，要重新确认才运行", tone: "warn" });
  for (const h of p.hooks ?? []) {
    const name = hookName(h);
    if (!h.secret) out.push({ key: `hook:${h.name}`, text: `回调“${name}”还没有密钥，外部平台还接不进来`, tone: "warn", act: () => showHook(p, h), actText: "去生成" });
    else if (h.lastDelivery?.status === "failed") out.push({ key: `hook:${h.name}`, text: `回调“${name}”最近一次投递处理失败`, detail: h.lastDelivery.error ?? undefined, tone: "danger", act: () => showHook(p, h), actText: "查看" });
  }
  for (const m of p.mcp) if (m.missing.length) out.push({ key: `mcp:${m.name}`, text: `MCP“${m.name}”还要填：${m.missing.join("、")}`, tone: "warn", to: "/agents?tab=mcp", actText: "去填" });
  for (const r of p.rules) if (!r.id && r.error) out.push({ key: `rule:${r.file}`, text: `规则“${r.name}”没有创建`, detail: r.error, tone: "warn" });
  for (const f of p.flows ?? []) if (f.error) out.push({ key: `flow:${f.id}`, text: `流程“${f.id}”没有加入`, detail: f.error, tone: "warn" });
  return out;
}

const SLOT_WORDS: Record<string, string> = { "item.panel": "事项页侧栏", "flow.stage": "流程阶段下面", today: "今日页" };
const RUN_MODE = { isolated: "隔离运行：单独的进程，只能读它自己的目录", inprocess: "在 omem 里运行：用 omem 的全部权限" };

// ------------------------------------------------------------------ install, update, remove, enable

/** A package from source (docs/v2/flows.md §8): what the server would run, shown before anything of it runs. */
type BuildPlan = { id: string; source: string; missing: string[]; commands: string[]; scripts: Record<string, string>; key: string };
type Installed = { id: string; version: string; replaced: boolean; buildLog?: string };
/** Install or update; when the package must be built first, ask with the exact commands, then ask the server again with that plan. */
async function installing(path: string, body: Record<string, unknown>): Promise<Installed | null> {
  const r = await post<Installed | { build: BuildPlan }>(path, body);
  if (!("build" in r)) return r;
  const plan = r.build;
  const ok = await confirmDialog(`${plan.id} 要先构建`, {
    message: `它是源码，缺 ${plan.missing.join("、")}。确认后在它解开的临时目录里依次运行（依赖不运行安装脚本，最多 10 分钟，不带 omem 的密钥）：\n\n${plan.commands.join("\n")}\n\nnpm run build 会运行包自己的脚本：\n${Object.entries(plan.scripts).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n构建完照常要你看过权限、信任后才运行。`,
    okText: "构建并安装",
  });
  if (!ok) return null;
  return post<Installed>(path, { ...body, build: plan.key });
}

async function install() {
  if (!source.value.trim()) return;
  busy.value = true;
  try {
    const r = await installing("/api/plugins/install", { source: source.value.trim() });
    if (!r) return;
    toast(`已${r.replaced ? "更新" : "安装"} ${r.id}${r.version ? ` ${r.version}` : ""}；带代码的看过权限后点“信任并运行”`, "ok");
    source.value = "";
    await load();
    state.pluginsChanged++;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
async function update(p: Plugin) {
  const isGit = p.installed?.source.startsWith("github:");
  const next = isGit ? await promptDialog(`更新 ${p.name}`, { message: "GitHub 来源要写新的 tag 或提交，例如 github:owner/repo#v1.2.0", value: p.installed!.source, okText: "更新" }) : "";
  if (isGit && !next) return;
  busy.value = true;
  try {
    const r = await installing(`/api/plugins/${p.id}/update`, { source: next || undefined });
    if (!r) return;
    toast(`已更新到 ${r.version || "最新"}；代码变了，要重新信任`, "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
async function unlink(p: Plugin) {
  if (!(await confirmDialog(`去掉“${p.name}”的链接？`, { message: `只是不再从 ${p.dir} 读它，目录里的文件不动；它的工具、档案和页面马上消失。要再用就 omem plugin link。`, okText: "去掉链接" }))) return;
  try {
    await del(`/api/plugins/${p.id}`);
    await load();
    state.pluginsChanged++;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function remove(p: Plugin) {
  if (!(await confirmDialog(`删除插件“${p.name}”？`, { message: "它的目录会删掉，工具、档案和页面马上消失；它存下的原件、记忆和插件记录保留。", okText: "删除", danger: true }))) return;
  try {
    await del(`/api/plugins/${p.id}`);
    await load();
    state.pluginsChanged++;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function setEnabled(p: Plugin, on: boolean) {
  try {
    Object.assign(p, await put<Plugin>(`/api/plugins/${p.id}/enabled`, { on }));
    state.pluginsChanged++;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function load() {
  plugins.value = await get<Plugin[]>("/api/plugins");
  for (const p of plugins.value) if (p.services.length) services.value[p.id] = await get<Service[]>(`/api/plugins/${p.id}/services`);
}

// ------------------------------------------------------------------ trust

/**
 * isolated: its own process that can read only its directory (no secrets, no programs), asking omem for
 * everything else; inprocess: inside omem with omem's rights, needed for content blocks and new connectors.
 */
async function trust(p: Plugin, mode: "isolated" | "inprocess" = "isolated") {
  const backends = p.backends?.length ? `带来 AI 后端，信任后才能选，启动时运行：\n${p.backends.map((b) => `${b.name}：${[b.command, ...b.args].join(" ")}`).join("\n")}` : "";
  const what = [...permissionLines(p), backends, p.installed ? `来源：${p.installed.source}` : "", `目录：${p.dir}`].filter(Boolean).join("\n");
  const how =
    mode === "isolated"
      ? "它的代码在单独的进程里运行：只能读它自己的目录、写它自己的数据目录，读不到 omem 的密钥和你的其他文件，也不能启动别的程序（信任后单独加入的命令 MCP 除外）；读平台、存原件都经过 omem，按调用它的人的权限。"
      : "它的代码在 omem 的进程里运行，能读写你能读写的所有文件、用 omem 的全部权限。只对你自己写的或逐行看过的插件这样做；内容块、新的连接器、鉴权方式和聊天渠道只能这样运行。";
  const ok = await confirmDialog(`信任插件“${p.name}”？`, {
    message: `${how}${p.linked && !p.permissions.credential ? "它是链接的开发目录，信任按这个目录记：之后改代码不用再确认，改了会自动重新加载。" : p.linked ? "它是链接的开发目录，又给成员登记凭据：代码每改一次都要在这里重新确认。" : "代码以后有改动，要在这里重新确认。"}\n\n${what}`,
    okText: mode === "isolated" ? "隔离运行" : "在 omem 里运行",
    danger: mode === "inprocess",
  });
  if (!ok) return;
  try {
    await post(`/api/plugins/${p.id}/trust`, { mode });
    toast(`已信任 ${p.name}`, "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
/** Trust for good: later code, declaration and grant changes of this plugin load without asking again. */
async function setPermanent(p: Plugin, permanent: boolean) {
  if (permanent && !(await confirmDialog(`永久信任“${p.name}”？`, {
    message: `以后它的代码、声明和权限怎么更新，都直接按现在的方式（${p.runMode === "inprocess" ? "在 omem 里" : "隔离"}）运行，不再请你确认。只对你自己维护的插件这样做；随时可以在这里关掉。`,
    okText: "永久信任",
  }))) return;
  try {
    await post(`/api/plugins/${p.id}/trust`, { mode: p.runMode ?? "isolated", permanent });
    toast(permanent ? `${p.name} 以后更新不再确认` : `${p.name} 以后代码改了要重新确认`, "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function untrust(p: Plugin) {
  if (!(await confirmDialog(`撤销对“${p.name}”的信任？`, { message: "它的工具马上不可用，服务会停止；档案、技能和页面还在。", okText: "撤销" }))) return;
  await del(`/api/plugins/${p.id}/trust`);
  toast(`已撤销 ${p.name}`, "ok");
  await load();
}
async function service(p: Plugin, name: string, action: "start" | "stop") {
  try {
    await post(`/api/plugins/${p.id}/services/${name}/${action}`);
  } catch (e) {
    toast((e as Error).message, "error");
  }
  services.value[p.id] = await get<Service[]>(`/api/plugins/${p.id}/services`);
}

// ------------------------------------------------------------------ callbacks

const hookKey = (p: Plugin, h: Hook) => `${p.id}/${h.name}`;
const hookName = (h: Hook) => h.label || h.name;
/** The address to give the platform: the server's (`webUrl`), or where this page was opened from. */
const hookUrl = (h: Hook) => h.url ?? `${location.origin}${h.headerPath}`;
const loopback = (url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
};
const hookHeader = (h: Hook) => (h.secretHeader === "authorization" ? "Authorization: Bearer " : `${h.secretHeader}: `);
const when = (at: string | number) => fmt(at, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
function secretState(h: Hook) {
  if (!h.secret) return "还没有密钥";
  return `密钥生成于 ${when(h.secret.createdAt)} · ${h.secret.usedAt ? `上次使用 ${when(h.secret.usedAt)}` : "还没用过"}`;
}
const DELIVERY: Record<string, { text: string; tone: "ok" | "danger" | "accent" | "" }> = {
  done: { text: "已处理", tone: "ok" },
  failed: { text: "失败", tone: "danger" },
  running: { text: "处理中", tone: "accent" },
  pending: { text: "排队中", tone: "accent" },
  admitting: { text: "受理中", tone: "accent" },
  duplicate: { text: "重复", tone: "" },
};
const deliveryStatus = (d: Delivery) => (d.status === "pending" && d.attempts > 0 ? { text: "等待重试", tone: "accent" as const } : DELIVERY[d.status] ?? { text: d.status, tone: "" as const });
function deliveryNote(d: Delivery) {
  if (d.error) return d.error;
  if (d.status === "duplicate") return "同一投递又发了一次，沿用前一次的结果";
  return [d.attempts > 1 ? `第 ${d.attempts} 次尝试` : "", d.durationMs != null && d.status === "done" ? `用时 ${d.durationMs} ms` : ""].filter(Boolean).join(" · ");
}

async function loadDeliveries(p: Plugin, h: Hook) {
  const key = hookKey(p, h), seq = (deliverySeq[key] = (deliverySeq[key] ?? 0) + 1);
  if (!deliveries.value[key]) deliveries.value[key] = null;
  try {
    const list = await get<Delivery[]>(`/api/plugins/${p.id}/hooks/${h.name}/deliveries`);
    if (deliverySeq[key] !== seq) return;
    deliveries.value[key] = list;
    const last = list.find((d) => d.status !== "duplicate");
    h.lastDelivery = last ? { at: last.receivedAt, status: last.status, error: last.error } : null;
  } catch (e) {
    if (deliverySeq[key] !== seq) return;
    deliveries.value[key] = [];
    toast((e as Error).message, "error");
  }
}
async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${what}`, "ok");
  } catch {
    toast("复制失败，请手动选中复制", "error");
  }
}
async function makeSecret(p: Plugin, h: Hook) {
  if (h.secret && !(await confirmDialog(`重新生成“${hookName(h)}”的密钥？`, { message: "旧密钥立即失效，外部平台要换用新密钥才能继续投递。", okText: "重新生成" }))) return;
  try {
    const r = await post<{ secret: string; path: string; legacyUrl: string | null }>(`/api/plugins/${p.id}/hooks/${h.name}/secret`);
    freshHook.value = { key: hookKey(p, h), secret: r.secret, legacyUrl: r.legacyUrl ?? `${location.origin}${r.path}` };
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function revokeSecret(p: Plugin, h: Hook) {
  if (!(await confirmDialog(`撤销“${hookName(h)}”的密钥？`, { message: "外部平台之后用这个密钥投递会被拒绝；已经收下的投递不受影响。", okText: "撤销" }))) return;
  try {
    await del(`/api/plugins/${p.id}/hooks/${h.name}/secret`);
    if (freshHook.value?.key === hookKey(p, h)) freshHook.value = null;
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ------------------------------------------------------------------ 详情

function setOpen(p: Plugin, on: boolean) {
  open.value[p.id] = on;
  if (on) for (const h of p.hooks ?? []) if (deliveries.value[hookKey(p, h)] === undefined) void loadDeliveries(p, h);
}
/** From a note on the card's face: open 详情 at that callback. */
async function showHook(p: Plugin, h: Hook) {
  setOpen(p, true);
  await nextTick();
  const el = document.getElementById(`hook-${p.id}-${h.name}`);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  el?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}

/** The nav icon (empty: back to the plugin's own). */
async function setIcon(p: Plugin, icon: string) {
  try {
    const next = await put<Plugin>(`/api/plugins/${p.id}/icon`, { icon });
    Object.assign(p, { icon: next.icon, iconChosen: next.iconChosen });
    picking.value = null;
    state.pluginsChanged++;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

/** `?plugin=<id>` (links from elsewhere): scroll to that card with its 详情 open. */
async function locate() {
  const id = route.query.plugin;
  const p = typeof id === "string" ? plugins.value?.find((x) => x.id === id) : null;
  if (!p) return;
  setOpen(p, true);
  await nextTick();
  document.getElementById(`plugin-${p.id}`)?.scrollIntoView({ block: "start" });
}
watch(() => route.query.plugin, locate);
onMounted(() => void load().then(locate).catch((e) => toast((e as Error).message, "error")));
</script>

<template>
  <div class="stack">
    <HelpText lead>
      插件给 omem 加上页面、档案、技能、工具和外部平台的连接；带代码的要你看过它能做什么、确认后才运行。
      <a class="lnk" href="https://github.com/lejunyang/omem/blob/main/docs/v2/plugins.md" target="_blank" rel="noopener">怎么写插件</a>
    </HelpText>
    <div class="card pad stack">
      <strong>安装插件</strong>
      <div class="row wrap">
        <input v-model="source" class="input grow" placeholder="本地目录、npm:包名@版本 或 github:owner/repo#tag" aria-label="插件来源" @keydown.enter="install" />
        <button class="btn sm primary" :disabled="busy || !source.trim()" @click="install">{{ busy ? "安装中…" : "安装" }}</button>
      </div>
      <p class="muted small">不运行包里的安装脚本；GitHub 来源要写 tag 或提交，分支会在信任之后变。</p>
    </div>
    <PluginPack />
    <PluginSettings v-if="editing" :key="editing.id" :plugin="editing.id" :title="editing.name" @close="editing = null" @saved="load" />
    <Skeleton v-if="!plugins" variant="text" :rows="4" />
    <p v-else-if="!plugins.length" class="muted">还没有插件。</p>
    <article v-for="p in plugins ?? []" :key="p.id" :id="`plugin-${p.id}`" class="card pad plugin" :class="{ off: !p.enabled }">
      <div class="p-head">
        <button
          v-if="p.page"
          class="btn ghost sm icon p-icon"
          :title="`换菜单图标（${p.page.title}）`"
          :aria-label="`换菜单图标（${p.page.title}）`"
          :aria-expanded="picking === p.id"
          @click="picking = picking === p.id ? null : p.id"
        >
          <Icon :name="p.icon" :size="17" />
        </button>
        <span v-else class="p-icon plain" aria-hidden="true"><Icon :name="p.icon" :size="17" /></span>
        <div class="p-title">
          <div class="p-name">
            <strong>{{ p.name }}</strong>
            <span class="badge p-source" :class="sourceTag(p).tone" :title="sourceTag(p).title">{{ sourceTag(p).text }}</span>
          </div>
          <p v-if="p.description" class="p-desc">{{ p.description }}</p>
        </div>
        <div class="p-ctl">
          <button v-if="p.settings" class="btn ghost sm" @click="editing = p">设置</button>
          <UiCheckbox :model-value="p.enabled" switch size="sm" :aria-label="`启用${p.name}`" @change="(v) => setEnabled(p, v)">{{ p.enabled ? "已启用" : "已停用" }}</UiCheckbox>
        </div>
      </div>
      <div v-if="picking === p.id" class="icons">
        <div class="grid" role="radiogroup" :aria-label="`${p.page?.title} 的菜单图标`">
          <button
            v-for="i in PLUGIN_ICONS"
            :key="i.name"
            type="button"
            role="radio"
            class="btn ghost sm icon"
            :class="{ on: p.icon === i.name }"
            :aria-checked="p.icon === i.name"
            :title="i.label"
            :aria-label="i.label"
            @click="setIcon(p, i.name)"
          >
            <Icon :name="i.name" :size="17" />
          </button>
        </div>
        <button v-if="p.iconChosen" class="lnk small" @click="setIcon(p, '')">用插件自己的图标</button>
      </div>
      <ul v-if="needs(p).length" class="p-needs" :aria-label="`${p.name} 需要你处理`">
        <li v-for="n in needs(p)" :key="n.key" :class="n.tone">
          <span class="dot" aria-hidden="true" />
          <span class="need-text">
            {{ n.text }}<span v-if="n.detail" class="need-detail" :title="n.detail">：{{ n.detail }}</span>
          </span>
          <template v-if="n.key === 'trust'">
            <button class="btn sm primary" @click="trust(p)">信任并运行</button>
            <button class="btn ghost sm" @click="trust(p, 'inprocess')">在 omem 里运行…</button>
          </template>
          <button v-else-if="n.act" class="btn ghost sm" @click="n.act">{{ n.actText }}</button>
          <RouterLink v-else-if="n.to" class="btn ghost sm" :to="n.to">{{ n.actText }}</RouterLink>
        </li>
      </ul>
      <div class="p-sum">
        <span class="p-brings">{{ summary(p) }}</span>
        <button class="lnk small p-more" :aria-expanded="!!open[p.id]" :aria-controls="`plugin-detail-${p.id}`" @click="setOpen(p, !open[p.id])">
          {{ open[p.id] ? "收起详情" : "详情" }}<Icon name="down" :size="13" :class="{ up: open[p.id] }" />
        </button>
      </div>

      <div v-if="open[p.id]" :id="`plugin-detail-${p.id}`" class="p-detail">
        <dl class="facts">
          <template v-if="p.permissions.tools.length || p.permissions.writes">
            <dt>工具</dt>
            <dd>
              <ul v-if="p.permissions.tools.length" class="chips">
                <li v-for="t in p.permissions.tools" :key="t.name">
                  <code>{{ t.name }}</code><span v-if="t.write" class="badge warn">会写入</span><span v-if="t.approval" class="badge">每次问你</span>
                </li>
              </ul>
              <span v-else class="muted">声明了会写入的工具（代码还没运行，看不到具体是哪些）</span>
            </dd>
          </template>
          <template v-if="p.permissions.hostTools.length">
            <dt>还能用</dt>
            <dd>
              <span class="muted">它的 Agent 还能用 omem 的这些工具：</span>
              <ul class="chips"><li v-for="t in p.permissions.hostTools" :key="t"><code>{{ t }}</code></li></ul>
            </dd>
          </template>
          <template v-if="permissionNotes(p, true).length">
            <dt>权限</dt>
            <dd><ul class="notes"><li v-for="l in permissionNotes(p, true)" :key="l">{{ l }}</li></ul></dd>
          </template>
          <template v-if="p.page || p.slots?.length">
            <dt>页面</dt>
            <dd>
              <span v-if="p.page">侧栏里的“{{ p.page.title }}”</span>
              <span v-if="p.slots?.length" :title="p.slots.map((s) => s.block).join('、')">{{ p.page ? "；" : "" }}放在 {{ p.slots.map((s) => SLOT_WORDS[s.at] ?? s.at).join("、") }}</span>
            </dd>
          </template>
          <template v-if="p.agents.length">
            <dt>档案</dt>
            <dd><ul class="chips"><li v-for="a in p.agents" :key="a.name" :title="a.description || undefined"><code>{{ a.name }}</code></li></ul></dd>
          </template>
          <template v-if="p.skills.length">
            <dt>技能</dt>
            <dd><ul class="chips"><li v-for="s in p.skills" :key="s"><code>{{ s }}</code></li></ul></dd>
          </template>
          <template v-if="p.backends?.length">
            <dt>AI 后端</dt>
            <dd class="lines">
              <div v-for="b in p.backends" :key="b.id" class="backend-line">
                <RouterLink class="lnk" :to="{ path: '/settings', query: { tab: 'agents' } }">{{ b.name }}</RouterLink>
                <MonoLine :text="[b.command, ...b.args].join(' ')" copy />
              </div>
            </dd>
          </template>
          <template v-if="p.spaces.length">
            <dt>空间</dt>
            <dd class="lines"><span v-for="s in p.spaces" :key="s.id" :title="s.id">{{ s.name }} · {{ s.status }}</span></dd>
          </template>
          <template v-if="p.flows?.length">
            <dt>流程</dt>
            <dd class="lines">
              <span v-for="f in p.flows" :key="f.id">
                <RouterLink v-if="f.exists" class="lnk" to="/flows">{{ f.id }}</RouterLink><span v-else>{{ f.id }}</span>
                <span class="muted"> · {{ f.error ? `没有加入：${f.error}` : f.kept ? "已有同名流程，没有覆盖" : f.added ? f.exists ? "已加入" : "已删除，不再自动加入" : "尚未加入" }}</span>
              </span>
            </dd>
          </template>
          <template v-if="p.rules.length">
            <dt>规则</dt>
            <dd class="lines">
              <span v-for="r in p.rules" :key="r.file">
                <RouterLink v-if="r.id" class="lnk" :to="`/rules?id=${r.id}`">{{ r.name }}</RouterLink><span v-else>{{ r.name }}</span>
                <span class="muted"> · {{ r.id ? r.enabled ? "已启用" : "还没启用" : r.created ? "已删除，不再自动创建" : r.error ? `没有创建：${r.error}` : "尚未导入" }}</span>
              </span>
            </dd>
          </template>
          <template v-if="p.mcp.length">
            <dt>MCP</dt>
            <dd class="lines">
              <span v-for="m in p.mcp" :key="m.name">
                <RouterLink class="lnk" to="/agents?tab=mcp">{{ m.name }}</RouterLink>
                <span class="muted"> · {{ m.added ? "已加入" : "等待启用或信任" }}<template v-if="m.missing.length"> · 还要填：{{ m.missing.join("、") }}</template></span>
              </span>
            </dd>
          </template>
          <template v-if="p.dir || p.installed">
            <dt>来源</dt>
            <dd class="lines">
              <span v-if="p.installed">{{ p.installed.source }}<span class="muted"> · {{ p.installed.version || p.version }} · 装于 {{ when(p.installed.installedAt) }}</span></span>
              <span v-else-if="p.version" class="muted">版本 {{ p.version }}</span>
              <MonoLine v-if="p.dir" :text="p.dir" copy />
            </dd>
          </template>
          <template v-if="p.trust === 'trusted' && p.runMode">
            <dt>运行</dt>
            <dd class="lines">
              <span :class="{ 'warn-text': p.runMode === 'inprocess' }">{{ RUN_MODE[p.runMode] }}</span>
              <div class="row wrap">
                <UiCheckbox v-if="p.source === 'data'" :model-value="!!p.permanentTrust" switch size="sm" :aria-label="`永久信任${p.name}`" @change="(v) => setPermanent(p, v)">以后更新不再确认</UiCheckbox>
                <button v-if="p.runMode === 'isolated'" class="btn ghost sm" @click="trust(p, 'inprocess')">改成在 omem 里运行…</button>
                <button class="btn ghost sm danger" @click="untrust(p)">撤销信任</button>
              </div>
            </dd>
          </template>
        </dl>

        <section v-if="services[p.id]?.length" class="sub">
          <h4>服务</h4>
          <div v-for="s in services[p.id]" :key="s.name" class="block">
            <div class="row wrap small">
              <span class="dot" :class="{ on: s.running }" aria-hidden="true" />
              <strong class="mono">{{ s.name }}</strong>
              <span class="muted">{{ s.running ? `运行中${s.streams ? ` · ${s.streams} 个连接` : ""}` : "未运行" }}</span>
              <span class="spacer" />
              <button v-if="!s.running" class="btn ghost sm" :disabled="p.trust !== 'builtin' && p.trust !== 'trusted'" @click="service(p, s.name, 'start')">启动</button>
              <button v-else class="btn ghost sm" @click="service(p, s.name, 'stop')">停止</button>
              <button class="btn ghost sm" :aria-expanded="openLog === `${p.id}/${s.name}`" @click="openLog = openLog === `${p.id}/${s.name}` ? null : `${p.id}/${s.name}`">输出</button>
            </div>
            <p v-if="s.description" class="muted small">{{ s.description }}</p>
            <MonoLine :text="s.command" copy />
            <pre v-if="openLog === `${p.id}/${s.name}`" class="log">{{ s.log.join("\n") || "（还没有输出）" }}</pre>
          </div>
        </section>

        <section v-if="p.hooks?.length" class="sub">
          <h4>回调</h4>
          <div v-for="h in p.hooks" :key="h.name" :id="`hook-${p.id}-${h.name}`" class="block hook">
            <div class="row wrap hook-head">
              <span class="dot" :class="{ on: !!h.secret }" aria-hidden="true" />
              <strong :title="h.name">{{ hookName(h) }}</strong>
              <span class="muted small">{{ secretState(h) }}</span>
              <span class="spacer" />
              <button class="btn sm" :class="h.secret ? 'ghost' : 'primary'" :disabled="!p.enabled" @click="makeSecret(p, h)">{{ h.secret ? "重新生成" : "生成密钥" }}</button>
              <button v-if="h.secret" class="btn ghost sm" @click="revokeSecret(p, h)">撤销</button>
            </div>
            <div class="kv">
              <span class="k">地址</span>
              <div class="v">
                <div class="addr"><code>{{ hookUrl(h) }}</code><button class="btn ghost sm" @click="copy(hookUrl(h), '回调地址')">复制</button></div>
                <p v-if="loopback(hookUrl(h))" class="hint warn-text">
                  这个地址只有本机能访问，外部平台要用这台机器能被访问到的地址。<RouterLink :to="{ path: '/settings', query: { card: 'web-url' } }">填网页地址</RouterLink>
                </p>
              </div>
            </div>
            <div v-if="freshHook?.key === hookKey(p, h)" class="kv fresh">
              <span class="k">新密钥</span>
              <div class="v">
                <div class="addr"><code>{{ hookHeader(h) }}{{ freshHook.secret }}</code><button class="btn ghost sm" @click="copy(hookHeader(h) + freshHook.secret, '请求头')">复制</button></div>
                <p class="hint">放进请求头。只显示这一次，离开页面后就看不到了。</p>
                <details class="small">
                  <summary>外部平台不能加请求头？</summary>
                  <p class="muted">用带密钥的地址。密钥可能留在外部平台的投递日志里。</p>
                  <div class="addr"><code>{{ freshHook.legacyUrl }}</code><button class="btn ghost sm" @click="copy(freshHook.legacyUrl, '带密钥的地址')">复制</button></div>
                </details>
              </div>
            </div>
            <div class="deliveries">
              <div class="row small">
                <span class="k">最近投递</span>
                <span class="spacer" />
                <button class="btn ghost sm" :aria-label="`刷新“${hookName(h)}”的投递`" @click="loadDeliveries(p, h)"><Icon name="refresh" :size="13" />刷新</button>
              </div>
              <Skeleton v-if="deliveries[hookKey(p, h)] === null" variant="text" :rows="2" />
              <p v-else-if="!deliveries[hookKey(p, h)]?.length" class="muted small">还没有收到投递。在外部平台点一次测试发送，再点刷新。</p>
              <ul v-else class="d-list">
                <li v-for="d in (allDeliveries[hookKey(p, h)] ? deliveries[hookKey(p, h)] : deliveries[hookKey(p, h)]!.slice(0, 5))" :key="d.id">
                  <span class="d-time">{{ when(d.receivedAt) }}</span>
                  <span class="d-status" :class="deliveryStatus(d).tone"><span class="dot" aria-hidden="true" />{{ deliveryStatus(d).text }}</span>
                  <span class="d-note" :title="deliveryNote(d) || undefined">{{ deliveryNote(d) }}</span>
                </li>
              </ul>
              <button v-if="(deliveries[hookKey(p, h)]?.length ?? 0) > 5" class="lnk small" @click="allDeliveries[hookKey(p, h)] = !allDeliveries[hookKey(p, h)]">
                {{ allDeliveries[hookKey(p, h)] ? "只看最近 5 条" : `看全部 ${deliveries[hookKey(p, h)]!.length} 条` }}
              </button>
            </div>
            <details class="how small">
              <summary>接入说明</summary>
              <ul class="notes">
                <li>外部平台用 POST 投递到上面的地址。</li>
                <li>密钥放请求头：<code>{{ hookHeader(h) }}&lt;密钥&gt;</code></li>
                <li>{{ h.ack === "first" ? "收下就应答，之后再处理；处理失败会自动重试两次。" : "处理完才应答，处理失败时回 400，不重试。" }}</li>
                <li>每分钟最多 {{ h.rateLimit.perMinute }} 次{{ h.rateLimit.burst ? `，可以一下子来 ${h.rateLimit.burst} 次` : "" }}；正文最多 1 MiB。</li>
              </ul>
            </details>
          </div>
        </section>

        <div v-if="p.installed || p.linked" class="row wrap p-foot">
          <button v-if="p.installed" class="btn ghost sm" :disabled="busy" @click="update(p)">更新</button>
          <button v-if="p.installed" class="btn ghost sm danger" @click="remove(p)">删除</button>
          <button v-if="p.linked" class="btn ghost sm" @click="unlink(p)">去掉链接</button>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.plugin {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.p-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 12px;
  min-width: 0;
}
.p-icon {
  flex: none;
  width: 30px;
  height: 30px;
}
.p-icon.plain {
  display: inline-grid;
  place-items: center;
  color: var(--ink-2);
}
.p-title {
  flex: 1 1 220px;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.p-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 30px;
}
.p-name strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-source {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.p-desc {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
}
.p-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  margin-left: auto;
}
.plugin.off .p-name strong,
.plugin.off .p-desc {
  color: var(--muted);
}
.p-needs {
  list-style: none;
  margin: 0;
  padding: 8px 12px;
  display: grid;
  gap: 6px;
  background: var(--warn-soft);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.p-needs li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
.p-needs .dot {
  background: var(--warn);
}
.p-needs .danger .dot {
  background: var(--danger);
}
.need-text {
  flex: 1 1 240px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.need-detail {
  color: var(--ink-2);
}
.p-sum {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  font-size: 13px;
  color: var(--ink-2);
  min-width: 0;
}
.p-brings {
  min-width: 0;
}
.p-more {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.p-more .up {
  transform: rotate(180deg);
}
.p-detail {
  display: grid;
  gap: 14px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
  min-width: 0;
}
.p-detail p {
  margin: 0;
}
.facts {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 8px 12px;
  margin: 0;
  font-size: 13px;
}
.facts dt {
  color: var(--muted);
}
.facts dd {
  margin: 0;
  min-width: 0;
}
.lines {
  display: grid;
  gap: 4px;
}
.chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.chips li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.chips code,
.notes code {
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.notes {
  margin: 0;
  padding-left: 1.2em;
  display: grid;
  gap: 2px;
}
.sub {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.sub h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.block {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  min-width: 0;
}
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line-strong);
}
.dot.on {
  background: var(--ok);
}
.hook-head strong {
  font-size: 14px;
}
.kv {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
}
.k {
  color: var(--muted);
  font-size: 12px;
}
.v {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.addr {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}
.addr code {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
  word-break: break-all;
  padding-top: 4px;
}
.addr .btn {
  flex: none;
}
.fresh {
  background: var(--sunken);
  border-radius: var(--radius-sm);
  padding: 8px;
}
.fresh details {
  display: grid;
  gap: 4px;
}
.deliveries {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.deliveries .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.d-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  font-size: 13px;
}
.d-list li {
  display: grid;
  grid-template-columns: 92px 76px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 3px 0;
  border-top: 1px solid var(--line);
}
.d-time {
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
  white-space: nowrap;
}
.d-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.d-status.ok .dot { background: var(--ok); }
.d-status.danger { color: var(--danger); }
.d-status.danger .dot { background: var(--danger); }
.d-status.accent .dot { background: var(--accent); }
.d-note {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.how summary,
.fresh summary {
  cursor: pointer;
  color: var(--muted);
}
.how .notes {
  margin-top: 6px;
  color: var(--ink-2);
}
.p-foot {
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
.log {
  max-height: 240px;
  overflow: auto;
  background: var(--sunken);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font: 12px/1.5 var(--mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
}
.icons {
  display: grid;
  gap: 6px;
  justify-items: start;
}
.icons .grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.icons .btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.backend-line {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.grow {
  flex: 1 1 260px;
  min-width: 0;
}
@media (max-width: 560px) {
  .facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .facts dd {
    margin-bottom: 6px;
  }
  .d-list li {
    grid-template-columns: auto auto minmax(0, 1fr);
  }
}
</style>
