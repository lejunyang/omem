import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import { h } from "vue";
import HeroCollage from "./HeroCollage.vue";
import Shot from "./Shot.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  // The home hero's picture: a few screenshots around one another instead of one.
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-image": () => h(HeroCollage) }),
  enhanceApp({ app }) {
    // <Shot src="review-overview" caption="…" />: a screenshot from public/screens, framed like the app's cards.
    app.component("Shot", Shot);
  },
} satisfies Theme;
