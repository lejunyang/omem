<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { del, get, onServerEvent, post, put } from "../api";
import Icon from "../components/Icon.vue";
import RemoteChat from "../components/RemoteChat.vue";
import RemoteGrants from "../components/RemoteGrants.vue";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect, { type SelectOption } from "../components/UiSelect.vue";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { relTime, toast } from "../store";
import { hasPerm } from "../lib/caps";
import { endedMessage, endedText, expiryLabel, isEnded, MODE_LABEL, type EndedGrant, type EndReason, type RemoteGrant } from "../lib/remote-grants";

/**
 * Remote operation (docs/v2/remote.md): a browser page or the desktop of the machine omem runs on,
 * shown through aad's viewer, with a recording that the assistant beside it turns into a skill.
 */
type Session = { id: string; kind: "browser" | "desktop"; title: string; createdAt: string; browser: { name: string; url: string | null; profile: string | null } | null; window: string | null; recording: string | null; viewers: number; src?: string;
  /** Whose it is; `grant`: what this person was handed; `grants`: who the owner handed it to (owner only); `runId`: opened by a run. */
  ownerId?: string; ownerName?: string; mine?: boolean; grant?: RemoteGrant | null; grants?: RemoteGrant[]; runId?: string | null; spaceId?: string | null };
type BrowserProfile = { browser: "chrome" | "edge" | "brave"; id: string; name: string };
type Recording = { id: string; kind: "browser" | "desktop"; goal: string; target: string; status: "recording" | "done" | "failed"; summary: Record<string, any>; conversationId: string | null; skill: string | null; createdAt: string };
type Settings = { format: string; quality: number; fps: number; maxWidth: number; cursor: boolean; clipboard: boolean; clipboardMaxMb: number; browser: "" | "chrome" | "edge" | "brave" };
type VideoProbe = { at: string; ffmpeg: string | null; encoders: Record<string, string> };
type Screens = { monitors: { monitor: number; name: string; primary?: boolean; width: number; height: number }[]; windows: { window: string; title: string }[]; recordable: { resourceId: string; name: string; process: string | null }[] };

// /remote/<会话>: that session alone, filling the page (opened from 「单独打开」).
const route = useRoute();
const soloId = computed(() => (typeof route.params.id === "string" && route.params.id) || "");
const ended = ref(false);

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
const windowAvailable = ref(true);
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
    const r = await get<{ available: boolean; version: string | null; sessions: (Session | EndedGrant)[]; profiles: string[]; windowAvailable: boolean }>("/api/remote");
    available.value = r.available;
    version.value = r.version;
    sessions.value = live(r.sessions);
    profiles.value = r.profiles;
    windowAvailable.value = r.windowAvailable;
    if (!r.windowAvailable) visible.value = false;
    if (r.available && canControl.value) recordings.value = await get<Recording[]>("/api/remote/recordings");
    if (soloId.value) {
      const s = sessions.value.find((x) => x.id === soloId.value);
      const gone = r.sessions.find((x): x is EndedGrant => isEnded(x) && x.id === soloId.value);
      if (s) await show(s);
      else if (gone) lost.value = endedText(gone.ended, null);
      else ended.value = true;
    }
    // Back on the page with a session still open: show it again (the viewer cookie comes with it).
    else if (!active.value && sessions.value.length) await show(sessions.value[0]);
  } finally {
    loading.value = false;
  }
}
/**
 * Opening sessions, recording and the picture settings are for those who control this machine
 * (`desktop.control`); someone handed a session only sees the sessions handed to them.
 */
const canControl = computed(() => hasPerm("desktop.control"));
/** Said in place of the picture when a session handed to this person was taken back or ran out. */
const lost = ref("");
/** The session whose 交给成员 sheet is open. */
const grantsFor = ref<string | null>(null);
const grantsSession = computed(() => sessions.value.find((s) => s.id === grantsFor.value) ?? null);

/** The list without the grants that ended lately (`GET /api/remote` lists those too, with why). */
const live = (list: (Session | EndedGrant)[]) => list.filter((s): s is Session => !isEnded(s));
/**
 * The list again (when the server says a grant ended, when one runs out, and every so often): who is
 * watching, grants changed by the owner. A session handed to this person that left the list ends with a
 * sentence saying why, not an error; a changed mode loads the picture again with it.
 */
