<script setup lang="ts">
import PluginPack from "./PluginPack.vue";
import PluginSettings from "./PluginSettings.vue";
import { useRoute } from "vue-router";
import HelpText from "./HelpText.vue";
import { nextTick, onMounted, ref, watch } from "vue";
import { del, get, post, put } from "../api";
import { PLUGIN_ICONS } from "../lib/icons";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { state, toast } from "../store";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";

/**
 * Settings → 插件 (docs/v2/plugins.md): installing someone else's plugin (an npm package or a GitHub tag),
 * turning plugins on and off, what each may do, trusting the code of plugins in the data directory (and
 * withdrawing it), updating or removing installed ones, and their services: running or not, recent output.
 * Its callbacks (api.hook): the address another system calls, with a secret made here and shown once.
 */
type Hook = { name: string; label: string | null; path: string; secret: { createdAt: string; usedAt: string | null } | null };
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
  agents: { name: string }[];
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
  version: string | null;
  installed: { source: string; version: string; installedAt: string } | null;
  permissions: { tools: { name: string; write: boolean; approval: boolean }[]; writes: boolean; hostTools: string[]; providers: string[]; platforms: string[]; agentLogin?: string[]; uses: string[]; services: string[]; space: string | null };
};

const route = useRoute();
const editing = ref<Plugin | null>(null);
const plugins = ref<Plugin[] | null>(null);
const services = ref<Record<string, Service[]>>({});
/** A callback address with its secret, right after it was made: shown this once. */
const freshHook = ref<{ key: string; url: string } | null>(null);
const openLog = ref<string | null>(null);
const picking = ref<string | null>(null);
const source = ref("");
const busy = ref(false);

/** What a plugin may do, in a few lines (shown on its card and before trusting it). */
function permissionLines(p: Plugin) {
  const m = p.permissions;
  const writes = m.tools.filter((t) => t.write).map((t) => t.name);
  return [
    m.tools.length ? `自己的工具 ${m.tools.length} 个${writes.length ? `，其中会写入的：${writes.join("、")}` : "，都只读"}${m.tools.some((t) => t.approval) ? "；有的每次要你批准" : ""}` : m.writes ? "声明了会写入的工具（代码还没运行，看不到具体是哪些）" : "",
    m.hostTools.length ? `它的 Agent 还能用：${m.hostTools.join("、")}` : "",
    m.providers.length ? `带来可连接的平台：${m.providers.length > 6 ? `${m.providers.length} 个` : m.providers.join("、")}` : "",
    m.platforms.length ? `给这些平台加读取和同步：${m.platforms.map((x) => x.replace(/^connect-/, "")).join("、")}` : "",
    m.agentLogin?.length ? `给成员登录这些 AI 后端，把凭据写进他们的账号目录：${m.agentLogin.join("、")}` : "",
    m.uses.length ? `以你的身份调用：${m.uses.join("、")}` : "",
    m.services.length ? `在这台机器上运行：${m.services.join("；")}` : "",
    m.space ? `用自己的空间 ${m.space}` : "",
  ].filter(Boolean);
}
const sourceLabel = (p: Plugin) => (p.source === "builtin" ? "内置" : p.linked ? (p.dir ?? "") : p.installed ? p.installed.source : "数据目录里的");

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

const SLOT_WORDS: Record<string, string> = { "item.panel": "事项页侧栏", "flow.stage": "流程阶段下面", today: "今日页" };
const TRUST: Record<Plugin["trust"], string> ={ builtin: "内置", none: "声明式场景包", trusted: "已信任", required: "需要信任，尚未确认", changed: "代码改过，需要重新确认" };

async function load() {
  plugins.value = await get<Plugin[]>("/api/plugins");
  for (const p of plugins.value) if (p.services.length) services.value[p.id] = await get<Service[]>(`/api/plugins/${p.id}/services`);
}

/**
 * isolated: its own process that can read only its directory (no secrets, no programs), asking omem for
 * everything else; inprocess: inside omem with omem's rights, needed for content blocks and new connectors.
 */
