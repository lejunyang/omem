<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { del, get, post } from "../api";
import Icon from "../components/Icon.vue";
import RemoteChat from "../components/RemoteChat.vue";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect, { type SelectOption } from "../components/UiSelect.vue";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { relTime, toast } from "../store";

/**
 * Remote operation (docs/v2/remote.md): a browser page or the desktop of the machine omem runs on,
 * shown through aad's viewer, with a recording that the assistant beside it turns into a skill.
 */
type Session = { id: string; kind: "browser" | "desktop"; title: string; createdAt: string; browser: { name: string; url: string | null; profile: string | null } | null; recording: string | null; viewers: number; src?: string };
type Recording = { id: string; kind: "browser" | "desktop"; goal: string; target: string; status: "recording" | "done" | "failed"; summary: Record<string, any>; replay: { at: string; ok: boolean; error?: string; result?: any } | null; conversationId: string | null; skill: string | null; createdAt: string };
type Screens = { monitors: { monitor: number; name: string; primary?: boolean; width: number; height: number }[]; windows: { window: string; title: string }[]; recordable: { resourceId: string; name: string; process: string | null }[] };

const loading = ref(true);
const available = ref(false);
const version = ref<string | null>(null);
const sessions = ref<Session[]>([]);
const profiles = ref<string[]>([]);
const recordings = ref<Recording[]>([]);
const active = ref<Session | null>(null);
const busy = ref("");

// Opening
const kind = ref<"browser" | "desktop">("browser");
const url = ref("");
const profile = ref("");
const visible = ref(false);
const area = ref("all");
const screens = ref<Screens | null>(null);

// The address bar a browser session's viewer does not have.
const address = ref("");

// Recording
const goal = ref("");
const recordWindow = ref("");
const startedAt = ref(0);
const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
const conversationId = ref<string | null>(null);
const chat = ref<InstanceType<typeof RemoteChat>>();

const KEY = "omem.remote.conversation";
try {
  conversationId.value = localStorage.getItem(KEY);
} catch { /* private mode */ }
function setConversation(id: string | null) {
  conversationId.value = id;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch { /* private mode */ }
}

async function load() {
  try {
    const r = await get<{ available: boolean; version: string | null; sessions: Session[]; profiles: string[] }>("/api/remote");
    available.value = r.available;
    version.value = r.version;
    sessions.value = r.sessions;
    profiles.value = r.profiles;
    if (r.available) recordings.value = await get<Recording[]>("/api/remote/recordings");
    // Back on the page with a session still open: show it again (the viewer cookie comes with it).
    if (!active.value && r.sessions.length) await show(r.sessions[0]);
  } finally {
    loading.value = false;
  }
}
async function loadScreens() {
  if (screens.value) return;
  screens.value = await get<Screens>("/api/remote/screens").catch((e) => (toast((e as Error).message, "error"), null));
}
onMounted(() => {
  void load();
  timer = setInterval(() => (tick.value = Date.now()), 1000);
});
onBeforeUnmount(() => timer && clearInterval(timer));

async function show(s: Session) {
  active.value = { ...s, ...(await post<Session>(`/api/remote/sessions/${s.id}/view`)) };
  address.value = s.browser?.url ?? "";
  if (s.recording) startedAt.value = startedAt.value || Date.now();
  if (s.kind === "desktop") void loadScreens();
}

const profileOptions = computed<SelectOption<string>[]>(() => [
  { value: "", label: "临时资料（关掉就清空）" },
  ...profiles.value.map((p) => ({ value: p, label: p, hint: "保留登录" })),
  { value: "__new", label: "新建长期资料…" },
]);
async function pickProfile(v: string) {
  if (v !== "__new") return void (profile.value = v);
  const name = await promptDialog("新建浏览器资料", { message: "登录过的网站会留在这份资料里，下次选它不用再登录。", placeholder: "例如 后台" });
  profile.value = name?.trim() ?? "";
  if (profile.value && !profiles.value.includes(profile.value)) profiles.value.push(profile.value);
}
const areaOptions = computed<SelectOption<string>[]>(() => [
  { value: "all", label: "整个桌面" },
  ...(screens.value?.monitors ?? []).map((m) => ({ value: `m:${m.monitor}`, label: `显示器 ${m.monitor + 1}${m.primary ? "（主）" : ""}`, hint: `${m.width}×${m.height}`, group: "显示器" })),
  ...(screens.value?.windows ?? []).map((w) => ({ value: `w:${w.window}`, label: w.title || w.window, group: "窗口" })),
]);
const recordOptions = computed<SelectOption<string>[]>(() => (screens.value?.recordable ?? []).map((r) => ({ value: r.resourceId, label: r.name, hint: r.process ?? undefined })));

