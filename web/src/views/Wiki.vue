<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { del, get, onServerEvent, post, put, type Run } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import { confirmDialog } from "../lib/dialog";
import Markdown from "../components/Markdown.vue";
import { fmtTime, openCitation, relTime, runKindLabel, state, statusLabel, toast } from "../store";

type NavNode = { slug?: string; title: string; children: NavNode[] };
type PageSummary = { slug: string; title: string; summary: string; kind: string; updatedAt: string; staleSources: number };
type PageData = {
  id: string;
  spaceId: string;
  slug: string;
  meta: { title: string; summary?: string; kind?: string; updated?: string };
  body: string;
  updatedAt: string;
  context: {
    backlinks: { spaceId: string; slug: string; title: string }[];
    sources: { sourceId: string; uri: string; title: string; lineStart: number | null; lineEnd: number | null; stale: boolean; deleted: boolean }[];
    missingLinks: string[];
    history: { hash: string; at: string; message: string }[];
  };
};

const route = useRoute();
const router = useRouter();
const space = computed(() => (route.params.space as string) || state.space);
const slug = computed(() => {
  const s = route.params.slug;
  return Array.isArray(s) ? s.join("/") : s || "";
});
const nav = ref<NavNode[]>([]);
const pages = ref<PageSummary[]>([]);
const stale = ref(0);
const page = ref<PageData | null>(null);
const notFound = ref(false);
const toc = ref<{ id: string; text: string; level: number }[]>([]);
const filter = ref("");
const runs = ref<Run[]>([]);
const editing = ref(false);
const draft = ref({ title: "", summary: "", body: "" });
const rewriteOpen = ref(false);
const rewriteNote = ref("");
const planOpen = ref(false);
const newOpen = ref(false);
const newPage = ref({ title: "", question: "", outline: "", slug: "" });
const planFocus = ref("");
const navOpen = ref(false);
const version = ref<{ hash: string; diff: string } | null>(null);

if (!route.params.space) router.replace(`/wiki/${state.space}`);
else if (route.params.space !== state.space && state.spaces.some((x) => x.id === route.params.space)) state.space = route.params.space as string;
watch(
  () => state.space,
  (s) => {
    if (s !== route.params.space) router.push(`/wiki/${s}`);
  },
);

const spaceLoading = ref(true);
const pageLoading = ref(false);
async function loadSpace() {
  const r = await get<{ nav: NavNode[]; pages: PageSummary[]; stale: number }>(`/api/wiki/${space.value}`);
  nav.value = r.nav;
  pages.value = r.pages;
  stale.value = r.stale;
  runs.value = (await get<{ runs: Run[] }>(`/api/runs?space=${space.value}&limit=30`)).runs.filter((x) => x.kind.startsWith("wiki-") && ["queued", "running"].includes(x.status));
}
async function loadPage() {
  editing.value = false;
  version.value = null;
  notFound.value = false;
  const target = slug.value || (pages.value.some((p) => p.slug === "index") ? "index" : "");
  if (!target) return void (page.value = null);
  if (!page.value || page.value.slug !== target) pageLoading.value = true;
  try {
    page.value = await get<PageData>(`/api/wiki/${space.value}/page/${target}`);
  } catch {
    page.value = null;
    notFound.value = true;
  } finally {
    pageLoading.value = false;
  }
}
watch(
  space,
  async () => {
    spaceLoading.value = true;
    try {
      await loadSpace();
    } finally {
      spaceLoading.value = false;
    }
    await loadPage();
  },
  { immediate: true },
);
watch(slug, loadPage);

const off = onServerEvent((e) => {
  if (e.type === "changed" && e.entity === "page" && e.spaceId === space.value) {
    void loadSpace();
    if (page.value && e.id === page.value.id && !editing.value) void loadPage();
  }
  if (e.type === "run") void loadSpace();
});
onBeforeUnmount(() => off());

function onRendered(el: HTMLElement) {
  toc.value = [...el.querySelectorAll<HTMLElement>("h2, h3")].map((h) => ({ id: h.id, text: h.textContent ?? "", level: h.tagName === "H2" ? 2 : 3 }));
}
function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const filteredNav = computed(() => {
  const f = filter.value.trim().toLowerCase();
  if (!f) return nav.value;
  const keep = (n: NavNode): NavNode | null => {
    const kids = n.children.map(keep).filter(Boolean) as NavNode[];
    return n.title.toLowerCase().includes(f) || (n.slug ?? "").includes(f) || kids.length ? { ...n, children: kids } : null;
  };
  return nav.value.map(keep).filter(Boolean) as NavNode[];
});
const slugs = computed(() => pages.value.map((p) => p.slug));
const currentSlug = computed(() => page.value?.slug ?? "");
const staleSources = computed(() => page.value?.context.sources.filter((s) => s.stale || s.deleted) ?? []);
const section = computed(() => {
  const find = (ns: NavNode[], path: string[]): string[] | null => {
    for (const n of ns) {
      if (n.slug === currentSlug.value) return path;
      const r = find(n.children, n.slug ? path : [...path, n.title]);
      if (r) return r;
    }
    return null;
  };
  return find(nav.value, []) ?? [];
});