async function refresh() {
  const r = await get<{ sessions: (Session | EndedGrant)[] }>("/api/remote").catch(() => null);
  if (!r) return;
  sessions.value = live(r.sessions);
  const a = active.value;
  if (!a) return;
  const now = sessions.value.find((s) => s.id === a.id);
  const gone = r.sessions.find((s): s is EndedGrant => isEnded(s) && s.id === a.id);
  if (!now) return void (a.grant ? endHanded(a, gone?.ended) : undefined);
  const modeChanged = !!a.grant && !!now.grant && now.grant.mode !== a.grant.mode;
  active.value = { ...a, ...now, src: a.src };
  if (modeChanged) void reconnect(true);
}
/** A session handed to this person ended: why, by the server's reason when it gave one. */
function endHanded(s: Session, reason?: EndReason) {
  if (!s.grant) return;
  lost.value = reason ? endedText(reason, s.ownerName) : endedMessage(s.grant, s.ownerName);
  sessions.value = sessions.value.filter((x) => x.id !== s.id);
  if (active.value?.id === s.id) active.value = null;
  clearReconnect();
}
/** Refused the picture of a session handed to this person: ask the list why (it keeps recent ends). */
async function endHandedWhy(s: Session) {
  const r = await get<{ sessions: (Session | EndedGrant)[] }>("/api/remote").catch(() => null);
  endHanded(s, r?.sessions.find((x): x is EndedGrant => isEnded(x) && x.id === s.id)?.ended);
}
// The server tells the member the moment a grant ends (taken back, ran out, the session closed).
const offGrant = onServerEvent((e) => {
  if (e.type !== "remote-grant-ended") return;
  const s = sessions.value.find((x) => x.id === e.sessionId && x.grant?.id === e.grantId);
  if (!s) return;
  if (active.value?.id === s.id) endHanded(active.value, e.ended);
  else {
    sessions.value = sessions.value.filter((x) => x.id !== s.id);
    toast(`「${s.title}」：${endedText(e.ended, s.ownerName)}`, "info");
  }
});
let poll: ReturnType<typeof setInterval> | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
// Every so often as well: who is watching (for whoever hands sessions out), and in case an event was missed.
onMounted(() => (poll = setInterval(() => { if (!document.hidden) void refresh(); }, canControl.value ? 15_000 : 60_000)));
onBeforeUnmount(() => { offGrant(); if (poll) clearInterval(poll); if (expiry) clearTimeout(expiry); });
// A grant that runs out while it is open: look again right then.
watch(() => active.value?.grant?.expiresAt, (at) => {
  if (expiry) clearTimeout(expiry);
  expiry = at ? setTimeout(() => void refresh(), Math.min(2_147_483_647, Math.max(0, Date.parse(at) - Date.now()) + 1500)) : null;
});
const handedLine = computed(() => {
  const g = active.value?.grant;
  if (!g || active.value?.mine) return "";
  const owner = active.value?.ownerName ?? "会话的主人";
  const until = expiryLabel(g.expiresAt, tick.value || Date.now());
  return g.mode === "view" ? `只能看，不能点和输入 · ${owner}交给你的 · ${until}` : `${owner}交给你操作 · ${until}`;
});
const viewOnly = computed(() => !!active.value?.grant && !active.value.mine && active.value.grant.mode === "view");
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
const pageTitle = document.title;
watch(() => soloId.value && active.value?.title, (t) => t && (document.title = `${t} · 远程`));
onBeforeUnmount(() => (document.title = pageTitle));

/** The open session in a tab of its own, filling the page. */
function openAlone() {
  if (active.value) window.open(`${location.pathname}${location.search}#/remote/${encodeURIComponent(active.value.id)}`, "_blank");
}

