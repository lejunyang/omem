import { createApp } from "vue";
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import App from "./App.vue";
import { preloadWhenIdle, preloadable } from "./preload";
import "./styles.css";

// `pattern` is the router pattern; `key` is the nav base used for hover/idle preloading.
const view = (pattern: string, loader: () => Promise<unknown>, key = pattern.replace(/\/.*/, "")): RouteRecordRaw =>
  ({ path: pattern, component: preloadable(key || "/", loader) } as unknown as RouteRecordRaw);

const routes: RouteRecordRaw[] = [
  view("/", () => import("./views/Home.vue")),
  view("/ask/:id?", () => import("./views/Ask.vue"), "/ask"),
  view("/graph/:space?", () => import("./views/Graph.vue"), "/graph"),
  view("/wiki/:space?/:slug(.*)*", () => import("./views/Wiki.vue"), "/wiki"),
  view("/items/:id?", () => import("./views/Items.vue"), "/items"),
  view("/memory", () => import("./views/Memory.vue")),
  view("/sources/:id?", () => import("./views/Sources.vue"), "/sources"),
  view("/learn", () => import("./views/Learn.vue")),
  view("/runs/:id?", () => import("./views/Runs.vue"), "/runs"),
  view("/agents", () => import("./views/Agents.vue")),
  view("/notifications", () => import("./views/Notifications.vue")),
  view("/settings", () => import("./views/Settings.vue")),
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

// After the first view has settled, pull every other chunk at idle.
router.isReady().then(() => preloadWhenIdle(["/", "/ask", "/graph", "/wiki", "/items", "/memory", "/sources", "/learn", "/runs", "/agents", "/notifications", "/settings"]));

createApp(App).use(router).mount("#app");
