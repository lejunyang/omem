<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, authUrl, get, onServerEvent } from "../api";
import PluginDefault from "../components/PluginDefault.vue";
import PluginSettings from "../components/PluginSettings.vue";
import Skeleton from "../components/Skeleton.vue";
import { state } from "../store";

/**
 * A plugin's page (docs/v2/plugins.md) in a sandboxed iframe without omem's origin. This view is
 * its only way out: requests under /api/plugins/<id>/ are forwarded, anything else is refused;
 * the theme, the route's query and this plugin's server events are passed in, and the page can
 * open the settings dialog. A plugin without a page of its own gets the default page.
 */
type PluginInfo = { id: string; name: string; description: string; agents: { name: string; description: string }[]; page: { title: string; own: boolean; built: boolean } | null; settings: boolean };

const route = useRoute();
const router = useRouter();
const id = String(route.params.id);
const info = ref<PluginInfo | null>(null);
const error = ref("");
const frame = ref<HTMLIFrameElement | null>(null);
const settingsOpen = ref(false);

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
async function onMessage(e: MessageEvent) {
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const m = e.data as { omem?: number; type?: string; id?: number; sid?: number; method?: string; path?: string; body?: unknown; to?: string };
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
  else if (m.type === "navigate" && typeof m.to === "string" && m.to.startsWith("/") && !m.to.startsWith("//")) void router.push(m.to);
  else if (m.type === "request") {
    const path = String(m.path ?? "");
    const method = m.method === "POST" ? "POST" : m.method === "DELETE" ? "DELETE" : "GET";
    if (!PATH.test(path) || path.split("/").includes("..")) return post({ type: "response", id: m.id, ok: false, error: `不允许的路径：${path}` });
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
});
</script>

<template>
  <div class="plugin-host">
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
iframe {
  flex: 1;
  width: 100%;
  border: 0;
  background: var(--bg);
}
</style>
