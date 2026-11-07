<script setup lang="ts">
import { onMounted, ref } from "vue";
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
 */
type Service = { name: string; description: string; command: string; running: boolean; startedAt: string | null; streams: number; log: string[] };
type Plugin = {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "data";
  dir: string | null;
  icon: string;
  iconChosen: boolean;
  trust: "builtin" | "none" | "trusted" | "required" | "changed";
  agents: { name: string }[];
  tools: string[];
  page: { title: string } | null;
  services: { name: string; description: string; command: string }[];
  streams: { name: string; service: string }[];
  enabled: boolean;
  version: string | null;
  installed: { source: string; version: string; installedAt: string } | null;
  permissions: { tools: { name: string; write: boolean; approval: boolean }[]; writes: boolean; hostTools: string[]; providers: string[]; platforms: string[]; uses: string[]; services: string[]; space: string | null };
};

const plugins = ref<Plugin[] | null>(null);
const services = ref<Record<string, Service[]>>({});
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
    m.uses.length ? `以你的身份调用：${m.uses.join("、")}` : "",
    m.services.length ? `在这台机器上运行：${m.services.join("；")}` : "",
    m.space ? `用自己的空间 ${m.space}` : "",
  ].filter(Boolean);
}
const sourceLabel = (p: Plugin) => (p.source === "builtin" ? "内置" : p.installed ? p.installed.source : "数据目录里的");

async function install() {
  if (!source.value.trim()) return;
  busy.value = true;
  try {
    const r = await post<{ id: string; version: string; replaced: boolean }>("/api/plugins/install", { source: source.value.trim() });
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
    const r = await post<{ version: string }>(`/api/plugins/${p.id}/update`, { source: next || undefined });
    toast(`已更新到 ${r.version || "最新"}；代码变了，要重新信任`, "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
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

const TRUST: Record<Plugin["trust"], string> = { builtin: "内置", none: "只有声明，不含代码", trusted: "已信任", required: "带代码，未信任", changed: "代码改过，需要重新确认" };

async function load() {
  plugins.value = await get<Plugin[]>("/api/plugins");
  for (const p of plugins.value) if (p.services.length) services.value[p.id] = await get<Service[]>(`/api/plugins/${p.id}/services`);
}

async function trust(p: Plugin) {
  const what = [...permissionLines(p), p.installed ? `来源：${p.installed.source}` : "", `目录：${p.dir}`].filter(Boolean).join("\n");
  const ok = await confirmDialog(`信任插件“${p.name}”？`, {
    message: `它的代码（server 文件、服务）会以你的身份在这台机器上运行，能读写你能读写的文件。只信任你自己写的或看过代码的插件。代码以后有改动，要在这里重新确认。\n\n${what}`,
    okText: "信任并运行",
  });
  if (!ok) return;
  try {
    await post(`/api/plugins/${p.id}/trust`);
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

onMounted(() => void load().catch((e) => toast((e as Error).message, "error")));
</script>

<template>
  <div class="stack">
    <p class="muted">插件带来自己的 Agent 档案、技能、工具和页面。内置插件随 omem 更新；放在数据目录 <span class="mono">plugins/</span> 里的是你自己的；装进来的和你自己的，带代码的都要你看过权限、确认后才运行。写法见 docs/v2/plugins.md。</p>
    <div class="card pad stack">
      <strong>安装插件</strong>
      <div class="row wrap">
        <input v-model="source" class="input grow" placeholder="npm:omem-plugin-示例@1.0.0 或 github:owner/repo#v1.0.0" aria-label="插件来源" @keydown.enter="install" />
        <button class="btn sm primary" :disabled="busy || !source.trim()" @click="install">{{ busy ? "安装中…" : "安装" }}</button>
      </div>
      <p class="muted small">不运行包里的安装脚本；GitHub 来源要写 tag 或提交，分支会在信任之后变。</p>
    </div>
    <Skeleton v-if="!plugins" variant="text" :rows="4" />
    <p v-else-if="!plugins.length" class="muted">还没有插件。</p>
    <div v-for="p in plugins ?? []" :key="p.id" class="card pad stack">
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
        <span class="badge" :class="{ warn: p.trust === 'required' || p.trust === 'changed', ok: p.trust === 'trusted' }">{{ TRUST[p.trust] }}</span>
        <span class="muted small">{{ sourceLabel(p) }}{{ p.version ? ` · ${p.version}` : "" }}</span>
        <span class="spacer" />
        <UiCheckbox :model-value="p.enabled" switch size="sm" :aria-label="`启用${p.name}`" @change="(v) => setEnabled(p, v)">启用</UiCheckbox>
        <button v-if="p.trust === 'required' || p.trust === 'changed'" class="btn sm primary" @click="trust(p)">信任并运行</button>
        <button v-if="p.trust === 'trusted'" class="btn ghost sm danger" @click="untrust(p)">撤销信任</button>
        <button v-if="p.installed" class="btn ghost sm" :disabled="busy" @click="update(p)">更新</button>
        <button v-if="p.installed" class="btn ghost sm danger" @click="remove(p)">删除</button>
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
        <span v-if="p.tools.length">工具：<span class="mono">{{ p.tools.join("、") }}</span></span>
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
    </div>
  </div>
</template>

<style scoped>
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
