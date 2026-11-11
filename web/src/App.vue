<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CaptureDialog from "./components/CaptureDialog.vue";
import CitationDrawer from "./components/CitationDrawer.vue";
import CommandPalette from "./components/CommandPalette.vue";
import DialogHost from "./components/DialogHost.vue";
import Skeleton from "./components/Skeleton.vue";
import UiSelect from "./components/UiSelect.vue";
import Icon from "./components/Icon.vue";
import { get, setLiveEvents } from "./api";
import { loadSpaces, refreshUnread, state } from "./store";
import { spaceOptions } from "./lib/spaces";
import { preloadRoute } from "./preload";

const route = useRoute();
const router = useRouter();
async function selectSpace(space: string) {
  if (space === state.space) return;
  // Leave the old requirement (and its open work) before the space key remounts the page.
  // A requirement link can still set state.space itself to open its own business tree.
  if (route.path.split("/")[1] === "reqs") await router.replace("/reqs");
  state.space = space;
}
watch(() => state.space, () => {
  const section = route.path.split("/")[1];
  // The knowledge-base list is not per space: it stays.
  if (["ask", "sources", "runs"].includes(section) && route.path !== "/sources/kb") void router.replace(`/${section}`);
});
const menu = ref(false);
const loadError = ref("");
// `member`: pages anyone else can use too (within the spaces they can read); `perm`: a global permission
// that opens the page (src/auth/permissions.ts). The rest is the owner's.
const nav = ref<{ to: string; label: string; icon: string; exact?: boolean; member?: boolean; perm?: string }[]>([
  { to: "/", label: "今日", icon: "home", exact: true },
  { to: "/ask", label: "问答", icon: "chat", member: true },
  { to: "/wiki", label: "Wiki", icon: "book", member: true },
  { to: "/items", label: "事项", icon: "checkbox", member: true },
  { to: "/reqs", label: "需求", icon: "target", member: true },
  { to: "/memory", label: "记忆", icon: "brain", member: true },
  { to: "/sources", label: "原件", icon: "file", member: true },
  { to: "/learn", label: "学习", icon: "cap" },
  { to: "/agents", label: "Agent", icon: "layers", perm: "agents.manage" },
  { to: "/rules", label: "规则", icon: "zap", perm: "agents.manage" },
  { to: "/runs", label: "运行", icon: "activity", member: true },
]);
// Plugins with a page (docs/v2/plugins.md) go right after 学习.
async function addPluginPages() {
  const plugins = await get<{ id: string; icon: string; page: { title: string } | null }[]>("/api/plugins").catch(() => []);
  const rest = nav.value.filter((n) => !n.to.startsWith("/plugin/"));
  const at = rest.findIndex((n) => n.to === "/learn") + 1;
  rest.splice(at, 0, ...plugins.filter((p) => p.page).map((p) => ({ to: `/plugin/${p.id}`, label: p.page!.title, icon: p.icon, member: true })));
  nav.value = rest;
}
// Remote operation (views/Remote.vue) only where this machine has ai-auto-desktop installed.
async function addRemotePage() {
  if (!owner.value && !state.me?.perms.includes("desktop.control")) return;
  const r = await get<{ available: boolean }>("/api/remote").catch(() => ({ available: false }));
  if (r.available && !nav.value.some((n) => n.to === "/remote")) nav.value = [...nav.value, { to: "/remote", label: "远程", icon: "monitor", perm: "desktop.control" }];
}
// Settings → 插件 changed an icon.
watch(() => state.pluginsChanged, addPluginPages);
const isActive = (to: string, exact?: boolean) =>
  exact ? route.path === to : route.path === to || route.path.startsWith(to + "/") || (to === "/wiki" && route.path.startsWith("/graph"));

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
const allowed = (n: { member?: boolean; perm?: string }) => owner.value || n.member || (!!n.perm && !!state.me?.perms.includes(n.perm));
const shownNav = computed(() => nav.value.filter(allowed));
// Pages someone other than the owner may open: the nav they see, the graph (Wiki), their account.
const open = computed(() => [...shownNav.value.map((n) => n.to), "/graph", "/account"]);
// Landing on a page they cannot use (the start page, an old link) goes to 问答.
watch([() => route.path, owner], ([path]) => {
  if (!owner.value && state.me && !bare.value && !open.value.some((p) => path === p || path.startsWith(p + "/"))) void router.replace("/ask");
});
// A share link is opened by people without a token, the login page before logging in: no frame, nothing else loaded.
const BARE = ["#/share/", "#/login"];
const bare = computed(() => route.path.startsWith("/share/") || route.path === "/login" || route.path === "/cli-login" || (!route.matched.length && [...BARE, "#/cli-login"].some((b) => location.hash.startsWith(b))));
// Live events only with the app frame: a share link is read once, the login pages have nothing to follow.
watch(bare, (b) => setLiveEvents(!b), { immediate: true });
onMounted(async () => {
  if (BARE.some((b) => location.hash.startsWith(b))) return;
  window.addEventListener("keydown", onKey);
  try {
    state.me = await get("/api/me");
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
        <router-link v-for="n in shownNav" :key="n.to" :to="n.to" class="nav" :class="{ on: isActive(n.to, n.exact) }" @mouseenter="preloadRoute(n.to)" @focus="preloadRoute(n.to)"><Icon :name="n.icon" :size="17" />{{ n.label }}</router-link>
      </nav>

      <div class="spacer" />
      <button class="btn capture" @click="state.capture = true"><Icon name="plus" :size="16" />保存材料<kbd>Ctrl J</kbd></button>
      <div class="foot row">
        <router-link v-if="owner" to="/notifications" class="btn ghost sm icon bell" title="通知" @mouseenter="preloadRoute('/notifications')"><Icon name="bell" :size="17" /><span v-if="state.unread" class="dot">{{ state.unread > 9 ? "9+" : state.unread }}</span></router-link>
        <router-link to="/account" class="btn ghost sm icon" :title="state.me ? `账号：${state.me.name}` : '账号'" @mouseenter="preloadRoute('/account')"><Icon name="user" :size="17" /></router-link>
        <router-link v-if="owner" to="/settings" class="btn ghost sm icon" title="设置" @mouseenter="preloadRoute('/settings')"><Icon name="settings" :size="17" /></router-link>
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
      <router-view v-else-if="state.spaces.length" :key="route.path.split('/')[1] + String(route.params.space || state.space)" />
      <div v-else class="page"><Skeleton variant="text" :rows="8" /></div>
    </main>

    <CitationDrawer />
    <CommandPalette />
    <CaptureDialog />
    <DialogHost />
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
