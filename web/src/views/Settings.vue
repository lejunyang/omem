<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { state } from "../store";
import { provideSettings } from "./settings/ctx";
import Skeleton from "../components/Skeleton.vue";
import UiSegmented from "../components/UiSegmented.vue";
import ApprovalSettings from "../components/ApprovalSettings.vue";
import CommandRulesSettings from "../components/CommandRulesSettings.vue";

/**
 * The settings page: the categories on the left (by what the owner is thinking about), the open one in
 * the middle (each a component in views/settings/, loaded when first opened), its cards on the right.
 * The configuration is loaded once here and shared with the tabs (settings/ctx.ts).
 */
type Tab = "spaces" | "connect" | "search" | "storage" | "notify" | "reply" | "advance" | "review" | "schedules" | "agents" | "plugins" | "lark" | "members" | "peers" | "shares" | "security" | "about";
const NAV: { label: string; tabs: [Tab, string][] }[] = [
  { label: "知识", tabs: [["spaces", "空间"], ["connect", "采集"], ["search", "检索与记忆"], ["storage", "占用"]] },
  { label: "助手", tabs: [["notify", "通知与打扰"], ["reply", "代你回复"], ["advance", "推进工作"], ["review", "自检与复盘"], ["schedules", "定时任务"]] },
  { label: "AI", tabs: [["agents", "后端与模型"], ["plugins", "插件"]] },
  { label: "渠道与协作", tabs: [["lark", "渠道"], ["members", "成员"], ["peers", "设备"], ["shares", "分享"]] },
  { label: "系统", tabs: [["security", "安全"], ["about", "外观与说明"]] },
];
const TABS = NAV.flatMap((g) => g.tabs.map(([t]) => t));
const VIEWS: Partial<Record<Tab, ReturnType<typeof defineAsyncComponent>>> = {
  spaces: defineAsyncComponent(() => import("./settings/Spaces.vue")),
  connect: defineAsyncComponent(() => import("./settings/Connect.vue")),
  search: defineAsyncComponent(() => import("./settings/Search.vue")),
  storage: defineAsyncComponent(() => import("../components/StorageUsage.vue")),
  notify: defineAsyncComponent(() => import("./settings/Notify.vue")),
  reply: defineAsyncComponent(() => import("./settings/Reply.vue")),
  advance: defineAsyncComponent(() => import("./settings/Advance.vue")),
  review: defineAsyncComponent(() => import("./settings/Review.vue")),
  schedules: defineAsyncComponent(() => import("./settings/Schedules.vue")),
  agents: defineAsyncComponent(() => import("./settings/Agents.vue")),
  plugins: defineAsyncComponent(() => import("../components/PluginsSettings.vue")),
  lark: defineAsyncComponent(() => import("./settings/Lark.vue")),
  members: defineAsyncComponent(() => import("./settings/Members.vue")),
  peers: defineAsyncComponent(() => import("./settings/Peers.vue")),
  shares: defineAsyncComponent(() => import("../components/ShareSettings.vue")),
};
/**
 * Cards that can be linked to (`?card=<id>`, the card's element id is `set-<id>`), by the tab they are in.
 * Cards that moved keep working from the old links: `?tab=lark&focus=mentions` and the like.
 */
