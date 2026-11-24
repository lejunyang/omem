<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CaptureDialog from "./components/CaptureDialog.vue";
import CitationDrawer from "./components/CitationDrawer.vue";
import CommandPalette from "./components/CommandPalette.vue";
import DialogHost from "./components/DialogHost.vue";
import ImagePreview from "./components/ImagePreview.vue";
import Skeleton from "./components/Skeleton.vue";
import UiSelect from "./components/UiSelect.vue";
import Icon from "./components/Icon.vue";
import { get, setLiveEvents } from "./api";
import { loadSpaces, refreshUnread, state } from "./store";
import { spaceOptions } from "./lib/spaces";
import { capAnywhere, hasCap, hasPerm, settingsAnywhere, settingsArea } from "./lib/caps";
import { preloadRoute } from "./preload";
import { setTimeZone } from "./lib/time";

const route = useRoute();
const router = useRouter();
async function selectSpace(space: string) {
  if (space === state.space) return;
  // Leave the old requirement before the space key remounts the page. A requirement link can still set
  // state.space itself to open its own business tree.
  if (route.path.startsWith("/code/reqs/")) await router.replace("/code/reqs");
  state.space = space;
}
watch(() => state.space, () => {
  const section = route.path.split("/")[1];
  // The knowledge-base list is not per space: it stays.
  if (["ask", "sources", "runs"].includes(section) && route.path !== "/sources/kb") void router.replace(`/${section}`);
  // An open delegation (编码 → 交办) leaves with the space too; 方案 has its own space filter.
  else if (route.matched.at(-1)?.path === "/code/:id?" && route.params.id) void router.replace("/code");
});
const menu = ref(false);
const loadError = ref("");
// Who gets an entry (lib/caps.ts): `cap` a global capability, `space` a space-scoped one held in any
// space (`own`: the person's own items and runs count), `spaces` any of several such, `perm` an old
// global permission, `member` anyone. An entry with none of these is the owner's.
type NavEntry = { to: string; label: string; icon: string; exact?: boolean; member?: boolean; cap?: string; space?: string; spaces?: string[]; own?: boolean; perm?: string };
const reviewEntry: NavEntry = { to: "/agents?tab=review", label: "评审设置", icon: "layers", cap: "settings.assistant.view" };
const reviewTab = computed(() => route.path === "/agents" && route.query.tab === "review");
const nav = ref<NavEntry[]>([
  // The work lines (views/Work.vue): the start page. Others with 看工作线 read the owner's lines there.
  { to: "/", label: "工作", icon: "home", exact: true, space: "work.view" },
  { to: "/ask", label: "问答", icon: "chat", member: true },
  { to: "/wiki", label: "Wiki", icon: "book", space: "wiki.view" },
  { to: "/items", label: "事项", icon: "checkbox", space: "items.view", own: true },
  // Items moving through a flow, by stage: for the owner it is the work page's 按阶段 (no entry of its own);
  // everyone else keeps the board here.
  { to: "/board", label: "流程", icon: "branch", space: "flows.view" },
  // 交办, 方案 and 需求 (components/CodeTabs.vue): for whoever may read any of them.
  { to: "/code", label: "编码", icon: "code", spaces: ["code.work.view", "designs.view", "requirements.view"], own: true },
  { to: "/memory", label: "记忆", icon: "brain", space: "memories.view" },
  { to: "/sources", label: "原件", icon: "file", space: "sources.view" },
  { to: "/learn", label: "学习", icon: "cap" },
  { to: "/agents", label: "Agent", icon: "layers", perm: "agents.manage" },
  { to: "/rules", label: "规则", icon: "zap", cap: "rules.view" },
  { to: "/quality", label: "抽检", icon: "sample" },
  { to: "/insights", label: "数据", icon: "chart", space: "metrics.view" },
  // 运行 stays last: pages added later (远程) go before it.
  { to: "/runs", label: "运行", icon: "activity", space: "runs.view", own: true },
]);
// Plugins with a page (docs/v2/plugins.md) go right after 学习.
async function addPluginPages() {
  const plugins = await get<{ id: string; icon: string; page: { title: string } | null }[]>("/api/plugins").catch(() => []);
  const rest = nav.value.filter((n) => !n.to.startsWith("/plugin/"));
  const at = rest.findIndex((n) => n.to === "/learn") + 1;
  rest.splice(at, 0, ...plugins.filter((p) => p.page).map((p) => ({ to: `/plugin/${p.id}`, label: p.page!.title, icon: p.icon, member: true })));
  nav.value = rest;
}
// Remote operation (views/Remote.vue) only where this machine has ai-auto-desktop installed: for those who
// control it, and for those who may be handed a session (看 / 操作授权给他的远程会话).
async function addRemotePage() {
  const handed = hasCap("remote.browser") ? "remote.browser" : hasCap("remote.view") ? "remote.view" : hasCap("remote.operate") ? "remote.operate" : undefined;
  if (!hasPerm("desktop.control") && !handed) return;
  const r = await get<{ available: boolean }>("/api/remote").catch(() => ({ available: false }));
  if (r.available && !nav.value.some((n) => n.to === "/remote")) {
    const list = [...nav.value];
    const at = list.findIndex((n) => n.to === "/runs");
    list.splice(at < 0 ? list.length : at, 0, { to: "/remote", label: "远程", icon: "monitor", perm: "desktop.control", ...(handed ? { cap: handed } : {}) });
    nav.value = list;
  }
}
// Settings → 插件 changed an icon.
watch(() => state.pluginsChanged, addPluginPages);
// The owner's flows live on the work page (按阶段, and 流程定义 from there): 工作 stays lit for them.
const isActive = (to: string, exact?: boolean) =>
  to === reviewEntry.to ? reviewTab.value
  : to === "/" ? route.path === "/" || route.path.startsWith("/work/") || (owner.value && route.path === "/flows")
  : to === "/board" ? route.path === "/board" || route.path === "/flows"
  : exact ? route.path === to : route.path === to || route.path.startsWith(to + "/") || (to === "/wiki" && route.path.startsWith("/graph"));

function onKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    state.palette = !state.palette;
  } else if (mod && e.key.toLowerCase() === "j") {
    e.preventDefault();
    state.capture = true;
  }
}
const owner = computed(() => !state.me || state.me.role === "owner");
/** The settings page: any area of the settings (lib/caps.ts), or the members and the trail for whoever manages members. */
const settingsEntry = computed(() => owner.value || settingsAnywhere() || hasPerm("users.manage"));
const settingsLabel = computed(() => (owner.value || ["knowledge", "assistant", "ai", "channels", "system"].some((a) => settingsArea(a as "ai", "view")) ? "设置" : "成员与记录"));
const allowed = (n: NavEntry) =>
  owner.value || !!n.member || (!!n.cap && hasCap(n.cap)) || (!!n.space && capAnywhere(n.space, { own: n.own })) || (!!n.spaces && n.spaces.some((c) => capAnywhere(c, { own: n.own }))) || (!!n.perm && hasPerm(n.perm));
// The owner finds the flow board on the work page (按阶段); everyone else in the nav.
const shownNav = computed(() => nav.value
  .map(n => n.to === "/agents" && !hasPerm("agents.manage") ? reviewEntry : n)
  .filter(allowed).filter(n => !(n.to === "/board" && owner.value)));
// Pages someone other than the owner may open: the nav they see, a line's page under 工作, the graph (Wiki), their account.
const open = computed(() => [...shownNav.value.map((n) => n.to), ...(shownNav.value.some((n) => n.to === "/") ? ["/work"] : []), "/graph", "/account", ...(settingsEntry.value ? ["/settings"] : []),
  // 远程 joins the nav only after asking whether this machine has it: a link opened straight at it is judged before that.
  ...(hasPerm("desktop.control") || hasCap("remote.browser") || hasCap("remote.view") || hasCap("remote.operate") ? ["/remote"] : [])]);
// Landing on a page they cannot use (the start page, an old link) goes to 问答, without drawing it first
// (its requests would only come back refused).
// Until the router has resolved the address the page was opened at (its view loads on demand), the path
// still reads "/": judging then would send a member's deep link to 问答.
const routed = ref(false);
void router.isReady().then(() => (routed.value = true));
const pathOpen = computed(() => owner.value || !state.me || !routed.value || bare.value || (reviewTab.value
  ? allowed(reviewEntry) : open.value.some((p) => route.path === p || route.path.startsWith(p + "/"))));