// Full screen: the picture with its address bar. Where the browser allows it (Chromium, https or
// localhost) the keyboard is locked too, so Esc, Alt+Tab and the like go to the remote machine and
// holding Esc leaves full screen; elsewhere Esc leaves full screen.
const frameBox = ref<HTMLElement>();
const fullscreen = ref(false);
const canFullscreen = typeof document !== "undefined" && !!document.fullscreenEnabled;
type KeyboardLock = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
const keyboard = () => (navigator as unknown as { keyboard?: KeyboardLock }).keyboard;
const keysLocked = ref(false);
async function toggleFullscreen() {
  if (document.fullscreenElement) return void (await document.exitFullscreen().catch(() => {}));
  const box = frameBox.value;
  if (!box) return;
  try {
    await box.requestFullscreen({ navigationUI: "hide" });
  } catch (e) {
    return void toast(`没能全屏：${(e as Error).message}`, "error");
  }
  keysLocked.value = !!(await keyboard()?.lock?.().then(() => true, () => false));
  frame.value?.focus();
}
function onFullscreenChange() {
  fullscreen.value = !!document.fullscreenElement && document.fullscreenElement === frameBox.value;
  if (!fullscreen.value && keysLocked.value) {
    keyboard()?.unlock?.();
    keysLocked.value = false;
  }
}
onMounted(() => document.addEventListener("fullscreenchange", onFullscreenChange));
onBeforeUnmount(() => document.removeEventListener("fullscreenchange", onFullscreenChange));
const fullscreenTitle = computed(() => (fullscreen.value ? (keysLocked.value ? "退出全屏（也可以按住 Esc）" : "退出全屏（Esc）") : "全屏操作"));

// The viewer's WebSocket can drop (a proxy closing it, the machine sleeping) and aad's page does not
// try again: it shows "已断开". omem serves that page from its own origin, so watch its status line
// and load the viewer again; a session that ended meanwhile leaves the list.
const frame = ref<HTMLIFrameElement>();
const frameKey = ref(0);
const reconnecting = ref<"" | "waiting" | "failed">("");
let watcher: MutationObserver | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
const DISCONNECTED = ["已断开", "Disconnected"];
// aad's viewer has its own look (system font, grey outlines, heavy shadows). It is served from this
// origin, so its status line, buttons, paste notice and clipboard tray get omem's tokens: the values
// are copied over (custom properties do not cross into a frame) and again when the theme changes.
const TOKENS = ["bg", "panel", "sunken", "hover", "line", "line-strong", "ink", "muted", "accent", "radius", "radius-sm", "shadow", "sans"];
const SKIN = `
:root{--bg:var(--o-sunken);--fg:var(--o-ink);--muted:var(--o-muted)}
body{font:13px/1.5 var(--o-sans)}
header{padding:6px 12px;font-size:12px}
canvas{box-shadow:var(--o-shadow)}
#take,#remote-clip,#transfer button,#tray button{height:24px;padding:0 10px;border-radius:var(--o-radius-sm);border:1px solid var(--o-line-strong);background:var(--o-panel);color:var(--o-ink);font:inherit;font-size:12px;cursor:pointer}
#take:hover,#remote-clip:hover,#transfer button:hover,#tray button:hover{background-image:linear-gradient(var(--o-hover),var(--o-hover))}
#transfer,#tray{background:var(--o-panel);color:var(--o-ink);border:1px solid var(--o-line);border-radius:var(--o-radius);box-shadow:var(--o-shadow);font-size:13px}
#transfer{top:10px;right:16px;padding:6px 8px 6px 12px;min-height:24px}
#transfer progress{accent-color:var(--o-accent)}
#tray{top:10px;right:16px;padding:10px 12px}
#tray h2{font-size:13px;font-weight:600}
#tray h2 button{border:0;background:none;height:22px;padding:0 6px;color:var(--o-muted)}
#tray .row{border-top-color:var(--o-line)}
#tray .muted{color:var(--o-muted)}
#tray a{color:var(--o-accent);text-decoration:none}
#tray a:hover{text-decoration:underline}
#tray img{border-radius:var(--o-radius-sm);border:1px solid var(--o-line)}`;
let themeWatch: MutationObserver | null = null;
function skinViewer() {
  let doc: Document | null | undefined;
  try {
    doc = frame.value?.contentDocument;
  } catch { /* not the viewer */ }
  if (!doc?.getElementById("screen")) return;
  const css = getComputedStyle(document.documentElement);
  const vars = TOKENS.map((t) => `--o-${t}:${css.getPropertyValue(`--${t}`).trim()}`).join(";");
  let style = doc.getElementById("omem-skin");
  if (!style) {
    style = doc.createElement("style");
    style.id = "omem-skin";
    doc.head.append(style);
  }
  style.textContent = `:root{${vars};color-scheme:${css.colorScheme || "light"}}${SKIN}`;
}
onMounted(() => {
  themeWatch = new MutationObserver(skinViewer);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
});
onBeforeUnmount(() => themeWatch?.disconnect());