const CARDS: Record<string, Tab> = {
  mentions: "reply", guests: "reply", commands: "reply", invite: "reply", "reply-check": "reply", "reply-outcome": "reply",
  "notify-times": "notify", progress: "notify",
  "auto-advance": "advance", "flow-follow": "advance", "gate-ladder": "advance", "commit-claim": "advance", design: "advance", "study-envs": "advance", "item-expiry": "advance",
  audit: "review", replay: "review",
  backends: "agents", tiers: "agents", fallback: "agents",
  "memory-quality": "search", rerank: "search", embeddings: "search", "passive-memory": "search",
  "agent-accounts": "members", desktop: "peers", "web-url": "peers",
  "lark-docs": "connect", "lark-capture": "connect", platforms: "connect",
  timezone: "schedules",
};
const route = useRoute();
const router = useRouter();
/** Where a link points: its tab, and the card to scroll to (from `card`, or an old link's `focus`). */
function target(q: typeof route.query): { tab: Tab; card: string | null } {
  const raw = typeof q.card === "string" ? q.card : typeof q.focus === "string" ? q.focus : null;
  const card = raw === "network-conditions" ? "backends" : raw;
  const asked = typeof q.tab === "string" && TABS.includes(q.tab as Tab) ? (q.tab as Tab) : null;
  if (card && CARDS[card]) return { tab: CARDS[card], card };
  // The AI sub-sections (?section=decision) are in 后端与模型.
  if (!asked && typeof q.section === "string") return { tab: "agents", card: null };
  return { tab: asked ?? "spaces", card };
}
const first = target(route.query);
const tab = ref<Tab>(first.tab);
let pendingCard: string | null = first.card;
function show(t: Tab) {
  if (tab.value === t) return;
  tab.value = t;
  void router.replace({ query: { tab: t } });
}
// A link to another tab or card while the page is open (the same route, so no remount).
watch(
  () => route.query,
  (q) => {
    const t = target(q);
    tab.value = t.tab;
    if (t.card) {
      pendingCard = t.card;
      scrollToCard();
    }
  },
);
/** Scroll to the linked card once it is rendered (the tab loads on its own, its cards after their data). */
function scrollToCard(tries = 0) {
  if (!pendingCard) return;
  const el = document.getElementById(`set-${pendingCard}`);
  if (el) {
    el.scrollIntoView({ block: "start" });
    pendingCard = null;
  } else if (tries < 40) window.setTimeout(() => scrollToCard(tries + 1), 100);
}

const { config, home, load, saveConfig } = provideSettings();

