<script setup lang="ts">
import { onMounted, ref } from "vue";
import { del, get, post, put } from "../api";
import { PLUGIN_ICONS } from "../lib/icons";
import { confirmDialog } from "../lib/dialog";
import { state, toast } from "../store";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";

/**
 * Settings → 插件 (docs/v2/plugins.md): what each plugin brings, trusting the code of plugins in the
 * data directory (and withdrawing it), and their services: running or not, start, stop, recent output.
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
};

const plugins = ref<Plugin[] | null>(null);
const services = ref<Record<string, Service[]>>({});
const openLog = ref<string | null>(null);
const picking = ref<string | null>(null);

const TRUST: Record<Plugin["trust"], string> = { builtin: "内置", none: "只有声明，不含代码", trusted: "已信任", required: "带代码，未信任", changed: "代码改过，需要重新确认" };

async function load() {
  plugins.value = await get<Plugin[]>("/api/plugins");
  for (const p of plugins.value) if (p.services.length) services.value[p.id] = await get<Service[]>(`/api/plugins/${p.id}/services`);
}

async function trust(p: Plugin) {
  const what = [p.services.length ? `服务：${p.services.map((s) => s.command).join("；")}` : "", `目录：${p.dir}`].filter(Boolean).join("\n");
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
    <p class="muted">插件带来自己的 Agent 档案、技能、工具和页面。内置插件随 omem 更新；放在数据目录 <span class="mono">plugins/</span> 里的是你自己的，带代码的要你确认后才运行。写法见 docs/v2/plugins.md。</p>
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
        <span class="spacer" />
        <button v-if="p.trust === 'required' || p.trust === 'changed'" class="btn sm primary" @click="trust(p)">信任并运行</button>
        <button v-if="p.trust === 'trusted'" class="btn ghost sm danger" @click="untrust(p)">撤销信任</button>
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
