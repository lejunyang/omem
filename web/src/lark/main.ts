import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import "../styles.css";
import LarkApp from "./LarkApp.vue";

/**
 * The Feishu web app (`/lark/`, docs/v2/interactive-ui.md): opened from a card in Feishu's sidebar, it
 * signs in with the code Feishu gives (`tt.requestAccess`) and shows one question or view
 * (`#/ui/<id>`) with the same components as the main site. Nothing else lives here.
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/ui/:id", component: () => import("../views/UiItem.vue") },
    { path: "/:rest(.*)*", component: () => import("./LarkHome.vue") },
  ],
});
createApp(LarkApp).use(router).mount("#app");
