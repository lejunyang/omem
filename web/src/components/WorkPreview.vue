<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { del, get, post } from "../api";
import { relTime, toast } from "../store";
import Icon from "./Icon.vue";

/**
 * “预览” for a coding delegation (docs/v2/preview.md): run a repository's preview command in the
 * delegation's workspace and open its ports here on the same port numbers. Behind `omem peer open`
 * the local process forwards them; on omem's own machine they are local already.
 */
const props = defineProps<{ runId: string }>();

type Command = { name: string; command: string };
type Target = { space: string; spaceName: string; folder: string; kind: "work" | "applied"; branch: string | null; commands: Command[] };
type Port = { port: number; hosts: string[]; page: boolean | null; connections: number };
type Preview = { id: string; space: string; name: string; command: string; status: "starting" | "running" | "exited" | "stopped"; ports: Port[]; startedAt: string; endedAt: string | null; reason: string | null; log: string };
type Data = { local: boolean; targets: Target[]; previews: Preview[] };
type ForwardPort = { port: number; ok: boolean; error: string | null };
type Forwards = { forwarder: boolean; peer?: string; forwards?: { preview: string; ports: ForwardPort[] }[] };

const data = ref<Data | null>(null);
const fwd = ref<Forwards | null>(null);
const open = ref(false);
const busy = ref("");
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const live = (p: Preview) => p.status === "starting" || p.status === "running";
const active = computed(() => data.value?.previews.filter(live) ?? []);
/** The newest preview of each repository (running or ended): what its row shows. */
const latest = (space: string) => data.value?.previews.find((p) => p.space === space) ?? null;

async function load() {
  const n = ++seq;
  const runId = props.runId;
  const d = await get<Data>(`/api/runs/${runId}/previews`).catch(() => null);
  if (n !== seq || runId !== props.runId) return;
  data.value = d;
  if (!fwd.value) fwd.value = await get<Forwards>("/api/local/forwards").catch(() => ({ forwarder: false }));
  if (d && fwd.value?.forwarder) await syncForwards(d);
  schedule();
}

/** Keep the local forwards in step: every running preview's ports open, ended ones closed. */
async function syncForwards(d: Data) {
  const had = new Map((fwd.value?.forwards ?? []).map((f) => [f.preview, f]));
  let changed = false;
  for (const p of d.previews) {
    const want = p.status === "running" ? p.ports.map((x) => x.port) : [];
    const have = had.get(p.id);
    const same = have && want.length === have.ports.length && want.every((port) => have.ports.some((x) => x.port === port));
    if (!want.length && have) await del(`/api/local/forwards/${p.id}`).catch(() => null), (changed = true);
    else if (want.length && !same) await post("/api/local/forwards", { preview: p.id, ports: want }).catch(() => null), (changed = true);
  }
  if (changed) fwd.value = await get<Forwards>("/api/local/forwards").catch(() => fwd.value);
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const starting = active.value.some((p) => p.status === "starting" || !p.ports.length);
  if (!open.value && !active.value.length) return;
  timer = setTimeout(() => void load(), starting ? 2000 : 5000);
}

watch(() => props.runId, () => {
  data.value = null;
  void load();
}, { immediate: true });
watch(open, (v) => v && void load());
onBeforeUnmount(() => {
  seq++;
  if (timer) clearTimeout(timer);
});