function frameLoaded() {
  skinViewer();
  watcher?.disconnect();
  watcher = null;
  let status: HTMLElement | null | undefined;
  try {
    status = frame.value?.contentDocument?.getElementById("status");
  } catch { /* not the viewer */ }
  if (!status) return;
  const check = () => {
    const text = status!.textContent?.trim() ?? "";
    if (DISCONNECTED.includes(text)) scheduleReconnect();
    else if (text && reconnecting.value === "waiting" && !retry) (attempts = 0), (reconnecting.value = "");
  };
  watcher = new MutationObserver(check);
  watcher.observe(status, { childList: true, characterData: true, subtree: true });
  check();
}
function scheduleReconnect() {
  if (retry) return;
  if (attempts >= 8) return void (reconnecting.value = "failed");
  reconnecting.value = "waiting";
  const wait = Math.min(30_000, 1000 * 2 ** attempts++);
  retry = setTimeout(() => {
    retry = null;
    if (document.hidden) return void document.addEventListener("visibilitychange", () => void reconnect(), { once: true });
    void reconnect();
  }, wait);
}
function clearReconnect() {
  if (retry) clearTimeout(retry);
  retry = null;
  attempts = 0;
  reconnecting.value = "";
}
/** Load the viewer again; by hand (the refresh button) it starts over from the first attempt. */
async function reconnect(byHand = false) {
  const s = active.value;
  if (!s) return;
  if (byHand) clearReconnect();
  try {
    const next = await post<Session>(`/api/remote/sessions/${s.id}/view`);
    if (active.value?.id !== s.id) return;
    active.value = { ...s, ...next };
    frameKey.value++;
  } catch (e) {
    if (s.grant && !s.mine && ([403, 404].includes((e as { status?: number }).status ?? 0) || /有效授权|已经结束/.test((e as Error).message))) void endHandedWhy(s);
    else if ((e as { status?: number }).status === 404 || /已经结束/.test((e as Error).message)) {
      toast("远程会话已经结束", "error");
      sessions.value = sessions.value.filter((x) => x.id !== s.id);
      if (active.value?.id === s.id) active.value = null;
      clearReconnect();
      void loadRecordings();
    } else scheduleReconnect();
  }
}
onBeforeUnmount(() => {
  watcher?.disconnect();
  if (retry) clearTimeout(retry);
});

async function show(s: Session) {
  clearReconnect();
  lost.value = "";
  try {
    active.value = { ...s, ...(await post<Session>(`/api/remote/sessions/${s.id}/view`)) };
  } catch (e) {
    if (s.grant && !s.mine) return void endHandedWhy(s);
    throw e;
  }
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
// aad 0.0.9 on: rich text, pictures and files through the clipboard both ways; before, copied text back.
const richClipboard = computed(() => {
  const v = /(\d+)\.(\d+)\.(\d+)/.exec(version.value ?? "");
  return !!v && (Number(v[1]) > 0 || Number(v[2]) > 0 || Number(v[3]) >= 9);
});
const fileLimitOptions: SelectOption<number>[] = [
  { value: 0, label: "不传文件", hint: "文字、富文本和图片照常" },
  ...[20, 100, 500, 2048].map((n) => ({ value: n, label: n >= 1024 ? `${n / 1024} GB` : `${n} MB`, hint: n === 100 ? "默认" : undefined })),
];
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
      ? { kind: "browser", url: url.value.trim() || undefined, ...(copying.value ? { copyFrom: copying.value } : { profile: profile.value || undefined }), closeRunning: closeRunning.value, visible: visible.value }
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
  return [`${s.replayable ?? 0} 步`, s.skipped ? `跳过 ${s.skipped}` : "", s.requests ? `${s.requests} 个请求` : ""].filter(Boolean).join(" · ");
};
</script>