watch(pathOpen, (ok) => {
  if (!ok) void router.replace("/ask");
});
// A share link is opened by people without a token, the login page before logging in: no frame, nothing else loaded.
const BARE = ["#/share/", "#/login"];
const bare = computed(() => route.path.startsWith("/share/") || route.path === "/login" || route.path === "/cli-login" || (!route.matched.length && [...BARE, "#/cli-login"].some((b) => location.hash.startsWith(b))));
// Live events only with the app frame: a share link is read once, the login pages have nothing to follow.
watch(bare, (b) => setLiveEvents(!b), { immediate: true });
// One remote session on a page of its own (Remote.vue): no sidebar, still logged in, dialogs and toasts.
const solo = computed(() => /^\/remote\/[^/]+/.test(route.path));
onMounted(async () => {
  if (BARE.some((b) => location.hash.startsWith(b))) return;
  window.addEventListener("keydown", onKey);
  try {
    state.me = await get("/api/me");
    setTimeZone(state.me?.timezone);
    await loadSpaces();
    await refreshUnread();
    await addPluginPages();
    void addRemotePage();
  } catch (e) {
    // Going to the login page: nothing failed.
    if (!(e as { login?: boolean }).login) loadError.value = (e as Error).message;
  }
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
watch(
  () => route.path,
  () => {
    menu.value = false;
    state.trail = [];
  },
);
const cycleTheme = () => (state.theme = state.theme === "auto" ? "dark" : state.theme === "dark" ? "light" : "auto");
</script>

<template>
  <router-view v-if="bare" />
  <div v-else-if="solo" class="solo">
    <router-view :key="route.path" />
    <DialogHost />
    <ImagePreview />
    <div class="toasts" aria-live="polite">
      <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.kind"><span>{{ t.text }}</span></div>
    </div>
  </div>
  <div v-else class="shell" :class="{ 'menu-open': menu }">
    <aside class="side">
      <div class="brand row">
        <span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32" width="22" height="22"><rect width="32" height="32" rx="8" fill="currentColor" /><circle cx="16" cy="16" r="7" fill="none" stroke="var(--bg)" stroke-width="3" /></svg></span>
        <strong>omem</strong>
        <span class="spacer" />
        <button class="btn ghost sm icon only-mobile" aria-label="关闭菜单" @click="menu = false"><Icon name="x" /></button>
      </div>

      <div class="space-pick">
        <span class="small muted">空间</span>
        <UiSelect :model-value="state.space" @update:model-value="selectSpace" aria-label="当前空间" :placeholder="state.spaces.length ? '请选择' : '加载中…'" :options="spaceOptions(state.spaces)" />
      </div>

      <button class="search-btn" @click="state.palette = true"><Icon name="search" :size="16" /><span>搜索或提问</span><kbd>Ctrl K</kbd></button>

      <nav>
        <router-link v-for="n in shownNav" :key="n.to" :to="n.to" class="nav" :class="{ on: isActive(n.to, n.exact) }" @mouseenter="preloadRoute(router.resolve(n.to).path)" @focus="preloadRoute(router.resolve(n.to).path)"><Icon :name="n.icon" :size="17" />{{ n.label }}</router-link>
      </nav>

      <div class="spacer" />
      <button class="btn capture" @click="state.capture = true"><Icon name="plus" :size="16" />保存材料<kbd>Ctrl J</kbd></button>
      <div class="foot row">
        <router-link v-if="owner" to="/notifications" class="btn ghost sm icon bell" title="通知" @mouseenter="preloadRoute('/notifications')"><Icon name="bell" :size="17" /><span v-if="state.unread" class="dot">{{ state.unread > 9 ? "9+" : state.unread }}</span></router-link>
        <router-link to="/account" class="btn ghost sm icon" :title="state.me ? `账号：${state.me.name}` : '账号'" @mouseenter="preloadRoute('/account')"><Icon name="user" :size="17" /></router-link>
        <router-link v-if="settingsEntry" to="/settings" class="btn ghost sm icon" :title="settingsLabel" @mouseenter="preloadRoute('/settings')"><Icon name="settings" :size="17" /></router-link>
        <button class="btn ghost sm icon" :title="`主题：${state.theme}`" @click="cycleTheme"><Icon :name="state.theme === 'dark' ? 'moon' : 'sun'" :size="17" /></button>
      </div>
    </aside>
    <div class="scrim" @click="menu = false" />

    <main class="main">
      <div class="topbar only-mobile row">
        <button class="btn ghost icon" aria-label="打开菜单" @click="menu = true"><Icon name="menu" /></button>
        <strong>omem</strong>
        <span class="spacer" />
        <button class="btn ghost icon" aria-label="搜索" @click="state.palette = true"><Icon name="search" /></button>
        <button class="btn ghost icon" aria-label="保存材料" @click="state.capture = true"><Icon name="plus" /></button>
      </div>
      <div v-if="loadError" class="page"><div class="card pad err">无法连接 omem 服务：{{ loadError }}</div></div>
      <!-- A page whose path names the space (/wiki/<space>, /graph/<space>) follows the path: picking a space pushes the new path first. -->
      <router-view v-else-if="state.spaces.length && pathOpen" :key="route.path.split('/')[1] + String(route.params.space || state.space)" />
      <div v-else class="page"><Skeleton variant="text" :rows="8" /></div>
    </main>

    <CitationDrawer />
    <CommandPalette />
    <CaptureDialog />
    <DialogHost />
    <ImagePreview />
    <div class="toasts" aria-live="polite">
      <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.kind">
        <span>{{ t.text }}</span>
        <a v-if="t.link" :href="t.link">查看</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}
.solo {
  height: 100%;
}
.side {
  width: var(--sidebar);
  flex: none;
  border-right: 1px solid var(--line);
  background: var(--sunken);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 12px;
  overflow-y: auto;
}
.brand {
  padding: 2px 6px;
  font-size: 16px;
  gap: 10px;
}
.logo {
  display: flex;
  color: var(--ink);
}
.space-pick {
  display: grid;
  gap: 4px;
  padding: 0 4px;
}
.space-pick :deep(.ui-select) {
  font-weight: 550;
  background: var(--panel);
}
.search-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line-strong);
  background: var(--panel);
  border-radius: 8px;
  padding: 7px 10px;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
}
.search-btn span {
  flex: 1;
}
nav {
  display: grid;
  gap: 1px;
}
.nav {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 7px;
  color: var(--ink-2);
  font-weight: 500;
}
.nav:hover {
  background: var(--hover);
  text-decoration: none;
}
.nav.on {
  background: var(--panel);
  color: var(--ink);
  box-shadow: var(--shadow);
}
.capture {
  justify-content: flex-start;
}
.capture kbd {
  margin-left: auto;
}
.foot {
  gap: 2px;
}
.bell {
  position: relative;
}
.dot {
  position: absolute;
  top: -2px;
  right: -4px;
  background: var(--danger);
  color: white;
  border-radius: 999px;
  font-size: 10px;
  padding: 0 4px;
  line-height: 15px;
}
.main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  position: relative;
}
.err {
  color: var(--danger);
}
.toasts {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  display: grid;
  gap: 8px;
  z-index: 80;
}
.toast {
  background: var(--ink);
  color: var(--bg);
  padding: 9px 14px;
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  display: flex;
  gap: 12px;
  align-items: center;
  max-width: min(560px, 90vw);
}
.toast.error {
  background: var(--danger);
  color: white;
}
.toast a {
  color: inherit;
  text-decoration: underline;
}
.only-mobile,
.scrim {
  display: none;
}
@media (max-width: 860px) {
  .only-mobile {
    display: flex;
  }
  .side {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 50;
    transform: translateX(-100%);
    transition: transform 0.18s;
    width: min(300px, 85vw);
  }
  .menu-open .side {
    transform: none;
  }
  .menu-open .scrim {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: 45;
  }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    padding: 6px 8px;
  }
}
</style>
