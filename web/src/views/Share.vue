<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Icon from "../components/Icon.vue";
import ShareItemBody from "../components/ShareItemBody.vue";
import Skeleton from "../components/Skeleton.vue";
import UiSegmented from "../components/UiSegmented.vue";
import { setTimeZone } from "../lib/time";
import { safe, when, where, type ReviewFinding, type ReviewItem, type ShareItem } from "../lib/share";

/**
 * A read-only share (src/core/shares.ts), opened by anyone with the link, without a token. Either
 * the parts of omem one message sent outside cited, copied when it was sent; or a review's
 * conclusion: its findings with a contents list to move between them, and what they cite (the code
 * on the reviewed branch, sources, memories) copied along and opened beside them.
 */
type Share = { title: string; createdAt: string; expiresAt: string | null; items: ShareItem[] };
type Evidence = Exclude<ShareItem, { kind: "review" }>;

const route = useRoute(), router = useRouter();
const share = ref<Share | null>(null);
const error = ref("");
const current = computed(() => (route.params.item !== undefined && route.params.item !== "" ? Number(route.params.item) : null));
/** The mark the message showed for it (src/channels/citations.ts citationMark). */
const circled = (n: number) => `(${n})`;

// ---- a shared review
const SEVERITY: Record<string, { text: string; cls: string }> = { blocker: { text: "阻断", cls: "danger" }, major: { text: "严重", cls: "danger" }, minor: { text: "一般", cls: "warn" }, nit: { text: "提示", cls: "" } };
const DECISION: Record<string, string> = { fix: "要改", later: "暂不改", wontfix: "不改" };
const RESOLVED: Record<string, string> = { fixed: "复审：已修", still: "复审：仍在", moot: "复审：不再适用" };
const VERDICT: Record<string, string> = { approved: "评审通过", "changes-requested": "需要修改" };
const review = computed(() => (share.value?.items[0]?.kind === "review" ? (share.value.items[0] as ReviewItem) : null));
const branchName = (b: string) => b.replace(/^origin\//, "");
type Filter = "all" | ReviewFinding["decision"];
const filter = ref<Filter>("all");
const count = (d: Filter) => (review.value?.findings ?? []).filter((f) => d === "all" || f.decision === d).length;
const filters = computed(() => (["all", "fix", "later", "wontfix"] as Filter[]).filter((d) => d === "all" || count(d)).map((d) => ({ value: d, label: `${d === "all" ? "全部" : DECISION[d]} ${count(d)}` })));
const shown = computed(() => (review.value?.findings ?? []).filter((f) => filter.value === "all" || f.decision === filter.value));
const active = ref<number | null>(null);
const tocOpen = ref(false);

/** The copied item a citation points at, open beside the findings. */
const opened = ref<Evidence | null>(null);
const evidenceOf = (n: number) => share.value?.items.find((x) => x.i === n && x.kind !== "review") as Evidence | undefined;
function openEvidence(n: number, push = true) {
  const it = evidenceOf(n);
  if (!it) return;
  opened.value = it;
  if (push) void router.replace(`/share/${String(route.params.token)}/${n}`);
  void nextTick(() => document.querySelector<HTMLElement>(".evidence .ev-body .hit")?.scrollIntoView({ block: "center" }));
}
function closeEvidence() {
  opened.value = null;
  void router.replace(`/share/${String(route.params.token)}`);
}
/** A citation in the text (`#ev-<n>`, lib/share.ts safe) opens its copy instead of moving the page. */
function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-ev]");
  if (!a) return;
  e.preventDefault();
  openEvidence(Number(a.dataset.ev));
}
function jump(n: number | "summary") {
  tocOpen.value = false;
  document.getElementById(n === "summary" ? "summary" : `finding-${n}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (n !== "summary") active.value = n;
}
// The finding being read: the last one whose top has passed the top of the page.
let frame = 0;
function onScroll() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    let last: number | null = null;
    for (const el of document.querySelectorAll<HTMLElement>(".finding[data-n]")) {
      if (el.getBoundingClientRect().top > 140) break;
      last = Number(el.dataset.n);
    }
    active.value = last;
  });
}
// The link's own item (`…/share/<token>/<n>`), also when only the address changes.
watch(current, (n) => {
  if (!review.value) return;
  if (n === null) opened.value = null;
  else if (opened.value?.i !== n) openEvidence(n, false);
});
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && opened.value) closeEvidence();
}

/** The server answers a share in milliseconds: a wait this long is the browser holding the request back. */
const SLOW_MS = 8_000;
const GIVE_UP_MS = 60_000;
const slow = ref(false);

onMounted(async () => {
  window.addEventListener("keydown", onKey);
  const slowTimer = setTimeout(() => (slow.value = true), SLOW_MS);
  const ctrl = new AbortController();
  const giveUp = setTimeout(() => ctrl.abort(), GIVE_UP_MS);
  try {
    const r = await fetch(`/api/share/${encodeURIComponent(String(route.params.token))}`, { headers: { accept: "application/json" }, signal: ctrl.signal }).catch((e: Error) => {
      throw new Error(e.name === "AbortError" ? "等了一分钟还没打开。多半是同一浏览器里开着太多这个地址的页面，连接被占满：关掉几个再刷新，或换个浏览器打开。" : `打开失败（${e.message}），稍后再试。`);
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 404 ? "链接无效、已撤销或已过期，请向发链接的人要一个新的。" : `打开失败（${body.error ?? r.status}），稍后再试。`);
    setTimeZone((body as { timezone?: string }).timezone);
    share.value = body as Share;
    document.title = `${share.value.title || "分享"} · omem`;
    await nextTick();
    if (current.value !== null) {
      if (review.value) openEvidence(current.value, false);
      else document.getElementById(`item-${current.value}`)?.scrollIntoView({ block: "start" });
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    clearTimeout(slowTimer);
    clearTimeout(giveUp);
    slow.value = false;
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  if (frame) cancelAnimationFrame(frame);
});
</script>

<template>
  <div class="share-page" @scroll.passive="onScroll">
    <header class="share-head">
      <span class="brand"><svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor" /><circle cx="16" cy="16" r="7" fill="none" stroke="var(--bg)" stroke-width="3" /></svg>omem</span>
      <span class="muted small">只读分享</span>
    </header>

    <main v-if="error || !share" class="share-body">
      <div v-if="error" class="card pad empty-share">
        <strong>打不开这个分享</strong>
        <p class="muted">{{ error }}</p>
      </div>
      <template v-else>
        <p v-if="slow" class="muted small" role="status">还在等……同一浏览器里开着很多这个地址的页面时，浏览器会让这个请求排队；关掉几个页面，或换个浏览器打开。</p>
        <Skeleton variant="text" :rows="10" />
      </template>
    </main>

    <!-- A review: contents on the left, findings in the middle, what a citation points at on the right. -->
    <main v-else-if="review" class="review-body" :class="{ 'with-ev': opened }">
      <nav class="toc" :class="{ open: tocOpen }" aria-label="问题目录">
        <button type="button" class="toc-toggle btn ghost sm" :aria-expanded="tocOpen" @click="tocOpen = !tocOpen"><Icon name="menu" :size="15" />问题目录 · {{ shown.length }}</button>
        <div class="toc-inner">
          <UiSegmented v-if="filters.length > 2" v-model="filter" :options="filters" size="sm" aria-label="按决定筛选" />
          <button type="button" class="toc-row" @click="jump('summary')"><span class="toc-title">结论与总结</span></button>
          <button v-for="f in shown" :key="f.n" type="button" class="toc-row" :class="{ on: active === f.n, quiet: f.decision !== 'fix' }" :title="f.title" @click="jump(f.n)">
            <span class="sev-dot" :class="SEVERITY[f.severity]?.cls" :title="SEVERITY[f.severity]?.text" />
            <span class="toc-n">#{{ f.n }}</span>
            <span class="toc-title">{{ f.title }}</span>
          </button>
        </div>
      </nav>

      <div class="findings" @click="onClick">
        <h1 id="summary">{{ share.title || review.title }}</h1>
        <p class="muted small meta">代码评审的结论 · {{ when(share.createdAt) }} 复制 · {{ share.expiresAt ? `${when(share.expiresAt)} 失效` : "长期有效" }}</p>
        <p class="row wrap small">
          <span v-if="review.verdict" class="badge" :class="review.verdict === 'approved' ? 'ok' : 'warn'">{{ VERDICT[review.verdict] ?? review.verdict }}</span>
          <span>{{ review.findings.length }} 个问题，其中要改 {{ count("fix") }} 个</span>
        </p>
        <ul v-if="review.branches.length" class="branches small">
          <li v-for="b in review.branches" :key="b.repo" class="branch"><span class="muted">{{ b.repo }}</span><code>{{ branchName(b.branch) }}</code><template v-if="b.base"><span class="muted">对照</span><code>{{ branchName(b.base) }}</code></template></li>
        </ul>
        <div v-if="review.summary" class="prose summary" v-html="safe(review.summary)" />

        <section v-for="f in shown" :id="`finding-${f.n}`" :key="f.n" :data-n="f.n" class="card finding" :class="{ quiet: f.decision !== 'fix' }">
          <div class="f-head">
            <h2>#{{ f.n }} {{ f.title }}</h2>
            <div class="row wrap tags">
              <span class="badge" :class="SEVERITY[f.severity]?.cls">{{ SEVERITY[f.severity]?.text ?? f.severity }}</span>
              <span class="badge" :class="f.decision === 'fix' ? 'accent' : ''">{{ DECISION[f.decision] }}</span>
              <span v-if="f.resolution && RESOLVED[f.resolution]" class="badge">{{ RESOLVED[f.resolution] }}</span>
            </div>
          </div>
          <template v-if="f.file">
            <a v-if="f.at" :href="`#ev-${f.at}`" :data-ev="f.at" class="loc mono small ev">{{ f.file }}{{ f.line ? `:${f.line}` : "" }}</a>
            <p v-else class="loc mono small muted">{{ f.file }}{{ f.line ? `:${f.line}` : "" }}</p>
          </template>
          <div class="prose" v-html="safe(f.detail)" />
          <div v-if="f.suggestion" class="suggestion"><strong class="small">建议</strong><div class="prose" v-html="safe(f.suggestion)" /></div>
          <p v-if="f.note" class="small muted">{{ DECISION[f.decision] }}的理由：{{ f.note }}</p>
        </section>
        <p v-if="!shown.length" class="muted">没有这一类的问题。</p>
        <p class="muted small foot">这是分享时评审结论的副本，不含评审过程。带下划线的引用能打开：代码是评审时分支上的那几行，其他是当时的原件或记忆。</p>
      </div>

      <aside v-if="opened" class="evidence" :aria-label="`引用：${opened.label || opened.title}`">
        <div class="ev-head">
          <div class="ev-title">
            <strong>{{ opened.label || opened.title }}</strong>
            <span class="muted small">{{ opened.label && opened.label !== opened.title ? `${opened.title} · ` : "" }}{{ where(opened) }}</span>
          </div>
          <button type="button" class="btn ghost sm" aria-label="关闭引用" title="关闭（Esc）" @click="closeEvidence"><Icon name="x" :size="16" /></button>
        </div>
        <div class="ev-body"><ShareItemBody :item="opened" /></div>
      </aside>
    </main>

    <main v-else class="share-body">
      <h1>{{ share.title || "引用的内容" }}</h1>
      <p class="muted small meta">一条消息引用的 {{ share.items.length }} 处内容 · {{ when(share.createdAt) }} 复制 · {{ share.expiresAt ? `${when(share.expiresAt)} 失效` : "长期有效" }}</p>
      <article v-for="it in share.items as Evidence[]" :id="`item-${it.i}`" :key="it.i" class="card item" :class="{ on: current === it.i }">
        <div class="item-head">
          <span v-if="it.mark" class="mark" aria-hidden="true">{{ circled(it.mark) }}</span>
          <div class="item-title">
            <strong>{{ it.label || it.title }}</strong>
            <span class="muted small">{{ it.label && it.label !== it.title ? `${it.title} · ` : "" }}{{ where(it) }}</span>
          </div>
        </div>
        <ShareItemBody :item="it" />
      </article>
      <p class="muted small foot">这里只有那条消息引用的部分，是发送时的副本；里面提到的其他内容不能从这里打开。</p>
    </main>
  </div>
</template>

<style scoped>
.share-page {
  min-height: 100%;
  background: var(--bg);
  overflow-y: auto;
  height: 100%;
}
.share-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--sunken);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 650;
}
.share-body {
  max-width: 960px;
  margin: 0 auto;
  padding: 28px 20px 64px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
h1 {
  font-family: var(--serif);
  font-size: 24px;
  font-weight: 650;
  line-height: 1.4;
  margin: 0;
  overflow-wrap: anywhere;
  scroll-margin-top: 16px;
}
.meta {
  margin: -8px 0 4px;
}
.item {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  scroll-margin-top: 16px;
}
.item.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.item-head {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  min-width: 0;
}
.mark {
  font-size: 18px;
  line-height: 1.3;
  color: var(--accent);
}
.item-title,
.ev-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.empty-share {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.foot {
  text-align: center;
}

/* ---- a shared review: the page's width goes to the findings and, when one is open, the evidence */
.review-body {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  gap: 28px;
  max-width: 1760px;
  margin: 0 auto;
  padding: 24px 24px 64px;
  align-items: start;
}
.review-body.with-ev {
  grid-template-columns: 220px minmax(0, 1fr) minmax(360px, 40%);
  gap: 20px;
}
.toc {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  min-width: 0;
}
.toc-toggle {
  display: none;
}
.toc-inner {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.toc-inner > :first-child {
  margin-bottom: 8px;
}
.toc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.toc-row:hover {
  background: var(--sunken);
}
.toc-row.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.toc-row.quiet:not(.on) {
  color: var(--muted);
}
.toc-n {
  flex: none;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.toc-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sev-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line-strong);
}
.sev-dot.danger {
  background: var(--danger);
}
.sev-dot.warn {
  background: var(--warn);
}
.findings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.branches {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
}
.branch {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.summary {
  margin-bottom: 4px;
}
.finding {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  scroll-margin-top: 16px;
}
.finding.quiet {
  opacity: 0.8;
}
.f-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px 12px;
}
.f-head h2 {
  font-size: 16px;
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.tags {
  gap: 6px;
}
.loc {
  margin: 0;
  overflow-wrap: anywhere;
  align-self: flex-start;
}
.suggestion {
  border-left: 3px solid var(--line);
  padding-left: 12px;
}
.findings :deep(a.ev) {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
  cursor: pointer;
}
.evidence {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  overflow: hidden;
}
.ev-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.ev-body {
  padding: 12px 14px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Narrower: the contents fold above the findings, the evidence slides over from the right. */
@media (max-width: 1100px) {
  .review-body,
  .review-body.with-ev {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    padding: 20px 20px 56px;
  }
  .toc {
    position: static;
    max-height: none;
  }
  .toc-toggle {
    display: inline-flex;
  }
  .toc-inner {
    display: none;
    margin-top: 8px;
  }
  .toc.open .toc-inner {
    display: flex;
  }
  .evidence {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(100vw, 680px);
    max-height: none;
    border-radius: 0;
    border-width: 0 0 0 1px;
    box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.18));
    z-index: 20;
  }
}
@media (max-width: 760px) {
  .share-body {
    padding: 20px 16px 48px;
  }
  .review-body,
  .review-body.with-ev {
    padding: 16px 16px 48px;
  }
  h1 {
    font-size: 20px;
  }
}
</style>
