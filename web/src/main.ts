import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import "./styles.css";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: () => import("./views/Home.vue") },
    { path: "/ask/:id?", component: () => import("./views/Ask.vue") },
    { path: "/graph/:space?", component: () => import("./views/Graph.vue") },
    { path: "/wiki/:space?/:slug(.*)*", component: () => import("./views/Wiki.vue") },
    { path: "/items/:id?", component: () => import("./views/Items.vue") },
    { path: "/memory", component: () => import("./views/Memory.vue") },
    { path: "/sources/:id?", component: () => import("./views/Sources.vue") },
    { path: "/learn", component: () => import("./views/Learn.vue") },
    { path: "/runs/:id?", component: () => import("./views/Runs.vue") },
    { path: "/notifications", component: () => import("./views/Notifications.vue") },
    { path: "/settings", component: () => import("./views/Settings.vue") },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

createApp(App).use(router).mount("#app");
