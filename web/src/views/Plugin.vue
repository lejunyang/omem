<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, authUrl, get, onServerEvent } from "../api";
import Icon from "../components/Icon.vue";
import PluginDefault from "../components/PluginDefault.vue";
import PluginSettings from "../components/PluginSettings.vue";
import Skeleton from "../components/Skeleton.vue";
import { startVoice, type VoiceHandle, type VoiceState, type VoiceTurn } from "../lib/voice";
import { state } from "../store";

/**
 * A plugin's page (docs/v2/plugins.md) in a sandboxed iframe without omem's origin. This view is
 * its only way out: requests under /api/plugins/<id>/ are forwarded, anything else is refused;
 * the theme, the route's query and this plugin's server events are passed in, and the page can
 * open the settings dialog. A plugin without a page of its own gets the default page.
 */
type PluginInfo = { id: string; name: string; description: string; agents: { name: string; description: string }[]; page: { title: string; own: boolean; built: boolean } | null; settings: boolean; voice?: boolean; connectors?: { provider: string; features: string[] }[] };

const route = useRoute();
const router = useRouter();
const id = String(route.params.id);
const info = ref<PluginInfo | null>(null);
const error = ref("");
const frame = ref<HTMLIFrameElement | null>(null);
const settingsOpen = ref(false);
// Platforms its tools act on as you (manifest `connectors`) that you have not connected, or not with every feature it needs.
const missing = ref<{ provider: string; label: string }[]>([]);
async function checkConnectors() {
  const wanted = info.value?.connectors ?? [];
  if (!wanted.length) return;
  const r = await get<{ connections: { provider: string; status: string; features: { id: string; on: boolean }[] }[]; available: { id: string; label: string }[] }>("/api/auth/connections").catch(() => null);
  if (!r) return;
  missing.value = wanted
    .filter((w) => {
      const c = r.connections.find((x) => x.provider === w.provider);
      return !c || c.status !== "active" || w.features.some((f) => !c.features.find((x) => x.id === f)?.on);
    })
    .map((w) => ({ provider: w.provider, label: r.available.find((a) => a.id === w.provider)?.label ?? w.provider }));
}

const TOKENS = ["--bg", "--panel", "--sunken", "--hover", "--line", "--line-strong", "--ink", "--ink-2", "--muted", "--accent", "--accent-ink", "--accent-soft", "--ok", "--ok-soft", "--warn", "--warn-soft", "--danger", "--danger-soft", "--mark", "--shadow", "--shadow-lg", "--radius", "--radius-sm", "--sans", "--serif", "--mono"];
function theme() {
  const css = getComputedStyle(document.documentElement);
  const vars = Object.fromEntries(TOKENS.map((t) => [t, css.getPropertyValue(t).trim()]));
  return { vars, scheme: css.colorScheme.includes("dark") ? "dark" : "light" };
}
const post = (m: Record<string, unknown>) => frame.value?.contentWindow?.postMessage({ omem: 1, ...m }, "*");

const PATH = /^[a-z0-9][a-z0-9_\-/]*(\?[a-zA-Z0-9_\-=&%.:]*)?$/;