function startEdit() {
  if (!page.value) return;
  draft.value = { title: page.value.meta.title, summary: page.value.meta.summary ?? "", body: page.value.body };
  editing.value = true;
}
async function saveEdit() {
  if (!page.value) return;
  await put(`/api/wiki/${space.value}/page/${page.value.slug}`, { ...draft.value, kind: page.value.meta.kind });
  toast("已保存（已记入页面历史）", "ok");
  await loadPage();
}
async function remove() {
  if (!page.value || !(await confirmDialog(`删除页面「${page.value.meta.title}」？`, { message: "历史仍保留在 Git 中。", okText: "删除", danger: true }))) return;
  await del(`/api/wiki/${space.value}/page/${page.value.slug}`);
  router.push(`/wiki/${space.value}`);
}
async function rewrite() {
  if (!page.value) return;
  const p = page.value;
  await post(`/api/wiki/${space.value}/write`, {
    slug: p.slug,
    title: p.meta.title,
    kind: p.meta.kind ?? "guide",
    question: p.meta.summary || p.meta.title,
    outline: "",
    entry_points: p.context.sources.map((s) => s.uri),
    instructions: rewriteNote.value || undefined,
  });
  rewriteOpen.value = false;
  rewriteNote.value = "";
  toast("已安排重写，完成后自动刷新", "ok");
  void loadSpace();
}
async function createPage() {
  const slug = newPage.value.slug.trim() || newPage.value.title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60);
  await post(`/api/wiki/${space.value}/write`, { slug, title: newPage.value.title, question: newPage.value.question, outline: newPage.value.outline, kind: "guide", entry_points: [] });
  newOpen.value = false;
  newPage.value = { title: "", question: "", outline: "", slug: "" };
  toast("助理开始调查并写作这一页", "ok");
  void loadSpace();
}
async function plan() {
  await post(`/api/wiki/${space.value}/plan`, { focus: planFocus.value || undefined, autoWrite: true });
  planOpen.value = false;
  toast("助理开始调查并规划目录，之后会逐页写作", "ok");
  void loadSpace();
}
async function lint() {
  await post(`/api/wiki/${space.value}/lint`);
  toast("已安排检查受影响的页面", "ok");
  void loadSpace();
}
async function showVersion(hash: string) {
  if (!page.value) return;
  const v = await get<{ diff: string }>(`/api/wiki/${space.value}/page/${page.value.slug}?version=${hash}`);
  version.value = { hash, diff: v.diff };
}
const spaceName = computed(() => state.spaces.find((s) => s.id === space.value)?.name ?? space.value);
</script>