// The page's own contents (the right column): the cards of the open tab, by their titles. Read from
// what is rendered, so cards of the sub-components (members, devices, plugins…) are listed too.
const content = ref<HTMLElement>();
const toc = ref<{ id: string; title: string }[]>([]);
const tocAt = ref("");
let tocTimer = 0;
let tocWatch: MutationObserver | null = null;
let tocSpy: IntersectionObserver | null = null;
function buildToc() {
  const el = content.value;
  if (!el) return;
  const out: { id: string; title: string }[] = [];
  let i = 0;
  for (const card of el.querySelectorAll<HTMLElement>(".card")) {
    if (card.parentElement?.closest(".card") || card.closest(".modal") || card.closest("[data-no-toc]")) continue;
    const head = card.firstElementChild;
    // A card's title: its .set-title, or a <strong> / .section-title first in it or inside its first row.
    const heading = head?.matches("strong, .section-title, .set-title") ? head : head?.querySelector(".set-title, strong, .section-title");
    const title = (heading?.textContent ?? "").trim();
    if (!title || title.length > 24) continue;
    card.id ||= `set-${tab.value}-${i++}`;
    out.push({ id: card.id, title });
  }
  toc.value = out.length > 1 ? out : [];
  tocSpy?.disconnect();
  tocSpy = new IntersectionObserver((entries) => {
    const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (top) tocAt.value = top.target.id;
  }, { rootMargin: "-8% 0px -70% 0px" });
  for (const t of out) tocSpy.observe(document.getElementById(t.id)!);
}
const tocSoon = () => {
  clearTimeout(tocTimer);
  tocTimer = window.setTimeout(buildToc, 150);
};
function goCard(id: string) {
  tocAt.value = id;
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
watch(tab, () => {
  // The open category stays in sight in the narrow layout's scrolling row.
  void nextTick(() => document.querySelector(".set-nav button.on")?.scrollIntoView({ block: "nearest", inline: "center" }));
}, { immediate: true });
onMounted(() => {
  tocWatch = new MutationObserver(tocSoon);
  if (content.value) tocWatch.observe(content.value, { childList: true, subtree: true });
  tocSoon();
  void load().then(() => scrollToCard());
});
onBeforeUnmount(() => {
  tocWatch?.disconnect();
  tocSpy?.disconnect();
  clearTimeout(tocTimer);
});
</script>

<template>
  <div class="page settings">
    <div class="page-head"><div><h1>设置</h1><p v-if="home" class="mono small muted">数据目录：{{ home }}</p></div></div>
    <div class="set-layout">
      <nav class="set-nav" aria-label="设置分类">
        <div v-for="g in NAV" :key="g.label" class="group">
          <span>{{ g.label }}</span>
          <button v-for="[k, l] in g.tabs" :key="k" type="button" :class="{ on: tab === k }" :aria-current="tab === k ? 'page' : undefined" @click="show(k)">{{ l }}</button>
        </div>
      </nav>
      <div ref="content" class="set-content">
        <section v-if="tab === 'security'" class="stack">
          <ApprovalSettings v-if="config && (!state.me || state.me.role === 'owner')" :config="config" :save="saveConfig" />
          <CommandRulesSettings />
        </section>
        <section v-else-if="tab === 'about'" class="stack">
          <div class="card set-card">
            <header class="set-card-head"><h3 class="set-title">外观</h3></header>
            <div class="set-row">
              <div class="set-row-text"><div class="set-row-label">主题</div></div>
              <div class="set-row-ctl"><UiSegmented v-model="state.theme" size="sm" aria-label="主题" :options="[{ value: 'auto', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]" /></div>
            </div>
          </div>
          <div class="card set-card">
            <header class="set-card-head"><h3 class="set-title">快捷键与接入</h3></header>
            <div class="set-pad small">
              <div><kbd>Ctrl K</kbd> 搜索或提问 · <kbd>Ctrl J</kbd> 保存材料 · <kbd>Esc</kbd> 关闭引用层</div>
              <div class="muted">omem 也可以作为 MCP 服务给其他 Agent 使用：<span class="mono">omem mcp</span>（加 <span class="mono">--read-only</span> 只开放读取）。</div>
            </div>
          </div>
        </section>
        <section v-else class="stack">
          <component :is="VIEWS[tab]" v-if="VIEWS[tab]" :key="tab" />
          <Skeleton v-else :rows="4" />
        </section>
      </div>
      <aside v-if="toc.length" class="set-toc" aria-label="本页内容">
        <span class="muted small">本页</span>
        <a v-for="t in toc" :key="t.id" href="#" :class="{ on: tocAt === t.id }" @click.prevent="goCard(t.id)">{{ t.title }}</a>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* Categories on the left, the open one in the middle, its cards listed on the right. */
.settings {
  max-width: 1320px;
}
.set-layout {
  display: grid;
  grid-template-columns: 136px minmax(0, 1fr) 160px;
  gap: 32px;
  align-items: start;
}
.set-content {
  min-width: 0;
  max-width: 880px;
}
.set-nav {
  position: sticky;
  top: 12px;
  display: grid;
  gap: 16px;
}
.set-nav .group {
  display: grid;
  gap: 1px;
}
.set-nav .group > span {
  padding: 0 10px 4px;
  font-size: 12px;
  color: var(--muted);
}
.set-nav button {
  border: 0;
  background: none;
  padding: 6px 10px;
  border-radius: 7px;
  text-align: left;
  font-size: 14px;
  color: var(--ink-2);
  cursor: pointer;
  white-space: nowrap;
}
.set-nav button:hover {
  background: var(--hover);
}
.set-nav button.on {
  background: var(--panel);
  box-shadow: var(--shadow);
  color: var(--ink);
  font-weight: 550;
}
.set-toc {
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  display: grid;
  gap: 2px;
  padding-left: 12px;
  border-left: 1px solid var(--line);
  font-size: 13px;
}
.set-toc > span {
  padding-bottom: 4px;
}
.set-toc a {
  padding: 4px 0;
  color: var(--muted);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.set-toc a:hover {
  color: var(--ink);
}
.set-toc a.on {
  color: var(--accent);
}
.set-content :deep(.card) {
  scroll-margin-top: 12px;
}
/* Cards of the older sub-components title themselves with a small grey .section-title or a <strong>:
   in the settings they read as the same 15px card title as SetCard's. */
.set-content :deep(.card.pad > .section-title:first-child),
.set-content :deep(.card.pad > strong:first-child),
.set-content :deep(.card.pad > .row:first-child > .section-title),
.set-content :deep(.card.pad > .row:first-child > strong:first-child) {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0;
  color: var(--ink);
}
@media (max-width: 1200px) {
  .set-layout {
    grid-template-columns: 136px minmax(0, 1fr);
  }
  .set-toc {
    display: none;
  }
}
@media (max-width: 760px) {
  .set-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .set-nav {
    position: static;
    display: flex;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid var(--line);
    padding-bottom: 8px;
  }
  .set-nav .group {
    display: contents;
  }
  .set-nav .group > span {
    display: none;
  }
}
</style>