<template>
  <div class="remote" :class="{ solo: soloId }">
    <Skeleton v-if="loading" :rows="6" />
    <div v-else-if="soloId && !active" class="empty">
      <h1>远程会话已经结束</h1>
      <p class="muted">{{ lost ? `${lost}。` : ended ? "这个远程会话不在了：可能已经关掉，或者 30 分钟没人看自动关了。" : "画面已经关掉。" }}到远程页可以重新打开。</p>
      <router-link to="/remote" class="btn">去远程页</router-link>
    </div>
    <div v-else-if="!available" class="empty">
      <h1>远程操作</h1>
      <p class="muted">这台机器还没有装 ai-auto-desktop（aad）。到 设置 → 设备 → 桌面与浏览器控制 里安装后，这里可以打开本机的浏览器页面或桌面，远程操作并录制成技能。</p>
      <router-link to="/settings" class="btn">去设置</router-link>
    </div>
    <template v-else>
      <section class="stage">
        <div v-if="!soloId" class="bar">
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
              <span v-if="s.runId" class="stab-tag" title="助手在一次运行里打开的">助手</span>
              <span v-if="!s.mine && s.ownerName" class="stab-tag">{{ s.ownerName }}的</span>
              <span v-if="s.grants?.length" class="stab-tag on" :title="`交给了 ${s.grants.map((g) => g.userName).join('、')}`">交给 {{ s.grants.length }} 人</span>
              <span v-if="s.recording" class="dot" title="录制中" />
              <button v-if="canControl && s.mine !== false" class="x" :aria-label="`关闭 ${s.title}`" title="关闭会话" @click.stop="close(s)"><Icon name="x" :size="13" /></button>
            </div>
            <button v-if="canControl" class="stab add" :class="{ on: !active }" role="tab" :aria-selected="!active" title="打开新的远程画面" @click="active = null">
              <Icon name="plus" :size="14" /><span v-if="!sessions.length || !active">新会话</span>
            </button>
          </div>
          <span v-else class="spacer" />
          <div v-if="canControl" class="tools">
            <span class="muted small nowrap">aad {{ version }}</span>
            <button class="btn sm" :class="showSettings ? 'primary' : 'ghost'" :aria-expanded="showSettings" @click="toggleSettings"><Icon name="settings" :size="14" />画面设置</button>
          </div>
        </div>

        <div v-if="showSettings && !soloId && canControl" class="settings card pad">
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
              <UiCheckbox v-if="richClipboard" v-model="settings.clipboard" size="sm">剪贴板互通（文字、富文本、图片和文件）</UiCheckbox>
              <UiCheckbox v-else v-model="settings.clipboard" size="sm">在画面里复制的文字带回这边的剪贴板</UiCheckbox>
            </div>
            <div v-if="richClipboard && settings.clipboard" class="field clip">
              <span>粘贴或带回的文件一次最多</span>
              <UiSelect v-model="settings.clipboardMaxMb" :options="fileLimitOptions" aria-label="传文件上限" width="180px" />
              <span class="hint">这边 Ctrl+V 粘贴的文件传到远程再粘贴；远程复制的文件在画面角上给下载。用 http + IP 打开时，带回的图片也只能下载（浏览器只让 https 或本机地址的网页写图片进剪贴板）。</span>
            </div>
            <p v-else-if="!richClipboard && settings.clipboard" class="muted small">aad 0.0.9 起，图片、富文本和文件也能两个方向复制粘贴：到 设置 → 设备 的“桌面与浏览器控制”点“更新到最新”。</p>
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

        <div v-if="!active && !canControl" class="handed-empty card pad" role="status">
          <h2>{{ lost || "现在没有交给你的远程会话" }}</h2>
          <p class="muted small">{{ sessions.length ? "上面是别人交给你的会话，点一个打开。" : "有人把浏览器会话交给你时，会出现在这里。" }}</p>
        </div>
        <div v-else-if="!active" class="opener card pad stack">
          <p v-if="lost" class="lost small" role="status">{{ lost }}</p>
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
            <UiCheckbox v-if="profile" v-model="closeRunning" aria-label="先关闭占用这份资料的浏览器">先关闭占用这份资料的浏览器（会关闭它的所有窗口，并清理已退出进程留下的锁）</UiCheckbox>
            <div class="field">
              <UiCheckbox v-model="visible" :disabled="!windowAvailable" aria-label="在运行 omem 的电脑桌面上也显示浏览器窗口">在运行 omem 的电脑桌面上也显示浏览器窗口</UiCheckbox>
              <span v-if="windowAvailable" class="hint">默认只在当前远程画面里看和操作。勾选后，那台电脑前的人也能直接看和操作这个窗口。</span>
              <span v-else class="hint">后台服务没有连接到桌面，浏览器仍可在远程画面里使用。要在电脑上也显示窗口，请从那台电脑的桌面终端重启 omem 服务。</span>
            </div>
          </template>
          <div v-else class="field">
            <span>共享哪部分</span>
            <UiSelect v-model="area" :options="areaOptions" aria-label="共享哪部分" :search-at="8" />
            <span class="hint">共享一个窗口时，录制就录这个窗口里的操作；共享整个屏幕时，开始录制前再选录哪个程序。</span>
          </div>
          <div class="row"><button class="btn primary" :disabled="busy === 'open'" @click="open"><Icon name="play" :size="15" />{{ busy === "open" ? "正在打开…" : "打开" }}</button></div>
          <p class="muted small">画面在这台机器（omem 所在的电脑）上，你的鼠标键盘会转发过去。30 分钟没人看会自动关闭。</p>
        </div>

        <div v-else ref="frameBox" class="frame" :class="{ full: fullscreen }">
          <component :is="active.kind === 'browser' ? 'form' : 'div'" class="address row" @submit.prevent="go">
            <router-link v-if="soloId && !fullscreen" to="/remote" class="btn ghost sm icon" aria-label="回到远程页" title="回到远程页（这个会话不会关）"><Icon name="left" :size="14" /></router-link>
            <template v-if="active.kind === 'browser' && !viewOnly">
              <Icon name="globe" :size="15" />
              <input v-model="address" class="input grow" placeholder="输入网址，回车前往" aria-label="网址" />
              <button class="btn sm" :disabled="busy === 'go'">{{ busy === "go" ? "前往中…" : "前往" }}</button>
            </template>
            <span v-else class="muted small grow ellipsis" :title="active.browser?.url ?? undefined">{{ active.browser?.url || active.title }}</span>
            <button v-if="active.grants && active.kind === 'browser' && !fullscreen" type="button" class="btn ghost sm" :aria-label="`把 ${active.title} 交给成员`" title="把这个浏览器会话交给成员看或操作" @click="grantsFor = active.id"><Icon name="user" :size="14" />交给成员<span v-if="active.grants.length" class="badge n">{{ active.grants.length }}</span></button>
            <span v-if="active.recording && (soloId || fullscreen)" class="rec small nowrap"><span class="dot" />录制中 {{ elapsed }}</span>
            <button type="button" class="btn ghost sm icon" aria-label="刷新画面" :title="active.kind === 'browser' ? '重新连接画面（页面本身不刷新）' : '重新连接画面'" @click="reconnect(true)"><Icon name="refresh" :size="14" /></button>
            <button v-if="!soloId && !fullscreen" type="button" class="btn ghost sm icon" aria-label="单独打开" title="在新标签页里单独打开这个画面，占满整个网页" @click="openAlone"><Icon name="external" :size="14" /></button>
            <button v-if="canFullscreen" type="button" class="btn ghost sm icon" :aria-label="fullscreen ? '退出全屏' : '全屏操作'" :aria-pressed="fullscreen" :title="fullscreenTitle" @click="toggleFullscreen"><Icon :name="fullscreen ? 'minimize' : 'maximize'" :size="14" /></button>
          </component>
          <div v-if="(handedLine || active.runId) && !fullscreen" class="handed small" :class="{ view: viewOnly }" role="status">
            <template v-if="handedLine">
              <Icon :name="viewOnly ? 'eye' : 'user'" :size="13" />
              <span class="ellipsis" :title="handedLine">{{ handedLine }}</span>
            </template>
            <template v-if="active.runId">
              <span v-if="handedLine" class="muted">·</span>
              <span class="muted">助手开的</span>
              <router-link v-if="active.mine || canControl" :to="`/runs/${active.runId}`">看这次运行</router-link>
            </template>
          </div>
          <div class="viewer">
            <iframe ref="frame" :key="`${active.id}:${frameKey}`" :src="active.src" :title="`远程画面：${active.title}`" allow="clipboard-read; clipboard-write" @load="frameLoaded" />
            <div v-if="reconnecting" class="reconnect small" role="status">
              {{ reconnecting === "waiting" ? "画面断开了，正在重新连接…" : "重新连接没有成功" }}
              <button class="btn ghost sm" @click="reconnect(true)"><Icon name="refresh" :size="13" />现在刷新</button>
            </div>
          </div>
          <div v-if="!soloId && !fullscreen && canControl && active.mine !== false" class="controls row">
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

      <aside v-if="!soloId && canControl" class="side">
        <div class="side-head row"><strong>助手</strong><span class="spacer" /><button v-if="conversationId" class="btn ghost sm" @click="setConversation(null)">新对话</button></div>
        <RemoteChat ref="chat" class="chat" :conversation-id="conversationId" @update:conversation-id="setConversation" />
        <div class="recs">
          <div class="side-head row"><strong>录制</strong></div>
          <div v-if="!recordings.length" class="muted small">还没有录制。</div>
          <div v-for="r in recordings.slice(0, 8)" :key="r.id" class="rec-row">
            <div class="grow">
              <div class="ellipsis" :title="r.goal">{{ r.goal || "（没写要做的事）" }}</div>
              <div class="muted small">{{ r.kind === "browser" ? "浏览器" : "桌面" }} · {{ relTime(r.createdAt) }} · {{ counts(r) }}<span v-if="r.skill"> · 技能 {{ r.skill }}</span></div>
            </div>
            <div v-if="r.status === 'done'" class="row acts">
              <button class="btn ghost sm" title="交给助手整理成技能" @click="organize(r)"><Icon name="sparkles" :size="13" />整理</button>
            </div>
          </div>
        </div>
      </aside>
    </template>
    <RemoteGrants v-if="grantsSession" :session="{ id: grantsSession.id, title: grantsSession.title, ownerId: grantsSession.ownerId ?? '', grants: grantsSession.grants }" @close="grantsFor = null" @changed="refresh" />
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
/* Full screen, or the session on a page of its own: the picture takes everything. */
.frame.full,
.solo .frame {
  border: 0;
  border-radius: 0;
}
.remote.solo {
  padding: 0;
  height: 100vh;
}
.solo .empty {
  padding: 0 16px;
}
.address {
  gap: 8px;
  padding: 8px 10px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
}
.viewer {
  position: relative;
  flex: 1;
  min-height: 320px;
  background: var(--sunken);
}
.reconnect {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  box-shadow: var(--shadow);
  white-space: nowrap;
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
  .remote:not(.solo) {
    flex-direction: column;
    height: auto;
  }
  .remote:not(.solo) .frame:not(.full) .viewer {
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
/* Handing a session to members: small marks on the tab, a line above the picture for the member. */
.stab-tag {
  flex: none;
  font-size: 11px;
  line-height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--sunken);
  color: var(--muted);
  font-weight: 400;
  white-space: nowrap;
}
.stab-tag.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.stab:has(.stab-tag) {
  max-width: 300px;
}
.handed {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--line);
  color: var(--ink-2);
  min-width: 0;
}
.handed.view {
  background: var(--sunken);
}
.handed > .ellipsis {
  min-width: 0;
}
.handed-empty {
  max-width: 600px;
  width: 100%;
  margin: auto;
  box-sizing: border-box;
  display: grid;
  gap: 8px;
}
.handed-empty h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.handed-empty p,
.opener .lost {
  margin: 0;
}
.opener .lost {
  color: var(--ink-2);
}</style>
