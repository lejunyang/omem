import "./panel.css";
import { createApp } from "vue";
import App from "./App.vue";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) {
  throw new Error("Missing #app root.");
}

createApp(App).mount(root);
