<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { del, get, post, put } from "../api";
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
type Session = { id: string; kind: "browser" | "desktop"; title: string; createdAt: string; browser: { name: string; url: string | null; profile: string | null } | null; window: string | null; recording: string | null; viewers: number; src?: string };
type BrowserProfile = { browser: "chrome" | "edge" | "brave"; id: string; name: string };
type Recording = { id: string; kind: "browser" | "desktop"; goal: string; target: string; status: "recording" | "done" | "failed"; summary: Record<string, any>; replay: { at: string; ok: boolean; error?: string; result?: any } | null; conversationId: string | null; skill: string | null; createdAt: string };
type Settings = { format: string; quality: number; fps: number; maxWidth: number; cursor: boolean; clipboard: boolean; browser: "" | "chrome" | "edge" | "brave" };
type VideoProbe = { at: string; ffmpeg: string | null; encoders: Record<string, string> };
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
const browserProfiles = ref<BrowserProfile[] | null>(null);
const closeRunning = ref(false);
const visible = ref(false);
const area = ref("all");
const screens = ref<Screens | null>(null);

// How the picture is sent (aad assist's options), each user's own.
const showSettings = ref(false);
const settings = ref<Settings | null>(null);
const saved = ref("");
const video = ref<VideoProbe | null>(null);
const probing = ref(false);

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
async function loadScreens(again = false) {
  if (screens.value && !again) return;
  const next = await get<Screens>("/api/remote/screens").catch((e) => (toast((e as Error).message, "error"), null));
  if (next) screens.value = next;
}
async function loadBrowserProfiles() {
  if (browserProfiles.value) return;
  browserProfiles.value = await get<BrowserProfile[]>("/api/remote/browser-profiles").catch(() => []);
}
onMounted(() => {
  void load();
  timer = setInterval(() => (tick.value = Date.now()), 1000);
  void loadBrowserProfiles();
});
onBeforeUnmount(() => timer && clearInterval(timer));

async function show(s: Session) {
  active.value = { ...s, ...(await post<Session>(`/api/remote/sessions/${s.id}/view`)) };
  address.value = s.browser?.url ?? "";
  if (s.recording) startedAt.value = startedAt.value || Date.now();
  if (s.kind === "desktop") void loadScreens(true);
}

