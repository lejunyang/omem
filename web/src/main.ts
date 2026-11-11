import { createApp } from "vue";
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import App from "./App.vue";
import { setNavigation } from "./api";
import { preloadWhenIdle, preloadable } from "./preload";
import { compositionGuard } from "./lib/composition";
import { toast } from "./store";
import "./styles.css";

// `pattern` is the router pattern; `key` is the nav base used for hover/idle preloading.
const view = (pattern: string, loader: () => Promise<unknown>, key = pattern.replace(/^(\/[^/:]*).*$/, "$1")): RouteRecordRaw =>
  ({ path: pattern, component: preloadable(key, loader) } as unknown as RouteRecordRaw);

const routes: RouteRecordRaw[] = [
  view("/", () => import("./views/Home.vue")),
  view("/ask/:id?", () => import("./views/Ask.vue"), "/ask"),
  view("/ui/:id", () => import("./views/UiItem.vue"), "/ui"),
  view("/graph/:space?", () => import("./views/Graph.vue"), "/graph"),
  view("/wiki/:space?/:slug(.*)*", () => import("./views/Wiki.vue"), "/wiki"),
  view("/items/:id?", () => import("./views/Items.vue"), "/items"),
  view("/reqs/:id?", () => import("./views/Requirements.vue"), "/reqs"),
  view("/designs", () => import("./views/Designs.vue")),
  view("/design/:id", () => import("./views/Design.vue"), "/design"),
  view("/memory", () => import("./views/Memory.vue")),
  view("/sources/kb", () => import("./views/KnowledgeBases.vue"), "/sources/kb"),
  view("/sources/:id?", () => import("./views/Sources.vue"), "/sources"),
  view("/learn", () => import("./views/Learn.vue")),
  view("/speaking", () => import("./views/Speaking.vue")),
  view("/plugin/:id", () => import("./views/Plugin.vue"), "/plugin"),
  view("/runs/:id?", () => import("./views/Runs.vue"), "/runs"),
  view("/remote", () => import("./views/Remote.vue")),
  view("/agents", () => import("./views/Agents.vue")),
  view("/rules/archive", () => import("./views/ArchiveRules.vue"), "/rules/archive"),
  { path: "/rules/tasks", redirect: (to) => ({ path: "/rules", query: to.query }) },
  view("/rules", () => import("./views/Rules.vue")),
  view("/notifications", () => import("./views/Notifications.vue")),
  view("/settings", () => import("./views/Settings.vue")),
  view("/account", () => import("./views/Account.vue")),
  // Logging in (src/auth): like a share link, shown without the app frame.
  view("/login", () => import("./views/Login.vue")),
  // `omem login <地址>` asks here (docs/v2/remote-clients.md); also without the app frame.
  view("/cli-login", () => import("./views/CliLogin.vue")),
  // A read-only share link (no token, no app frame): App.vue renders it alone.
  view("/share/:token/:item?", () => import("./views/Share.vue"), "/share"),
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

setNavigation((to) => void router.isReady().then(() => router.replace(to)));

// After the first view has settled, pull every other chunk at idle; a share link or a login page
// (opened by someone who may never see the app) does not.
const BARE_START = /^\/(share\/|login|cli-login)/;
router.isReady().then(() => !BARE_START.test(router.currentRoute.value.path) && preloadWhenIdle(["/", "/ask", "/graph", "/wiki", "/items", "/designs", "/design", "/memory", "/sources", "/sources/kb", "/learn", "/plugin", "/runs", "/remote", "/agents", "/rules", "/rules/archive", "/notifications", "/settings", "/account"]));

// After the service is updated, chunks the open page knows by their old names are gone. Opening a
// view that needs one reloads once (the new index points at the new chunks); a part of a page that
// loads its own code later (diagrams, the editor) says so instead of failing without a word.
const CHUNK_GONE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
router.onError((e, to) => {
  if (!CHUNK_GONE.test(String((e as Error)?.message ?? e))) return;
  const last = Number(sessionStorage.getItem("omem:chunk-reload") ?? 0);
  if (Date.now() - last < 30_000) return;
  sessionStorage.setItem("omem:chunk-reload", String(Date.now()));
  location.hash = to.fullPath;
  location.reload();
});
let chunkNoticeShown = false;
window.addEventListener("vite:preloadError", () => {
  if (chunkNoticeShown) return;
  chunkNoticeShown = true;
  toast("omem 更新过，这一页有部分内容没加载出来：刷新页面后再看", "error");
});

createApp(App).use(compositionGuard).use(router).mount("#app");