async function trust(p: Plugin, mode: "isolated" | "inprocess" = "isolated") {
  const what = [...permissionLines(p), p.installed ? `来源：${p.installed.source}` : "", `目录：${p.dir}`].filter(Boolean).join("\n");
  const how =
    mode === "isolated"
      ? "它的代码在单独的进程里运行：只能读它自己的目录、写它自己的数据目录，读不到 omem 的密钥和你的其他文件，也不能启动别的程序（信任后单独加入的命令 MCP 除外）；读平台、存原件都经过 omem，按调用它的人的权限。"
      : "它的代码在 omem 的进程里运行，能读写你能读写的所有文件、用 omem 的全部权限。只对你自己写的或逐行看过的插件这样做；内容块、新的连接器、鉴权方式和聊天渠道只能这样运行。";
  const ok = await confirmDialog(`信任插件“${p.name}”？`, {
    message: `${how}${p.linked ? "它是链接的开发目录，信任按这个目录记：之后改代码不用再确认，改了会自动重新加载。" : "代码以后有改动，要在这里重新确认。"}\n\n${what}`,
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

const hookUrl = (path: string) => `${location.origin}${path}`;
const when = (at: string) => new Date(at).toLocaleString();
async function makeSecret(p: Plugin, h: Hook) {
  if (h.secret && !(await confirmDialog(`重新生成“${h.label ?? h.name}”的回调地址？`, { message: "旧地址马上失效，外部平台要改成新地址。", okText: "重新生成" }))) return;
  try {
    const r = await post<{ secret: string; path: string }>(`/api/plugins/${p.id}/hooks/${h.name}/secret`);
    freshHook.value = { key: `${p.id}/${h.name}`, url: hookUrl(r.path) };
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function revokeSecret(p: Plugin, h: Hook) {
  if (!(await confirmDialog(`撤销“${h.label ?? h.name}”的回调地址？`, { message: "外部平台再调用会得到 404，omem 回到按间隔去读。", okText: "撤销" }))) return;
  await del(`/api/plugins/${p.id}/hooks/${h.name}/secret`);
  if (freshHook.value?.key === `${p.id}/${h.name}`) freshHook.value = null;
  await load();
}
async function copyHook(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast("已复制回调地址", "ok");
  } catch {
    toast("复制失败，请手动选中复制", "error");
  }
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

async function locate() {
  await nextTick();
  const id = route.query.plugin;
  if (typeof id === "string") document.getElementById(`plugin-${id}`)?.scrollIntoView({ block: "start" });
}
watch(() => route.query.plugin, locate);
onMounted(() => void load().then(locate).catch((e) => toast((e as Error).message, "error")));
</script>

<template>
  <div class="stack">
    <HelpText lead>插件带来空间、档案、技能、规则、MCP、工具、页面和聊天渠道。内置插件随 omem 更新；放在数据目录 <span class="mono">plugins/</span> 里的是你自己的；装进来的和你自己的，带代码的都要你看过权限、确认后才运行。写法见 docs/v2/plugins.md。</HelpText>
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
    <div v-for="p in plugins ?? []" :key="p.id" :id="`plugin-${p.id}`" class="card pad stack plugin-card">
      <div class="row wrap">
        <button
          v-if="p.page"
          class="btn ghost sm icon"
          :title="`菜单图标（${p.page.title}）`"
          :aria-label="`换菜单图标（${p.page.title}）`"
          :aria-expanded="picking === p.id"
          @click="picking = picking === p.id ? null : p.id"
        >
          <Icon :name="p.icon" :size="17" />
        </button>
        <strong>{{ p.name }}</strong><span class="muted small mono">{{ p.id }}</span>
        <span v-if="p.linked" class="badge accent" title="omem plugin link 链接的目录：不复制，改了就重新加载；只在这台设备上">开发中</span>
        <span class="badge" :class="{ warn: p.trust === 'required' || p.trust === 'changed', ok: p.trust === 'trusted' }">{{ p.linked && p.trust === "changed" ? "链接的目录换了，需要重新确认" : TRUST[p.trust] }}</span>
        <span v-if="p.source !== 'builtin' || p.version" class="muted small path" :title="p.linked ? p.dir ?? '' : undefined">{{ p.source === "builtin" ? "" : sourceLabel(p) }}{{ p.version ? `${p.source === "builtin" ? "" : " · "}${p.version}` : "" }}</span>
        <span class="spacer" />
        <button v-if="p.settings" class="btn ghost sm" @click="editing = p">设置</button>
        <UiCheckbox :model-value="p.enabled" switch size="sm" :aria-label="`启用${p.name}`" @change="(v) => setEnabled(p, v)">启用</UiCheckbox>
        <span v-if="p.trust === 'trusted' && p.runMode" class="badge" :class="{ warn: p.runMode === 'inprocess' }">{{ p.runMode === "isolated" ? "隔离运行" : "在 omem 里运行" }}</span>
        <button v-if="p.trust === 'required' || p.trust === 'changed'" class="btn sm primary" @click="trust(p)">信任并运行</button>
        <button v-if="p.trust === 'required' || p.trust === 'changed' || (p.trust === 'trusted' && p.runMode === 'isolated')" class="btn ghost sm" @click="trust(p, 'inprocess')">在 omem 里运行…</button>
        <button v-if="p.trust === 'trusted'" class="btn ghost sm danger" @click="untrust(p)">撤销信任</button>
        <button v-if="p.installed" class="btn ghost sm" :disabled="busy" @click="update(p)">更新</button>
        <button v-if="p.installed" class="btn ghost sm danger" @click="remove(p)">删除</button>
        <button v-if="p.linked" class="btn ghost sm" @click="unlink(p)">去掉链接</button>
      </div>
      <div v-if="picking === p.id" class="icons stack">
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
        <div v-if="p.iconChosen" class="row"><button class="lnk small" @click="setIcon(p, '')">用插件自己的图标</button></div>
      </div>
      <p v-if="p.description" class="muted small">{{ p.description }}</p>
      <p v-if="p.dir" class="muted small mono path">{{ p.dir }}</p>
      <ul v-if="permissionLines(p).length" class="small perms">
        <li v-for="l in permissionLines(p)" :key="l">{{ l }}</li>
      </ul>
      <div class="small facts">
        <span v-if="p.page">页面：{{ p.page.title }}</span>
        <span v-if="p.agents.length">档案：<span class="mono">{{ p.agents.map((a) => a.name).join("、") }}</span></span>
        <span v-if="p.skills.length">技能：{{ p.skills.join("、") }}</span>
        <span v-if="p.tools.length">工具：<span class="mono">{{ p.tools.join("、") }}</span></span>
        <span v-if="p.slots?.length">放在页面上：{{ p.slots.map((s) => `${SLOT_WORDS[s.at] ?? s.at}（${s.block}）`).join("、") }}</span>
      </div>
      <div v-for="s in p.spaces" :key="s.id" class="small path">空间：{{ s.name }}（{{ s.id }}） · {{ s.status }}</div>
      <div v-for="f in p.flows ?? []" :key="`flow:${f.id}`" class="small">
        流程：<RouterLink v-if="f.exists" class="lnk" to="/flows">{{ f.id }}</RouterLink><span v-else>{{ f.id }}</span>
        · {{ f.error ? `没有加入：${f.error}` : f.kept ? "已有同名流程，没有覆盖" : f.added ? f.exists ? "已加入流程" : "已删除，不再自动加入" : "尚未加入" }}
      </div>
      <div v-for="r in p.rules" :key="r.file" class="small">
        规则：<RouterLink v-if="r.id" class="lnk" :to="`/rules?id=${r.id}`">{{ r.name }}</RouterLink><span v-else>{{ r.name }}</span>
        · {{ r.id ? r.enabled ? "已启用" : "还没启用" : r.created ? "已删除，不再自动创建" : r.error ? `没有创建：${r.error}` : "尚未导入" }}
      </div>
      <div v-for="m in p.mcp" :key="m.name" class="small">
        MCP：<RouterLink class="lnk" to="/agents?tab=mcp">{{ m.name }}</RouterLink> · {{ m.added ? "已加入" : "等待启用或信任" }}<span v-if="m.missing.length"> · 还要填：{{ m.missing.join("、") }}</span>
      </div>
      <div v-for="s in services[p.id] ?? []" :key="s.name" class="service stack">
        <div class="row wrap small">
          <span class="dot" :class="{ on: s.running }" aria-hidden="true" />
          <strong class="mono">{{ s.name }}</strong>
          <span class="muted">{{ s.running ? `运行中${s.streams ? ` · ${s.streams} 个连接` : ""}` : "未运行" }}</span>
          <span class="spacer" />
          <button v-if="!s.running" class="btn ghost sm" :disabled="p.trust !== 'builtin' && p.trust !== 'trusted'" @click="service(p, s.name, 'start')">启动</button>
          <button v-else class="btn ghost sm" @click="service(p, s.name, 'stop')">停止</button>
          <button class="btn ghost sm" :aria-expanded="openLog === `${p.id}/${s.name}`" @click="openLog = openLog === `${p.id}/${s.name}` ? null : `${p.id}/${s.name}`">输出</button>
        </div>
        <p class="muted small mono path">{{ s.command }}</p>
        <p v-if="s.description" class="muted small">{{ s.description }}</p>
        <pre v-if="openLog === `${p.id}/${s.name}`" class="log">{{ s.log.join("\n") || "（还没有输出）" }}</pre>
      </div>
      <div v-for="h in p.hooks ?? []" :key="`hook:${h.name}`" class="service stack">
        <div class="row wrap small">
          <span class="dot" :class="{ on: !!h.secret }" aria-hidden="true" />
          <strong>回调</strong>
          <span class="mono">{{ h.name }}</span>
          <span v-if="h.label" class="muted">{{ h.label }}</span>
          <span class="muted">{{ h.secret ? `地址生成于 ${when(h.secret.createdAt)}${h.secret.usedAt ? ` · 上次调用 ${when(h.secret.usedAt)}` : " · 还没被调用过"}` : "还没有地址" }}</span>
          <span class="spacer" />
          <button class="btn ghost sm" :disabled="!p.enabled" @click="makeSecret(p, h)">{{ h.secret ? "重新生成" : "生成地址" }}</button>
          <button v-if="h.secret" class="btn ghost sm" @click="revokeSecret(p, h)">撤销</button>
        </div>
        <div v-if="freshHook?.key === `${p.id}/${h.name}`" class="row wrap small hook-fresh">
          <code class="mono path grow">{{ freshHook.url }}</code>
          <button class="btn sm" @click="copyHook(freshHook.url)">复制</button>
        </div>
        <p class="muted small">
          {{ freshHook?.key === `${p.id}/${h.name}` ? "这个地址只显示这一次：填进外部平台的 webhook（POST），之后在这里只能重新生成。" : h.secret ? `地址形如 ${hookUrl(h.path)}<密钥>；密钥只在生成时显示。` : "生成地址后填进外部平台的 webhook，平台有变化时会叫醒 omem 去读，不用一直等轮询。" }}
          外部平台要能访问到这台 omem；每分钟最多 60 次，正文最大 1 MB。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-card { min-width: 0; overflow-wrap: anywhere; }
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--ink-2);
}
.path {
  overflow-wrap: anywhere;
}
.grow {
  flex: 1 1 260px;
  min-width: 0;
}
.perms {
  margin: 0;
  padding-left: 1.2em;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.service {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  gap: 4px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line-strong);
}
.dot.on {
  background: var(--ok);
}
.hook-fresh code {
  background: var(--sunken);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  min-width: 0;
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
.icons .grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.icons .btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