const BROWSER_NAMES: Record<string, string> = { chrome: "Chrome", edge: "Edge", brave: "Brave" };
const profileOptions = computed<SelectOption<string>[]>(() => [
  { value: "", label: "临时资料", hint: "关掉就清空" },
  ...profiles.value.map((p) => ({ value: p, label: p, hint: "保留登录", group: "omem 的长期资料" })),
  { value: "__new", label: "新建长期资料…", group: "omem 的长期资料" },
  ...(browserProfiles.value ?? []).map((p) => ({ value: `copy:${p.browser}:${p.id}`, label: p.name, hint: `${BROWSER_NAMES[p.browser]} · ${p.id}`, group: "复制这台机器上浏览器的登录" })),
]);
// A profile of this machine's own browser, copied: its logins come along.
const copying = computed(() => {
  const m = /^copy:(chrome|edge|brave):(.+)$/.exec(profile.value);
  return m ? { browser: m[1] as BrowserProfile["browser"], id: m[2] } : null;
});
async function pickProfile(v: string) {
  closeRunning.value = false;
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
async function toggleSettings() {
  showSettings.value = !showSettings.value;
  if (!showSettings.value || settings.value) return;
  try {
    const r = await get<{ settings: Settings; video: VideoProbe | null; probing: boolean }>("/api/remote/settings");
    settings.value = r.settings;
    saved.value = JSON.stringify(r.settings);
    video.value = r.video;
    // Which video codecs work here decides what the format list offers: check once.
    if (!r.video) void probe();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function probe() {
  probing.value = true;
  try {
    video.value = await post<VideoProbe>("/api/remote/settings/probe");
  } catch (e) {
    toast(`没能检测视频编码：${(e as Error).message}`, "error");
  } finally {
    probing.value = false;
  }
}
const VIDEO_NAMES: Record<string, string> = { h264: "H.264", vp9: "VP9", av1: "AV1" };
const formatOptions = computed<SelectOption<string>[]>(() => [
  { value: "auto", label: "自动（推荐）", hint: video.value && Object.keys(video.value.encoders).length ? "只传变化的部分，大片变化时换成视频" : "只传变化的部分" },
  { value: "tiles", label: "只传变化的部分", hint: "清晰，不用视频" },
  ...Object.entries(VIDEO_NAMES).map(([value, name]) => {
    const encoder = video.value?.encoders[value];
    return { value, label: `视频 ${name}`, hint: encoder ?? (probing.value ? "检测中…" : video.value ? "这台机器不能用" : "未检测"), disabled: !encoder, group: "视频（流畅，画面会糊一点）" };
  }),
  { value: "webp", label: "整张图片 WebP", hint: "每次发整个画面", group: "整张图片" },
  { value: "jpeg", label: "整张图片 JPEG", hint: "编码最快，画面稍糊", group: "整张图片" },
]);
const videoNote = computed(() => {
  const found = Object.entries(video.value?.encoders ?? {});
  return {
    text: found.length ? found.map(([c]) => VIDEO_NAMES[c]).join("、") : video.value?.ffmpeg ? "没有" : "没有（没装 ffmpeg，只用图片）",
    title: found.map(([c, e]) => `${VIDEO_NAMES[c]}：${e}`).join("\n"),
  };
});
const qualityOptions = [
  { value: 40, label: "省流量" },
  { value: 70, label: "标准" },
  { value: 85, label: "清晰" },
  { value: 100, label: "无损", title: "只传变化的部分时无损；视频和整张图片按最高质量" },
];
const fpsOptions: SelectOption<number>[] = [{ value: 0, label: "自动", hint: "整张图片 5、其余 30" }, ...[10, 15, 30, 60].map((n) => ({ value: n, label: `每秒 ${n} 帧` }))];
const widthOptions: SelectOption<number>[] = [1280, 1600, 1920, 2560].map((n) => ({ value: n, label: `${n} 像素`, hint: n === 1600 ? "默认" : undefined })).concat([{ value: 0, label: "不缩小", hint: undefined }]);
const browserOptions: SelectOption<string>[] = [{ value: "", label: "自动", hint: "按 Chrome、Edge、Brave 找第一个" }, { value: "chrome", label: "Chrome" }, { value: "edge", label: "Edge" }, { value: "brave", label: "Brave" }];
const settingsChanged = computed(() => !!settings.value && JSON.stringify(settings.value) !== saved.value);
async function saveSettings() {
  if (!settings.value) return;
  busy.value = "settings";
  try {
    settings.value = await put<Settings>("/api/remote/settings", settings.value);
    saved.value = JSON.stringify(settings.value);
    const s = active.value;
    if (s) {
      // The open session gets a new viewer with these settings; the page and a recording carry on.
      const next = await post<Session>(`/api/remote/sessions/${s.id}/viewer`);
      active.value = { ...s, ...next };
      toast("已保存，当前画面换成了新设置", "ok");
    } else toast("已保存，之后打开的画面按这个来", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}

const recordOptions = computed<SelectOption<string>[]>(() => (screens.value?.recordable ?? []).map((r) => ({ value: r.resourceId, label: r.name, hint: r.process ?? undefined })));
// Sharing a whole screen, a recording needs the program to watch; sharing one window, it watches that.
const pickProgram = computed(() => active.value?.kind === "desktop" && !active.value.window);

async function open() {
  busy.value = "open";
  try {
    const shared = area.value.startsWith("w:") ? screens.value?.windows.find((w) => w.window === area.value.slice(2)) : undefined;
    const body = kind.value === "browser"
      ? { kind: "browser", url: url.value.trim() || undefined, ...(copying.value ? { copyFrom: copying.value, closeRunning: closeRunning.value } : { profile: profile.value || undefined }), visible: visible.value }
      : { kind: "desktop", ...(area.value.startsWith("m:") ? { monitor: Number(area.value.slice(2)) } : shared ? { window: shared.window, title: shared.title } : {}) };
    const s = await post<Session>("/api/remote/sessions", body);
    sessions.value = [...sessions.value, s];
    active.value = s;
    address.value = s.browser?.url ?? "";
    if (s.kind === "desktop") void loadScreens(true);
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
  if (pickProgram.value && !recordWindow.value) return void toast("先选录哪个程序：录制一次看一个程序，记下在它里面点了什么", "error");
  busy.value = "record";
  try {
    const r = await post<Recording>(`/api/remote/sessions/${s.id}/recording`, { goal: goal.value.trim(), window: pickProgram.value ? recordWindow.value : undefined, conversationId: conversationId.value ?? undefined });
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
        <div class="bar">
          <div v-if="sessions.length" class="stabs" role="tablist" aria-label="远程会话">
            <div
              v-for="s in sessions"
              :key="s.id"
              class="stab"
              :class="{ on: active?.id === s.id }"
              role="tab"
              tabindex="0"
              :aria-selected="active?.id === s.id"
              :title="s.browser?.url || s.title"
              @click="show(s)"
              @keydown.enter.self="show(s)"
              @auxclick.middle="close(s)"
            >
              <Icon :name="s.kind === 'browser' ? 'globe' : 'monitor'" :size="14" />
              <span class="ellipsis">{{ s.title }}</span>
              <span v-if="s.recording" class="dot" title="录制中" />
              <button class="x" :aria-label="`关闭 ${s.title}`" title="关闭会话" @click.stop="close(s)"><Icon name="x" :size="13" /></button>
            </div>
            <button class="stab add" :class="{ on: !active }" role="tab" :aria-selected="!active" title="打开新的远程画面" @click="active = null">
              <Icon name="plus" :size="14" /><span v-if="!sessions.length || !active">新会话</span>
            </button>
          </div>
          <span v-else class="spacer" />
          <div class="tools">
            <span class="muted small nowrap">aad {{ version }}</span>
            <button class="btn sm" :class="showSettings ? 'primary' : 'ghost'" :aria-expanded="showSettings" @click="toggleSettings"><Icon name="settings" :size="14" />画面设置</button>
          </div>
        </div>

        <div v-if="showSettings" class="settings card pad">
          <Skeleton v-if="!settings" :rows="3" />
          <template v-else>
            <div class="grid">
              <label class="field"><span>格式</span><UiSelect v-model="settings.format" :options="formatOptions" aria-label="画面格式" /></label>
              <div class="field"><span>画质</span><UiSegmented v-model="settings.quality" :options="qualityOptions" size="sm" aria-label="画质" /></div>
              <label class="field"><span>最高帧率</span><UiSelect v-model="settings.fps" :options="fpsOptions" aria-label="最高帧率" /></label>
              <label class="field"><span>最大宽度</span><UiSelect v-model="settings.maxWidth" :options="widthOptions" aria-label="最大宽度" /></label>
              <label class="field"><span>新开浏览器用</span><UiSelect v-model="settings.browser" :options="browserOptions" aria-label="浏览器" /></label>
            </div>
            <div class="checks">
              <UiCheckbox v-model="settings.cursor" size="sm">桌面画面上显示远程的鼠标指针</UiCheckbox>
              <UiCheckbox v-model="settings.clipboard" size="sm">在画面里复制的文字带回这边的剪贴板</UiCheckbox>
            </div>
            <div class="row foot">
              <span class="muted small grow">
                <template v-if="probing">正在检测这台机器能用的视频编码（可能要半分钟）…</template>
                <template v-else-if="video"><span :title="videoNote.title">能用的视频编码：{{ videoNote.text }}</span> · <a href="#" class="nowrap" @click.prevent="probe">重新检测</a></template>
              </span>
              <button class="btn ghost sm" @click="showSettings = false">收起</button>
              <button class="btn primary sm" :disabled="!settingsChanged || busy === 'settings'" @click="saveSettings">{{ busy === "settings" ? "正在应用…" : active ? "保存并应用到当前画面" : "保存" }}</button>
            </div>
          </template>
        </div>

        <div v-if="!active" class="opener card pad stack">
          <h2>打开远程画面</h2>
          <UiSegmented v-model="kind" :options="[{ value: 'browser', label: '浏览器' }, { value: 'desktop', label: '桌面' }]" aria-label="打开什么" @change="kind === 'desktop' && loadScreens(true)" />
          <template v-if="kind === 'browser'">
            <label class="field"><span>网址</span><input v-model="url" class="input" placeholder="https://…（可以先空着，打开后再在上面输入）" @keydown.enter.prevent="open" /></label>
            <div class="field">
              <span>浏览器资料</span>
              <UiSelect :model-value="profile" :options="profileOptions" aria-label="浏览器资料" :search-at="10" @update:model-value="pickProfile" />
              <span v-if="copying" class="hint">把这份资料的登录复制到一份临时资料里打开，你平时用的资料不会被改动，关掉会话就删掉。个别网站的登录可能带不过来。</span>
              <span v-else-if="!profile" class="hint">什么都没登录，关掉就清空。要保留登录，新建一份长期资料，或复制这台机器上浏览器的登录。</span>
            </div>
            <UiCheckbox v-if="copying" v-model="closeRunning">如果这台机器上的 {{ BROWSER_NAMES[copying.browser] }} 正开着，先关掉它（会关掉它的所有窗口）</UiCheckbox>
            <UiCheckbox v-model="visible">在这台机器上也显示浏览器窗口（默认只在这里看）</UiCheckbox>
          </template>
          <div v-else class="field">
            <span>共享哪部分</span>
            <UiSelect v-model="area" :options="areaOptions" aria-label="共享哪部分" :search-at="8" />
            <span class="hint">共享一个窗口时，录制就录这个窗口里的操作；共享整个屏幕时，开始录制前再选录哪个程序。</span>
          </div>
          <div class="row"><button class="btn primary" :disabled="busy === 'open'" @click="open"><Icon name="play" :size="15" />{{ busy === "open" ? "正在打开…" : "打开" }}</button></div>
          <p class="muted small">画面在这台机器（omem 所在的电脑）上，你的鼠标键盘会转发过去。30 分钟没人看会自动关闭。</p>
        </div>

        <div v-else class="frame">
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
              <input v-model="goal" class="input grow" placeholder="这次要教的事（一句话；也可以先在右边和助手说）" aria-label="这次要教的事" />
              <UiSelect
                v-if="pickProgram"
                v-model="recordWindow"
                :options="recordOptions"
                placeholder="录哪个程序"
                aria-label="录哪个程序"
                width="240px"
                :search-at="8"
                title="录制一次看一个程序，记下在它里面点了哪个元素"
              />
              <button v-if="pickProgram" class="btn ghost sm icon" aria-label="刷新程序列表" title="刚打开的程序不在列表里时刷新" @click="loadScreens(true)"><Icon name="refresh" :size="14" /></button>
              <button class="btn accent" :disabled="busy === 'record'" @click="startRecording"><Icon name="camera" :size="15" />开始录制</button>
            </template>
            <template v-else>
              <span class="rec"><span class="dot" />录制中 {{ elapsed }}</span>
              <span class="muted small grow">在画面里把要教的事做一遍，做完点停止。</span>
              <button class="btn danger-fill" :disabled="busy === 'stop'" @click="stopRecording"><Icon name="stop" :size="15" />{{ busy === "stop" ? "正在整理…" : "停止" }}</button>
            </template>
          </div>
        </div>
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
.bar {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  min-width: 0;
}
/* Centred on the tabs' height, whether or not there are tabs. */
.bar > .tools {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 35px;
  flex: none;
}
/* Sessions as tabs, joined to the frame below like a browser's. */
.stabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
}
.stab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  max-width: 220px;
  min-width: 0;
  padding: 0 6px 0 12px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  flex: none;
}
.stab:hover:not(.on) {
  background: var(--hover);
  color: var(--ink);
}
.stab.on {
  background: var(--panel);
  border-color: var(--line);
  color: var(--ink);
  font-weight: 550;
  position: relative;
  /* Covers the frame's top border under the tab. */
  margin-bottom: -1px;
  height: 35px;
}
.stab.add {
  padding: 0 12px;
}
.stab .x {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: inherit;
  cursor: pointer;
  opacity: 0.55;
  flex: none;
}
.stab .x:hover {
  background: var(--hover);
  opacity: 1;
}
.stab .dot {
  width: 7px;
  height: 7px;
}
/* In the middle of what is left below the bar. */
.opener {
  max-width: 600px;
  width: 100%;
  margin: auto;
  box-sizing: border-box;
}
.opener h2 {
  font-family: var(--serif);
  font-size: 22px;
}
.settings {
  display: grid;
  gap: 12px;
}
.settings .grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px 14px;
}
.settings .checks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
}
.settings .foot {
  gap: 8px;
  flex-wrap: wrap;
}
/* On a narrow screen the note takes its own line above the buttons. */
.settings .foot > .grow {
  flex: 1 1 240px;
}
.nowrap {
  white-space: nowrap;
}
/* The open session: address bar, picture and recording controls in one box under its tab. */
.frame {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 0 var(--radius) var(--radius) var(--radius);
  overflow: hidden;
}
.address {
  gap: 8px;
  padding: 8px 10px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
}
.viewer {
  flex: 1;
  min-height: 320px;
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
  padding: 10px;
  border-top: 1px solid var(--line);
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