// The page's streams: the shell opens the WebSocket (it may carry the owner's token) and relays frames.
const sockets = new Map<number, WebSocket>();
function streamEvent(sid: number, event: string, extra: Record<string, unknown> = {}, transfer?: Transferable[]) {
  frame.value?.contentWindow?.postMessage({ omem: 1, type: "stream-event", sid, event, ...extra }, "*", transfer ?? []);
}
function openStream(sid: number, name: string) {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(name) || sockets.has(sid)) return streamEvent(sid, "close", { reason: `不允许的流：${name}` });
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${authUrl(`/api/plugins/${id}/streams/${name}`)}`);
  ws.binaryType = "arraybuffer";
  sockets.set(sid, ws);
  ws.onopen = () => streamEvent(sid, "open");
  ws.onmessage = (e) => (e.data instanceof ArrayBuffer ? streamEvent(sid, "message", { data: e.data }, [e.data]) : streamEvent(sid, "message", { data: String(e.data) }));
  ws.onclose = (e) => {
    sockets.delete(sid);
    streamEvent(sid, "close", { reason: e.reason || (e.code === 1000 ? "" : `连接断开（${e.code}）`) });
  };
}
/*
 * The page's voice conversation (lib/voice.ts, docs/v2/plugins.md “语音”). The microphone, the WebRTC
 * connection and the model's voice stay here, in omem's own origin: the sandboxed page never gets a
 * microphone or the client secret, only the transcript. One at a time; started only right after a
 * click in the page (the click's activation reaches this window too), and shown here with its own
 * “结束” while it runs.
 */
type Live = { vid: number; handle: VoiceHandle | null; turns: VoiceTurn[]; startedAt: string; done: boolean };
let live: Live | null = null;
const voiceBar = shallowRef<{ state: VoiceState; muted: boolean } | null>(null);
const voiceEvent = (vid: number, event: string, extra: Record<string, unknown> = {}) => post({ type: "voice-event", vid, event, ...extra });
function finishVoice(l: Live) {
  if (l.done) return;
  l.done = true;
  l.handle?.stop();
  const record = {
    transcript: l.turns.filter((t) => t.text.trim()).map((t) => ({ role: t.role, text: t.text })),
    startedAt: l.startedAt,
    endedAt: new Date().toISOString(),
    api: l.handle?.api ?? "",
    model: l.handle?.model ?? "",
  };
  voiceEvent(l.vid, "ended", { record });
  if (live === l) {
    live = null;
    voiceBar.value = null;
  }
}
async function startPageVoice(vid: number, instructions: unknown) {
  if (!info.value?.voice) return voiceEvent(vid, "error", { error: "这个插件没有声明语音（清单 voice: true）" });
  if (live) return voiceEvent(vid, "error", { error: "已经有一段语音对话在进行" });
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (activation && !activation.isActive) return voiceEvent(vid, "error", { code: "gesture", error: "点一下按钮再开始：语音只在你点了之后打开" });
  if (typeof instructions !== "string" || !instructions.trim()) return voiceEvent(vid, "error", { error: "没有给语音模型的说明" });
  const l: Live = { vid, handle: null, turns: [], startedAt: new Date().toISOString(), done: false };
  live = l;
  voiceBar.value = { state: "connecting", muted: false };
  try {
    l.handle = await startVoice({
      plugin: { id, instructions },
      onTurns: (turns) => {
        l.turns = turns;
        voiceEvent(vid, "turns", { turns });
      },
      onState: (s, detail) => {
        if (live === l) voiceBar.value = { state: s, muted: voiceBar.value?.muted ?? false };
        voiceEvent(vid, "state", { state: s, detail });
        if ((s === "ended" || s === "failed") && l.handle) finishVoice(l);
      },
    });
    l.startedAt = l.handle.startedAt;
    if (l.done) return;
    voiceEvent(vid, "started", { api: l.handle.api, model: l.handle.model });
  } catch (err) {
    l.done = true;
    if (live === l) {
      live = null;
      voiceBar.value = null;
    }
    voiceEvent(vid, "error", { error: (err as Error).message });
  }
}
function muteVoice(on: boolean) {
  if (!live?.handle || !voiceBar.value) return;
  live.handle.mute(on);
  voiceBar.value = { ...voiceBar.value, muted: on };
}

async function onMessage(e: MessageEvent) {
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const m = e.data as { omem?: number; type?: string; id?: number; sid?: number; vid?: number; method?: string; path?: string; body?: unknown; to?: string };
  if (!m || m.omem !== 1) return;
  if (m.type === "ready") post({ type: "init", plugin: id, params: Object.fromEntries(Object.entries(route.query).filter(([, v]) => typeof v === "string")), ...theme() });
  else if (m.type === "settings") settingsOpen.value = !!info.value?.settings;
  else if (m.type === "stream-open") openStream(Number(m.sid), String((m as { name?: unknown }).name ?? ""));
  else if (m.type === "stream-send") {
    const ws = sockets.get(Number(m.sid));
    const data = (m as { data?: unknown }).data;
    if (ws?.readyState === WebSocket.OPEN && (typeof data === "string" || data instanceof ArrayBuffer)) ws.send(data);
  } else if (m.type === "stream-close") {
    sockets.get(Number(m.sid))?.close();
    sockets.delete(Number(m.sid));
  }
  else if (m.type === "voice-start") void startPageVoice(Number(m.vid), (m as { instructions?: unknown }).instructions);
  else if (m.type === "voice-stop") {
    if (live?.vid === Number(m.vid)) finishVoice(live);
  } else if (m.type === "voice-mute") {
    if (live?.vid === Number(m.vid)) muteVoice(!!(m as { on?: unknown }).on);
  }
  else if (m.type === "navigate" && typeof m.to === "string" && m.to.startsWith("/") && !m.to.startsWith("//")) void router.push(m.to);
  else if (m.type === "request") {
    const path = String(m.path ?? "");
    const method = m.method === "POST" ? "POST" : m.method === "DELETE" ? "DELETE" : "GET";
    // voice/… hands out the voice model's session (a client secret): only for the shell itself.
    if (!PATH.test(path) || path.split("/").includes("..") || /^voice\//.test(path)) return post({ type: "response", id: m.id, ok: false, error: `不允许的路径：${path}` });
    try {
      const data = await api(`/api/plugins/${id}/${path}`, method === "POST" ? { method, json: m.body ?? {} } : { method });
      post({ type: "response", id: m.id, ok: true, data });
    } catch (err) {
      post({ type: "response", id: m.id, ok: false, error: (err as Error).message });
    }
  }
}

let off: (() => void) | null = null;
const dark = window.matchMedia?.("(prefers-color-scheme: dark)");
const resend = () => setTimeout(() => post({ type: "theme", ...theme() }));
onMounted(async () => {
  window.addEventListener("message", onMessage);
  dark?.addEventListener("change", resend);
  off = onServerEvent((e) => {
    if ((e.type === "plugin" && e.plugin === id) || e.type === "run") post({ type: "event", event: e });
  });
  try {
    info.value = await get<PluginInfo>(`/api/plugins/${id}`);
    void checkConnectors();
  } catch (e) {
    error.value = (e as Error).message;
  }
});
watch(() => state.theme, resend);
onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
  dark?.removeEventListener("change", resend);
  off?.();
  for (const ws of sockets.values()) ws.close();
  sockets.clear();
  if (live) finishVoice(live);
});
</script>

<template>
  <div class="plugin-host">
    <div v-if="info && missing.length" class="connect-bar small">
      {{ info.name }}要以你的身份用 {{ missing.map((m) => m.label).join("、") }}，还没有连接或缺少权限。
      <router-link to="/account">去账号页连接</router-link>
    </div>
    <div v-if="voiceBar && info" class="voice-bar small" role="status">
      <span class="dot" :class="voiceBar.state" aria-hidden="true" />
      <span class="grow">{{ info.page?.title ?? info.name }}{{ voiceBar.state === "connecting" ? "正在连接语音模型…" : voiceBar.muted ? "：麦克风已静音" : "正在使用麦克风" }}</span>
      <button v-if="voiceBar.state === 'live'" type="button" class="btn ghost sm" :aria-pressed="voiceBar.muted" @click="muteVoice(!voiceBar.muted)"><Icon name="mic" :size="14" />{{ voiceBar.muted ? "取消静音" : "静音" }}</button>
      <button type="button" class="btn sm" @click="live && finishVoice(live)"><Icon name="stop" :size="13" />结束</button>
    </div>
    <div v-if="error" class="page"><div class="card pad err">{{ error }}</div></div>
    <div v-else-if="!info" class="page"><Skeleton variant="text" :rows="6" /></div>
    <div v-else-if="!info.page" class="page"><div class="card pad">插件 {{ info.name }} 没有页面。</div></div>
    <PluginDefault v-else-if="!info.page.own" :info="info" @settings="settingsOpen = true" />
    <div v-else-if="!info.page.built" class="page">
      <div class="card pad">插件 {{ info.name }} 的页面还没有构建：在 omem 目录运行 <code>pnpm run build</code>（开发时 <code>pnpm run dev</code> 会自动构建）。</div>
    </div>
    <iframe
      v-else
      ref="frame"
      :src="`/plugins/${id}/`"
      :title="info.page.title"
      sandbox="allow-scripts allow-forms allow-popups"
      allow="autoplay"
    />
    <PluginSettings
      v-if="settingsOpen && info"
      :plugin="id"
      :title="info.page?.title ?? info.name"
      @close="settingsOpen = false"
      @saved="post({ type: 'event', event: { type: 'plugin', plugin: id, conversationId: '', settings: true } })"
    />
  </div>
</template>

<style scoped>
.plugin-host {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.connect-bar {
  padding: 8px 16px;
  background: var(--warn-soft);
  color: var(--ink);
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.voice-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.voice-bar .grow {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.voice-bar .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}
.voice-bar .dot.live {
  background: var(--danger);
  box-shadow: 0 0 0 4px var(--danger-soft);
}
.voice-bar .dot.connecting {
  background: var(--warn);
}
iframe {
  flex: 1;
  width: 100%;
  border: 0;
  background: var(--bg);
}
</style>