async function start(t: Target, c: Command) {
  busy.value = `${t.space}:${c.name}`;
  try {
    await post("/api/previews", { run: props.runId, space: t.space, name: c.name });
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
async function stop(p: Preview) {
  busy.value = p.id;
  try {
    await del(`/api/previews/${p.id}`);
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}

/** Where this browser reaches a port: here directly, or through the local forward. */
const forwardOf = (p: Preview, port: number) => fwd.value?.forwards?.find((f) => f.preview === p.id)?.ports.find((x) => x.port === port) ?? null;
const reachable = (p: Preview, port: number) => !!data.value?.local || !!forwardOf(p, port)?.ok;
const STATUS: Record<Preview["status"], string> = { starting: "启动中", running: "运行中", exited: "已退出", stopped: "已停止" };
const logTail = (s: string) => s.split("\n").slice(-80).join("\n");

const root = ref<HTMLElement | null>(null);
const at = ref({ top: 0, left: 0, width: 480 });
const outside = (e: MouseEvent) => {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
};
const close = (e: Event) => {
  const t = e.target;
  if (!(t instanceof Node) || !root.value?.contains(t)) open.value = false;
};
watch(open, (v) => {
  if (v && root.value) {
    const r = root.value.getBoundingClientRect();
    const width = Math.min(480, innerWidth - 32);
    at.value = { top: r.bottom + 6, left: Math.max(16, Math.min(r.left, innerWidth - width - 16)), width };
  }
  for (const [ev, fn, capture] of [["mousedown", outside, false], ["scroll", close, true], ["resize", close, false]] as const)
    v ? window.addEventListener(ev, fn as EventListener, capture) : window.removeEventListener(ev, fn as EventListener, capture);
});
onBeforeUnmount(() => (open.value = false));
</script>

<template>
  <div v-if="data?.targets.length" ref="root" class="pv" @keydown.esc="open = false">
    <button class="btn sm" :aria-expanded="open" @click="open = !open">
      <Icon name="monitor" :size="14" />预览<span v-if="active.length" class="dot" :class="{ starting: active.some((p) => p.status === 'starting') }" aria-label="有预览在运行" />
    </button>
    <div v-if="open" class="menu card" role="dialog" aria-label="预览" :style="{ top: `${at.top}px`, left: `${at.left}px`, width: `${at.width}px` }">
      <section v-for="t in data.targets" :key="t.space" class="target">
        <div class="row head">
          <strong class="ellipsis">{{ t.spaceName }}</strong>
          <span class="badge">{{ t.kind === "applied" ? "接收位置" : "工作区" }}{{ t.branch ? ` · ${t.branch}` : "" }}</span>
        </div>
        <p v-if="!t.commands.length" class="muted small">
          这个仓库还没设预览命令。<router-link :to="`/settings?tab=spaces&space=${encodeURIComponent(t.space)}`" @click="open = false">去空间设置里填</router-link>
        </p>
        <template v-else>
          <div v-for="c in t.commands" :key="c.name" class="row cmd">
            <span class="name">{{ c.name }}</span>
            <code class="small mono ellipsis grow" :title="c.command">{{ c.command }}</code>
            <button class="btn sm" :disabled="!!busy" @click="start(t, c)">
              <Icon name="play" :size="13" />{{ latest(t.space) && live(latest(t.space)!) && latest(t.space)!.name === c.name ? "重新启动" : "启动" }}
            </button>
          </div>
        </template>
        <div v-if="latest(t.space)" class="run stack">
          <template v-for="p in [latest(t.space)!]" :key="p.id">
            <div class="row status">
              <span class="badge" :class="{ ok: p.status === 'running', warn: p.status === 'starting' }">{{ STATUS[p.status] }}</span>
              <span class="small">{{ p.name }}</span>
              <span class="muted small grow">{{ live(p) ? `${relTime(p.startedAt)}开始` : p.reason ?? "" }}</span>
              <button v-if="live(p)" class="btn ghost sm" :disabled="busy === p.id" @click="stop(p)"><Icon name="stop" :size="13" />停止</button>
            </div>
            <ul v-if="live(p) && p.ports.length" class="ports">
              <li v-for="x in p.ports" :key="x.port" class="row">
                <a v-if="reachable(p, x.port)" class="mono" :href="`http://localhost:${x.port}/`" target="_blank" rel="noopener">localhost:{{ x.port }}<Icon name="external" :size="12" /></a>
                <span v-else class="mono muted">localhost:{{ x.port }}</span>
                <span v-if="x.page" class="badge">网页</span>
                <span v-if="forwardOf(p, x.port)?.error" class="warn small">{{ forwardOf(p, x.port)!.error }}</span>
              </li>
            </ul>
            <p v-else-if="p.status === 'starting'" class="muted small">等它开始监听端口（大仓库可能要几分钟）。</p>
            <details class="log">
              <summary class="small">输出</summary>
              <pre class="mono small">{{ logTail(p.log) || "（还没有输出）" }}</pre>
            </details>
          </template>
        </div>
      </section>
      <p class="hint small">
        <template v-if="data.local">网页和这台 omem 在同一台机器，端口直接打开。</template>
        <template v-else-if="fwd?.forwarder">经本机的 omem peer open 转发：端口号和那台机器上一样，写死 localhost 端口的项目也能用。</template>
        <template v-else>要在你的电脑上看：在你电脑上运行 <code>omem peer open &lt;这台设备&gt;</code>，用它打开的 omem 点预览，端口会按原端口号转过来。</template>
        同一仓库同时只开一个预览，没人看一段时间后自动停。
      </p>
    </div>
  </div>
</template>

<style scoped>
.pv {
  position: relative;
  display: inline-flex;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  margin-left: 2px;
}
.dot.starting {
  background: var(--warn);
}
.menu {
  position: fixed;
  z-index: 40;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: min(70vh, 640px);
  overflow: auto;
}
.target {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.target + .target {
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
.head,
.cmd,
.status {
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.cmd .name {
  font-weight: 500;
  white-space: nowrap;
}
.cmd code {
  color: var(--muted);
}
.grow {
  flex: 1;
  min-width: 0;
}
.run {
  gap: 6px;
  min-width: 0;
}
.ports {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ports a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.log pre {
  margin: 4px 0 0;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--sunken);
  padding: 6px 8px;
  border-radius: 6px;
}
.warn {
  color: var(--warn);
}
.hint {
  color: var(--muted);
  margin: 0;
}
</style>