async function open() {
  busy.value = "open";
  try {
    const body = kind.value === "browser"
      ? { kind: "browser", url: url.value.trim() || undefined, profile: profile.value || undefined, visible: visible.value }
      : { kind: "desktop", ...(area.value.startsWith("m:") ? { monitor: Number(area.value.slice(2)) } : area.value.startsWith("w:") ? { window: area.value.slice(2) } : {}) };
    const s = await post<Session>("/api/remote/sessions", body);
    sessions.value = [...sessions.value, s];
    active.value = s;
    address.value = s.browser?.url ?? "";
    if (s.kind === "desktop") void loadScreens();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
async function go() {
  const s = active.value;
  let to = address.value.trim();
  if (!s || !to) return;
  if (!/^https?:\/\//.test(to)) to = `https://${to}`;
  busy.value = "go";
  try {
    const next = await post<Session>(`/api/remote/sessions/${s.id}/navigate`, { url: to });
    Object.assign(s, { title: next.title, browser: next.browser });
    sessions.value = sessions.value.map((x) => (x.id === s.id ? { ...x, title: next.title, browser: next.browser } : x));
    address.value = to;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
async function close(s: Session) {
  if (s.recording && !(await confirmDialog("关闭会话？", { message: "正在进行的录制会停下并保存，但不会交给助手整理。", okText: "关闭", danger: true }))) return;
  await del(`/api/remote/sessions/${s.id}`).catch((e) => toast((e as Error).message, "error"));
  sessions.value = sessions.value.filter((x) => x.id !== s.id);
  if (active.value?.id === s.id) active.value = null;
  void loadRecordings();
}
async function loadRecordings() {
  recordings.value = await get<Recording[]>("/api/remote/recordings").catch(() => recordings.value);
}

async function startRecording() {
  const s = active.value;
  if (!s) return;
  if (s.kind === "desktop" && !recordWindow.value) return void toast("先选要录的窗口：录制按窗口记下点了哪个元素", "error");
  busy.value = "record";
  try {
    const r = await post<Recording>(`/api/remote/sessions/${s.id}/recording`, { goal: goal.value.trim(), window: s.kind === "desktop" ? recordWindow.value : undefined, conversationId: conversationId.value ?? undefined });
    s.recording = r.id;
    startedAt.value = Date.now();
    recordings.value = [r, ...recordings.value];
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
async function stopRecording() {
  const s = active.value;
  if (!s) return;
  busy.value = "stop";
  try {
    const r = await del<{ recording: Recording; conversationId: string | null }>(`/api/remote/sessions/${s.id}/recording${conversationId.value ? `?conversationId=${encodeURIComponent(conversationId.value)}` : ""}`);
    s.recording = null;
    startedAt.value = 0;
    goal.value = "";
    if (r.conversationId) setConversation(r.conversationId);
    void chat.value?.load();
    await loadRecordings();
    toast(r.recording.status === "done" ? "录好了，已交给助手整理" : "录制没有完成", r.recording.status === "done" ? "ok" : "error");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
const elapsed = computed(() => {
  void tick.value;
  if (!startedAt.value) return "";
  const s = Math.floor((Date.now() - startedAt.value) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});

async function replay(r: Recording) {
  busy.value = `replay:${r.id}`;
  try {
    const next = await post<Recording>(`/api/remote/recordings/${r.id}/replay`, { sessionId: active.value?.id });
    recordings.value = recordings.value.map((x) => (x.id === r.id ? next : x));
    toast(next.replay?.ok ? "回放完成" : `回放失败：${next.replay?.error ?? ""}`, next.replay?.ok ? "ok" : "error");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
async function organize(r: Recording) {
  try {
    const out = await post<{ conversationId: string }>(`/api/remote/recordings/${r.id}/organize`, { conversationId: conversationId.value ?? undefined });
    setConversation(out.conversationId);
    void chat.value?.load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const counts = (r: Recording) => {
  const s = r.summary ?? {};
  if (r.status === "failed") return String(s.error ?? "没有完成");
  if (r.status === "recording") return "录制中";
  return [`${s.replayable ?? 0} 步可回放`, s.skipped ? `跳过 ${s.skipped}` : "", s.requests ? `${s.requests} 个请求` : ""].filter(Boolean).join(" · ");
};
</script>

<template>
  <div class="remote">
    <Skeleton v-if="loading" :rows="6" />
    <div v-else-if="!available" class="empty">
      <h1>远程操作</h1>
      <p class="muted">这台机器还没有装 ai-auto-desktop（aad）。到 设置 → Agent 里安装后，这里可以打开本机的浏览器页面或桌面，远程操作并录制成技能。</p>
      <router-link to="/settings" class="btn">去设置</router-link>
    </div>
    <template v-else>
      <section class="stage">
        <div class="bar row">
          <div v-if="sessions.length" class="tabs row">
            <button v-for="s in sessions" :key="s.id" class="btn sm" :class="{ primary: active?.id === s.id }" @click="show(s)">
              <Icon :name="s.kind === 'browser' ? 'globe' : 'monitor'" :size="14" />{{ s.title }}
            </button>
            <button class="btn ghost sm" :class="{ primary: !active }" @click="active = null"><Icon name="plus" :size="14" />新会话</button>
          </div>
          <span class="spacer" />
          <span class="muted small">aad {{ version }}</span>
        </div>

        <div v-if="!active" class="opener card stack">
          <h2>打开远程画面</h2>
          <UiSegmented v-model="kind" :options="[{ value: 'browser', label: '浏览器' }, { value: 'desktop', label: '桌面' }]" aria-label="打开什么" @change="kind === 'desktop' && loadScreens()" />
          <template v-if="kind === 'browser'">
            <label class="field">网址<input v-model="url" class="input" placeholder="https://…（可以先空着，打开后再在页面里输入）" @keydown.enter.prevent="open" /></label>
            <label class="field">浏览器资料<UiSelect :model-value="profile" :options="profileOptions" aria-label="浏览器资料" @update:model-value="pickProfile" /></label>
            <UiCheckbox v-model="visible">在这台机器上也显示浏览器窗口（默认只在这里看）</UiCheckbox>
          </template>
          <label v-else class="field">分享哪部分<UiSelect v-model="area" :options="areaOptions" aria-label="分享哪部分" :search-at="8" /></label>
          <div class="row"><button class="btn primary" :disabled="busy === 'open'" @click="open"><Icon name="play" :size="15" />{{ busy === "open" ? "正在打开…" : "打开" }}</button></div>
          <p class="muted small">画面在这台机器（omem 所在的电脑）上，你的鼠标键盘会转发过去。浏览器用单独的资料，不碰你平时的浏览器；30 分钟没人看会自动关闭。</p>
        </div>

        <template v-else>
          <form v-if="active.kind === 'browser'" class="address row" @submit.prevent="go">
            <Icon name="globe" :size="15" />
            <input v-model="address" class="input grow" placeholder="输入网址，回车前往" aria-label="网址" />
            <button class="btn sm" :disabled="busy === 'go'">{{ busy === "go" ? "前往中…" : "前往" }}</button>
          </form>
          <div class="viewer">
            <iframe :key="active.id" :src="active.src" :title="`远程画面：${active.title}`" allow="clipboard-read; clipboard-write" />
          </div>
          <div class="controls row">
            <template v-if="!active.recording">
              <input v-model="goal" class="input grow" placeholder="这次要教的事（一句话；也可以先在右边和助手说）" />
              <UiSelect v-if="active.kind === 'desktop'" v-model="recordWindow" :options="recordOptions" placeholder="录哪个窗口" aria-label="录哪个窗口" width="220px" :search-at="8" />
              <button class="btn accent" :disabled="busy === 'record'" @click="startRecording"><Icon name="camera" :size="15" />开始录制</button>
            </template>
            <template v-else>
              <span class="rec"><span class="dot" />录制中 {{ elapsed }}</span>
              <span class="muted small grow">在画面里把要教的事做一遍，做完点停止。</span>
              <button class="btn danger-fill" :disabled="busy === 'stop'" @click="stopRecording"><Icon name="stop" :size="15" />{{ busy === "stop" ? "正在整理…" : "停止" }}</button>
            </template>
            <button class="btn ghost sm" @click="close(active)"><Icon name="x" :size="14" />关闭会话</button>
          </div>
        </template>
      </section>

      <aside class="side">
        <div class="side-head row"><strong>助手</strong><span class="spacer" /><button v-if="conversationId" class="btn ghost sm" @click="setConversation(null)">新对话</button></div>
        <RemoteChat ref="chat" class="chat" :conversation-id="conversationId" @update:conversation-id="setConversation" />
        <div class="recs">
          <div class="side-head row"><strong>录制</strong></div>
          <div v-if="!recordings.length" class="muted small">还没有录制。</div>
          <div v-for="r in recordings.slice(0, 8)" :key="r.id" class="rec-row">
            <div class="grow">
              <div class="ellipsis" :title="r.goal">{{ r.goal || "（没写要做的事）" }}</div>
              <div class="muted small">{{ r.kind === "browser" ? "浏览器" : "桌面" }} · {{ relTime(r.createdAt) }} · {{ counts(r) }}<span v-if="r.skill"> · 技能 {{ r.skill }}</span></div>
              <div v-if="r.replay" class="small" :class="r.replay.ok ? 'ok' : 'bad'">{{ r.replay.ok ? "上次回放成功" : `上次回放失败：${r.replay.error ?? ""}` }} · {{ relTime(r.replay.at) }}</div>
            </div>
            <div v-if="r.status === 'done'" class="row acts">
              <button class="btn ghost sm" :disabled="!r.summary.workflow || !!busy" :title="r.summary.workflow ? '在当前会话里重放这次录制' : '没有可回放的步骤'" @click="replay(r)"><Icon name="play" :size="13" />{{ busy === `replay:${r.id}` ? "回放中…" : "回放" }}</button>
              <button class="btn ghost sm" title="交给助手整理成技能" @click="organize(r)"><Icon name="sparkles" :size="13" />整理</button>
            </div>
          </div>
        </div>
      </aside>
    </template>
  </div>
</template>

<style scoped>
.remote {
  display: flex;
  gap: 16px;
  padding: 16px;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
}
.empty {
  max-width: 640px;
  margin: 10vh auto 0;
  display: grid;
  gap: 12px;
  justify-items: start;
}
.empty h1 {
  font-family: var(--serif);
  font-size: 28px;
}
.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tabs {
  flex-wrap: wrap;
  gap: 6px;
}
.opener {
  max-width: 560px;
  width: 100%;
  margin: 6vh auto 0;
}
.opener h2 {
  font-family: var(--serif);
  font-size: 22px;
}
.address {
  gap: 8px;
  color: var(--muted);
}
.viewer {
  flex: 1;
  min-height: 320px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--sunken);
}
.viewer iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
.controls {
  gap: 8px;
  flex-wrap: wrap;
}
.grow {
  flex: 1;
  min-width: 0;
}
.rec {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--danger);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--danger);
  animation: blink 1.2s infinite;
}
@keyframes blink {
  50% {
    opacity: 0.3;
  }
}
.side {
  width: 360px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.side-head {
  gap: 8px;
}
.chat {
  flex: 1;
  min-height: 0;
}
.recs {
  max-height: 34%;
  overflow-y: auto;
  overflow-x: hidden;
  /* A long title must not widen the column past the panel. */
  grid-template-columns: minmax(0, 1fr);
  border-top: 1px solid var(--line);
  padding-top: 10px;
  display: grid;
  gap: 8px;
  align-content: start;
}
.rec-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  min-width: 0;
}
.rec-row .muted,
.rec-row .small {
  overflow-wrap: anywhere;
}
.acts {
  gap: 4px;
  flex: none;
}
.ok {
  color: var(--ok);
}
.bad {
  color: var(--danger);
}
@media (max-width: 960px) {
  .remote {
    flex-direction: column;
    height: auto;
  }
  .viewer {
    height: 62vh;
    flex: none;
  }
  .side {
    width: 100%;
  }
  .chat {
    height: 60vh;
    flex: none;
  }
  .controls > .grow {
    flex-basis: 100%;
  }
  .recs {
    max-height: none;
  }
}
</style>
