import { createApp } from "vue";
import App from "./App.vue";
import { compositionGuard } from "../../../web/src/lib/composition";
import "../../../web/src/styles.css";
import "./style.css";

createApp(App).use(compositionGuard).mount("#app");
