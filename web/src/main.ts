import { createApp } from "vue";
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import App from "./App.vue";
import { setNavigation } from "./api";
import { preloadWhenIdle, preloadable } from "./preload";
import { compositionGuard } from "./lib/composition";
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

// After the first view has settled, pull every other chunk at idle.
router.isReady().then(() => preloadWhenIdle(["/", "/ask", "/graph", "/wiki", "/items", "/memory", "/sources", "/sources/kb", "/learn", "/plugin", "/runs", "/remote", "/agents", "/rules", "/rules/archive", "/notifications", "/settings", "/account"]));

createApp(App).use(compositionGuard).use(router).mount("#app");
