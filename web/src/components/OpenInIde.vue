<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { authUrl, get, put } from "../api";
import { editor, editorOptions, ideUrl, sshAliases, type DesktopEditor } from "../lib/ide";
import Icon from "./Icon.vue";
import UiSelect from "./UiSelect.vue";

/**
 * “在 VS Code 中打开” for a coding run: its worktrees, or where the change was applied. Desktop
 * editors get a link (local or Remote-SSH); “网页版” opens omem's /ide, run by this machine's VS Code
 * CLI (detected, or the command set here).
 */
const props = defineProps<{ runId: string; spaceName: (id: string) => string }>();
type Folder = { space: string; path: string; kind: "work" | "applied"; branch: string | null };
type Info = { local: boolean; host: string; folders: Folder[] };
const info = ref<Info | null>(null);
const open = ref(false);
const settings = ref(false);

async function load() {
  info.value = null;
  info.value = await get<Info>(`/api/runs/${props.runId}/folders`).catch(() => null);
}
watch(() => props.runId, load, { immediate: true });

const options = editorOptions;
const chosen = editor;
const isWeb = computed(() => chosen.value === "web");

/** The VS Code CLI web VS Code runs on omem's machine: the one set here, or the one found there. */
const cli = ref<{ command: string | null; found: string | null } | null>(null);
const command = ref("");
async function loadCli() {
  cli.value = await get<{ command: string | null; found: string | null }>("/api/ide/cli").catch(() => null);
  command.value = cli.value?.command ?? "";
}
async function saveCommand() {
  const v = command.value.trim();
  if (v === (cli.value?.command ?? "")) return;
  await put("/api/settings", { ide: { web: { command: v || undefined } } });
  await loadCli();
}
const label = computed(() => editorOptions.find((o) => o.value === chosen.value)?.label ?? "VS Code");
const alias = computed({
  get: () => (info.value ? sshAliases.value[info.value.host] ?? "" : ""),
  set: (v: string) => {
    if (info.value) sshAliases.value = { ...sshAliases.value, [info.value.host]: v.trim() };
  },
});
/** Away from the machine without an SSH alias yet: the link cannot work, ask for it first. */
const needsAlias = computed(() => !isWeb.value && !!info.value && !info.value.local && !alias.value);
const href = (f: Folder) =>
  isWeb.value ? authUrl(`/api/ide/open?folder=${encodeURIComponent(f.path)}`) : ideUrl(chosen.value as DesktopEditor, f.path, info.value?.local ? undefined : alias.value);
const target = computed(() => (isWeb.value ? "_blank" : undefined));


function toggle() {
  if (needsAlias.value) settings.value = true;
  open.value = !open.value;
}
const root = ref<HTMLElement | null>(null);
/** Fixed under the buttons and kept on screen: the run column scrolls and clips. */
const at = ref({ top: 0, left: 0, width: 420 });
const outside = (e: MouseEvent) => {
  const t = e.target as Element;
  if (root.value && !root.value.contains(t) && !t.closest?.(".ui-select-pop")) open.value = false;
};
const close = (e: Event) => {
  const t = e.target;
  if (!(t instanceof Element) || !(root.value?.contains(t) || t.closest(".ui-select-pop"))) open.value = false;
};
watch(open, (v) => {
  if (v && root.value) {
    const r = root.value.getBoundingClientRect();
    const width = Math.min(420, innerWidth - 32);
    at.value = { top: r.bottom + 6, left: Math.max(16, Math.min(r.left, innerWidth - width - 16)), width };
  }
  for (const [ev, fn, capture] of [["mousedown", outside, false], ["scroll", close, true], ["resize", close, false]] as const)
    v ? window.addEventListener(ev, fn as EventListener, capture) : window.removeEventListener(ev, fn as EventListener, capture);
});
onBeforeUnmount(() => (open.value = false));
function gear() {
  open.value = !(open.value && settings.value);
  settings.value = true;
}
watch([open, isWeb], ([o, w]) => {
  if (o && w && !cli.value) void loadCli();
});
</script>

<template>
  <div v-if="info?.folders.length" ref="root" class="ide" @keydown.esc="open = false">
    <a v-if="info.folders.length === 1 && !needsAlias" class="btn sm" :href="href(info.folders[0])" :target="target" :title="info.folders[0].path"><Icon name="code" :size="14" />{{ isWeb ? "在网页版 VS Code 中打开" : `在 ${label} 中打开` }}</a>
    <button v-else class="btn sm" :aria-expanded="open" @click="toggle"><Icon name="code" :size="14" />{{ isWeb ? "在网页版 VS Code 中打开" : `在 ${label} 中打开` }}</button>
    <button class="btn ghost sm icon" :aria-expanded="open && settings" aria-label="打开方式" @click="gear"><Icon name="settings" :size="13" /></button>
    <div v-if="open" class="menu card" role="dialog" aria-label="在编辑器中打开" :style="{ top: `${at.top}px`, left: `${at.left}px`, width: `${at.width}px` }">
      <template v-if="!needsAlias">
        <a v-for="f in info.folders" :key="f.path" class="item" :href="href(f)" :target="target" @click="open = false">
          <strong>{{ spaceName(f.space) }}</strong>
          <span class="badge">{{ f.kind === "applied" ? "接收位置" : "工作区" }}{{ f.branch ? ` · ${f.branch}` : "" }}</span>
          <code class="small path">{{ f.path }}</code>
        </a>
      </template>
      <div v-if="settings || needsAlias" class="stack settings">
        <label class="field"><span>编辑器</span><UiSelect :model-value="chosen" size="sm" :options="options" aria-label="编辑器" @update:model-value="(v) => (editor = v)" /></label>
        <label v-if="!info.local && !isWeb" class="field">
          <span>这台机器（{{ info.host }}）在你电脑上的 SSH 主机名</span>
          <input v-model.lazy="alias" class="input mono" placeholder="~/.ssh/config 里的 Host，如 devbox" />
        </label>
        <template v-if="isWeb">
          <label class="field">
            <span>{{ info.host }} 上的 VS Code 命令行</span>
            <input v-model="command" class="input mono" placeholder="留空自动找 code-tunnel 或 code" @change="saveCommand" @keydown.enter="saveCommand" />
          </label>
          <span v-if="cli" class="hint" :class="{ warn: !cli.found }">{{ cli.found ? `用的是 ${cli.found}` : cli.command ? `找不到 ${cli.command}，改成完整路径` : "这台机器上没找到 code-tunnel 或 code：装上 VS Code 或它的独立命令行，或在上面填路径" }}</span>
          <span class="hint">在新标签页里打开这台机器上的工作区，不用本地装 VS Code 或配 SSH。用的是官方 code serve-web（第一次打开会先下载服务端），由 omem 代理和鉴权，只对你开放；它带终端，等于这台机器的命令行。</span>
        </template>
        <span v-else class="hint">{{ info.local ? "网页就在这台机器上，直接打开本地目录。" : "经 Remote-SSH 打开，要先能用 ssh 连上它；需要跳板的在 ~/.ssh/config 里配 ProxyJump。" }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ide {
  position: relative;
  display: inline-flex;
  gap: 2px;
}
.menu {
  position: fixed;
  z-index: 40;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  color: inherit;
  text-decoration: none;
  min-width: 0;
}
.item:hover {
  background: var(--hover);
}
.path {
  flex-basis: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.settings {
  padding: 6px 8px;
  border-top: 1px solid var(--line);
}
.warn {
  color: var(--warn);
}
</style>
