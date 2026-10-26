import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Shot from "./Shot.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // <Shot src="review-overview" caption="…" />: a screenshot from public/screens, framed like the app's cards.
    app.component("Shot", Shot);
  },
} satisfies Theme;