<template>
  <div class="wiki" :class="{ 'nav-open': navOpen }">
    <aside class="nav">
      <div class="nav-head">
        <div class="row">
          <strong class="ellipsis">{{ spaceName }}</strong>
          <span class="spacer" />
          <router-link :to="`/graph/${space}`" class="btn ghost sm icon" title="页面关系图"><Icon name="graph" :size="16" /></router-link>
          <button class="btn ghost sm icon" title="写一页新文章" @click="newOpen = true"><Icon name="plus" :size="16" /></button>
          <button class="btn ghost sm icon" title="规划/更新目录" @click="planOpen = true"><Icon name="sparkles" :size="16" /></button>
        </div>
        <input v-model="filter" class="input filter" placeholder="筛选页面" />
      </div>
      <div class="tree">
        <template v-for="(n, i) in filteredNav" :key="i">
          <div v-if="!n.slug" class="group">{{ n.title }}</div>
          <router-link v-else :to="`/wiki/${space}/${n.slug}`" class="node" :class="{ on: n.slug === currentSlug }" @click="navOpen = false">{{ n.title }}</router-link>
          <template v-for="(c, j) in n.children" :key="`${i}-${j}`">
            <router-link v-if="c.slug" :to="`/wiki/${space}/${c.slug}`" class="node" :class="{ on: c.slug === currentSlug, sub: !!n.slug }" @click="navOpen = false">{{ c.title }}</router-link>
            <div v-else class="node muted" :class="{ sub: !!n.slug }">{{ c.title }}</div>
            <router-link v-for="(g, k) in c.children.filter((x) => x.slug)" :key="`${i}-${j}-${k}`" :to="`/wiki/${space}/${g.slug}`" class="node sub2" :class="{ on: g.slug === currentSlug }">{{ g.title }}</router-link>
          </template>
        </template>
        <Skeleton v-if="spaceLoading && !pages.length" :rows="8" variant="lines" />
        <div v-else-if="!pages.length" class="muted small pad">还没有页面</div>
      </div>
      <div v-if="runs.length" class="running">
        <div class="section-title">进行中</div>
        <router-link v-for="r in runs" :key="r.id" :to="`/runs/${r.id}`" class="node small"><span class="spin" />{{ r.title }}</router-link>
      </div>
      <button v-if="stale" class="btn sm stale-btn" @click="lint"><Icon name="refresh" :size="14" />{{ stale }} 页的原件已变化 · 检查</button>
    </aside>

    <main class="content">
      <div class="mobile-bar row">
        <button class="btn sm" @click="navOpen = !navOpen"><Icon name="menu" :size="15" />目录</button>
      </div>

      <div v-if="(spaceLoading && !pages.length) || pageLoading" class="page-loading"><Skeleton variant="text" :rows="12" /></div>
      <div v-else-if="!pages.length && !page" class="empty">
        <Icon name="book" :size="36" />
        <h3>「{{ spaceName }}」还没有 Wiki</h3>
        <p>助理会先调查这个空间的全部材料（代码仓库会读入口、流程和测试），按读者问题规划一套目录，再逐页写作并引用原文。</p>
        <button class="btn primary" @click="planOpen = true"><Icon name="sparkles" :size="16" />规划并生成 Wiki</button>
        <div v-if="runs.length" class="muted small" style="margin-top: 12px">已有 {{ runs.length }} 个整理任务在进行中。</div>
      </div>

      <div v-else-if="notFound" class="empty">
        <h3>页面不存在：{{ slug }}</h3>
        <p>可能还在写作中，或者链接指向了一个尚未创建的页面。</p>
        <router-link :to="`/wiki/${space}`" class="btn">返回目录</router-link>
      </div>

      <div v-else-if="!page" class="overview">
        <h1>{{ spaceName }}</h1>
        <div class="cards">
          <router-link v-for="p in pages" :key="p.slug" :to="`/wiki/${space}/${p.slug}`" class="card pad pcard">
            <strong>{{ p.title }}</strong>
            <span class="muted small clamp">{{ p.summary }}</span>
          </router-link>
        </div>
      </div>

      <article v-else-if="editing" class="article editor">
        <input v-model="draft.title" class="input title-input" />
        <input v-model="draft.summary" class="input" placeholder="摘要：读者读完能得到什么" />
        <textarea v-model="draft.body" class="textarea body-input" spellcheck="false" />
        <div class="row">
          <span class="muted small">支持 Markdown、[[页面链接]]、[说明](src:原件id#L1-L5) 引用、mermaid 图。</span>
          <span class="spacer" />
          <button class="btn" @click="editing = false">取消</button>
          <button class="btn primary" @click="saveEdit">保存</button>
        </div>
      </article>

      <article v-else class="article">
        <div class="crumbs muted small">
          <router-link :to="`/wiki/${space}`">{{ spaceName }}</router-link>
          <template v-for="s in section" :key="s"> / {{ s }}</template>
        </div>
        <h1 class="title">{{ page.meta.title }}</h1>
        <p v-if="page.meta.summary" class="lead">{{ page.meta.summary }}</p>
        <div class="meta row wrap">
          <span class="muted small">更新于 {{ page.meta.updated ?? fmtTime(page.updatedAt, false) }}</span>
          <span v-if="page.context.sources.length" class="muted small">· 引用 {{ page.context.sources.length }} 份原件</span>
          <span v-if="staleSources.length" class="badge warn" :title="staleSources.map((s) => s.uri).join('\n')"><Icon name="alert" :size="12" />{{ staleSources.length }} 份原件已变化</span>
          <span class="spacer" />
          <button class="btn ghost sm" @click="startEdit"><Icon name="edit" :size="14" />编辑</button>
          <button class="btn ghost sm" @click="rewriteOpen = true"><Icon name="sparkles" :size="14" />让助理改写</button>
          <button class="btn ghost sm icon danger" title="删除页面" @click="remove"><Icon name="trash" :size="14" /></button>
        </div>
        <Markdown :source="page.body" :space="space" :existing-pages="slugs" @rendered="onRendered" />
        <footer v-if="page.context.backlinks.length" class="backlinks">
          <div class="section-title">链接到本页</div>
          <div class="row wrap">
            <router-link v-for="b in page.context.backlinks" :key="b.slug" :to="`/wiki/${b.spaceId}/${b.slug}`" class="badge">{{ b.title }}</router-link>
          </div>
        </footer>
      </article>
    </main>

    <aside v-if="page && !editing" class="rail">
      <div v-if="toc.length > 1" class="block">
        <div class="section-title">本页</div>
        <a v-for="t in toc" :key="t.id" href="#" class="toc" :class="`l${t.level}`" @click.prevent="jump(t.id)">{{ t.text }}</a>
      </div>
      <div v-if="page.context.sources.length" class="block">
        <div class="section-title">引用的原件</div>
        <a v-for="s in page.context.sources" :key="s.sourceId" href="#" class="src" :class="{ stale: s.stale, deleted: s.deleted }" :title="s.stale ? '写作后这份原件已变化' : s.uri" @click.prevent="openCitation({ kind: 'source', id: s.sourceId }, true)">
          <Icon :name="s.stale || s.deleted ? 'alert' : 'file'" :size="13" />
          <span class="ellipsis">{{ s.uri }}</span>
        </a>
      </div>
      <div v-if="page.context.history.length" class="block">
        <div class="section-title">历史</div>
        <a v-for="h in page.context.history.slice(0, 8)" :key="h.hash" href="#" class="hist" @click.prevent="showVersion(h.hash)">
          <span class="small">{{ relTime(h.at) }}</span>
          <span class="muted small ellipsis">{{ h.message.replace(/^\w+: (update|create) [^\s]+ ?(— )?/, "") || "更新" }}</span>
        </a>
      </div>
    </aside>

    <div v-if="version" class="modal-overlay" @mousedown.self="version = null">
      <div class="modal">
        <header class="row"><strong>这次修改</strong><span class="spacer" /><button class="btn ghost sm icon" @click="version = null"><Icon name="x" /></button></header>
        <pre class="diff"><code v-for="(l, i) in version.diff.split('\n')" :key="i" :class="l.startsWith('+') ? 'add' : l.startsWith('-') ? 'rm' : ''">{{ l }}
</code></pre>
      </div>
    </div>

    <div v-if="rewriteOpen" class="modal-overlay" @mousedown.self="rewriteOpen = false">
      <div class="modal">
        <header class="row"><strong>让助理改写这一页</strong><span class="spacer" /><button class="btn ghost sm icon" @click="rewriteOpen = false"><Icon name="x" /></button></header>
        <p class="muted small">助理会重新调查原文，在现有内容基础上改进。可以写下哪里不清楚、想补充什么。</p>
        <textarea v-model="rewriteNote" class="textarea" rows="5" placeholder="例如：开头太抽象，先用一个真实请求走一遍；补充失败时怎么排查。" />
        <div class="row"><span class="spacer" /><button class="btn primary" @click="rewrite">开始改写</button></div>
      </div>
    </div>

    <div v-if="newOpen" class="modal-overlay" @mousedown.self="newOpen = false">
      <div class="modal">
        <header class="row"><strong>写一页新文章</strong><span class="spacer" /><button class="btn ghost sm icon" @click="newOpen = false"><Icon name="x" /></button></header>
        <p class="muted small">说清楚读者想弄明白什么，助理会在「{{ spaceName }}」的材料里调查后写作，并引用原文。</p>
        <label class="field"><span>标题</span><input v-model="newPage.title" class="input" placeholder="例如：一条飞书消息进来之后发生了什么" /></label>
        <label class="field"><span>读者问题</span><textarea v-model="newPage.question" class="textarea" rows="3" placeholder="读者读完应该能回答什么、能做什么" /></label>
        <label class="field"><span>讲解思路（可选）</span><textarea v-model="newPage.outline" class="textarea" rows="2" placeholder="例如：先用一个真实例子走完全流程，再讲设计取舍" /></label>
        <div class="row"><span class="spacer" /><button class="btn primary" :disabled="!newPage.title.trim() || !newPage.question.trim()" @click="createPage">开始写作</button></div>
      </div>
    </div>

    <div v-if="planOpen" class="modal-overlay" @mousedown.self="planOpen = false">
      <div class="modal">
        <header class="row"><strong>规划 Wiki 目录</strong><span class="spacer" /><button class="btn ghost sm icon" @click="planOpen = false"><Icon name="x" /></button></header>
        <p class="muted small">助理会调查「{{ spaceName }}」的材料，规划页面（概览、端到端流程、核心概念、修改指南等），然后逐页写作。已有页面会被考虑复用。</p>
        <label class="field"><span>读者与重点（可选）</span><textarea v-model="planFocus" class="textarea" rows="4" placeholder="例如：读者是刚加入的后端开发，重点是消息处理流程和怎么加一个新渠道。" /></label>
        <div class="row"><span class="spacer" /><button class="btn primary" @click="plan"><Icon name="sparkles" :size="15" />开始</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-loading {
  max-width: 760px;
  margin: 0 auto;
  padding: 36px 32px;
}
.wiki {
  display: flex;
  min-height: 100%;
}
.nav {
  width: 250px;
  flex: none;
  border-right: 1px solid var(--line);
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  padding: 14px 10px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.nav-head {
  display: grid;
  gap: 8px;
  padding: 0 4px;
}
.filter {
  height: 30px;
  padding: 4px 9px;
  font-size: 13px;
}
.tree {
  display: grid;
  gap: 1px;
}
.group {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.03em;
  padding: 12px 8px 4px;
}
.node {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 5px 8px;
  border-radius: 6px;
  color: var(--ink-2);
  font-size: 13.5px;
  line-height: 1.45;
}
.node:hover {
  background: var(--hover);
  text-decoration: none;
}
.node.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 550;
}
.node.sub {
  padding-left: 20px;
}
.node.sub2 {
  padding-left: 32px;
}
.running {
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
.spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
  flex: none;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.stale-btn {
  color: var(--warn);
  justify-content: flex-start;
}
.pad {
  padding: 8px;
}
.content {
  flex: 1;
  min-width: 0;
  padding: 28px 40px 80px;
}
.article {
  max-width: 760px;
  margin: 0 auto;
}
.crumbs {
  margin-bottom: 10px;
}
.title {
  font-family: var(--serif);
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-bottom: 10px;
}
.lead {
  font-size: 16.5px;
  color: var(--ink-2);
  margin: 0 0 14px;
  line-height: 1.7;
}
.meta {
  gap: 6px;
  padding-bottom: 14px;
  margin-bottom: 26px;
  border-bottom: 1px solid var(--line);
}
.backlinks {
  margin-top: 48px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}
.rail {
  width: 240px;
  flex: none;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 32px 20px 20px 4px;
  display: grid;
  gap: 24px;
  align-content: start;
}
.toc {
  display: block;
  font-size: 12.5px;
  color: var(--ink-2);
  padding: 3px 0;
  line-height: 1.45;
}
.toc.l3 {
  padding-left: 12px;
  color: var(--muted);
}
.src span,
.hist span {
  min-width: 0;
}
.src,
.hist {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--ink-2);
  padding: 3px 0;
  font-family: var(--mono);
  min-width: 0;
}
.hist {
  font-family: var(--sans);
  display: grid;
  gap: 0;
}
.src.stale {
  color: var(--warn);
}
.src.deleted {
  color: var(--danger);
  text-decoration: line-through;
}
.overview {
  max-width: 900px;
  margin: 0 auto;
}
.overview h1 {
  font-family: var(--serif);
  margin-bottom: 20px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.pcard {
  display: grid;
  gap: 4px;
  color: inherit;
}
.pcard:hover {
  text-decoration: none;
  border-color: var(--line-strong);
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.editor {
  display: grid;
  gap: 10px;
}
.title-input {
  font-size: 22px;
  font-weight: 650;
}
.body-input {
  min-height: 60vh;
  font-family: var(--mono);
  font-size: 13px;
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 55;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 10vh;
}
.modal {
  width: min(620px, calc(100vw - 24px));
  max-height: 80vh;
  overflow: auto;
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 16px 18px;
  display: grid;
  gap: 12px;
}
.diff {
  font-size: 12px;
  background: var(--sunken);
  border-radius: 8px;
  padding: 10px;
  overflow: auto;
  margin: 0;
  max-height: 60vh;
}
.diff code {
  display: block;
  white-space: pre-wrap;
}
.diff .add {
  background: var(--ok-soft);
  color: var(--ok);
}
.diff .rm {
  background: var(--danger-soft);
  color: var(--danger);
}
.mobile-bar {
  display: none;
  margin-bottom: 12px;
}
@media (max-width: 1240px) {
  .rail {
    display: none;
  }
}
@media (max-width: 860px) {
  .nav {
    display: none;
  }
  .nav-open .nav {
    display: flex;
    position: fixed;
    z-index: 30;
    background: var(--bg);
    box-shadow: var(--shadow-lg);
    top: 0;
    left: 0;
  }
  .mobile-bar {
    display: flex;
  }
  .content {
    padding: 16px 16px 60px;
  }
  .title {
    font-size: 26px;
  }
}
</style>
