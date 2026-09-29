<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  OmShell,
  OmButton,
  OmIcon,
  OmBadge,
  OmPanel,
  OmEmpty,
} from "@omem/ui";
import CodeWiki from "./codewiki/CodeWiki.vue";
import {
  reviewHealth,
  reviewCategories,
  reviewSources,
  reviewRevision,
  reviewFragment,
  reviewSearch,
  reviewSyncStatus,
  reviewRunSync,
  reviewCode,
  reviewFragmentRelations,
  reviewCodeRelations,
  getSourceVersions,
  type ReviewHealth,
  type ReviewCategory,
  type ReviewSource,
  type ReviewRevision,
  type ReviewSourceVersion,
  type ReviewFragmentDetail,
  type ReviewSearchHit,
  type ReviewRelation,
  type SyncStatus,
  type SyncResult,
} from "./review-api";

type View = "wiki" | "browse" | "read" | "search" | "trace" | "sync";

const health = ref<ReviewHealth | null>(null);
const categories = ref<ReviewCategory[]>([]);
const view = ref<View>("wiki");
const activeCategory = ref<string>("architecture");
const sources = ref<ReviewSource[]>([]);
const revision = ref<ReviewRevision | null>(null);
const selectedFragmentId = ref<string | null>(null);
const fragmentDetail = ref<ReviewFragmentDetail | null>(null);
const relatedDecisions = ref<ReviewSearchHit[]>([]);
const relatedResearch = ref<ReviewSearchHit[]>([]);
const fragmentRelations = ref<ReviewRelation[]>([]);
const traceRelations = ref<ReviewRelation[]>([]);
const searchInput = ref("");
const searchQuery = ref("");
const searchResults = ref<ReviewSearchHit[]>([]);
const searching = ref(false);
const tracePath = ref("apps/server/src/review/app.ts");
const traceSource = ref<ReviewSource | null>(null);
const traceLoading = ref(false);
const traceDecisions = ref<ReviewSearchHit[]>([]);
const traceResearch = ref<ReviewSearchHit[]>([]);
const traceKeywords = ref("");
const syncState = ref<SyncStatus | null>(null);
const syncBusy = ref(false);
const lastSyncResult = ref<SyncResult | null>(null);
const error = ref("");
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout>;

/** C2: when false, removed sources are hidden from the browse list. */
const showRemoved = ref(false);
/** C1: historical revisions of the revision currently open in the read view. */
const sourceVersions = ref<ReviewSourceVersion[]>([]);
/** C1: which version row the dropdown currently points at (equals the loaded
 * revision id; used to highlight the <option>). */
const selectedVersionId = ref<string>("");

const CATEGORY_LABELS: Record<string, string> = {
  architecture: "架构与实现",
  progress: "进度追踪",
  decisions: "历史决策",
  research: "背景调研",
};

const RELATION_LABELS: Record<string, string> = {
  implements: "实现意图",
  implemented_by: "实现代码",
  decided_by: "决策依据",
  decided_for: "决策用于",
  researched_by: "调研依据",
  researched_for: "调研用于",
  tested_by: "测试证据",
  tested_for: "测试覆盖",
  requires: "依赖",
  required_by: "被依赖",
  candidate_for: "候选关联",
};

const RELATION_ORDER = [
  "implements",
  "implemented_by",
  "decided_by",
  "decided_for",
  "researched_by",
  "researched_for",
  "tested_by",
  "tested_for",
];

function relationLabel(t: string): string {
  return RELATION_LABELS[t] ?? t;
}

/** Badge tone from the EFFECTIVE relation status (the server already collapses
 * stored status + otherCurrent/otherRemoved into relationStatus, so the UI never
 * has to second-guess it). */
function statusTone(r: ReviewRelation): "success" | "warning" | "neutral" | "danger" {
  if (r.relationStatus === "confirmed") return "success";
  if (r.relationStatus === "candidate") return "warning";
  if (r.relationStatus === "missing") return "neutral";
  return "neutral"; // stale
}

function statusLabel(r: ReviewRelation): string {
  if (r.relationStatus === "confirmed") return "已关联";
  if (r.relationStatus === "candidate") return "候选";
  if (r.relationStatus === "missing") return "缺失";
  return "已过期"; // stale
}

/** Group a relation list by relation type, in a stable display order. */
function groupRelations(list: ReviewRelation[]): { type: string; items: ReviewRelation[] }[] {
  const byType = new Map<string, ReviewRelation[]>();
  for (const r of list) {
    const arr = byType.get(r.relationType) ?? [];
    arr.push(r);
    byType.set(r.relationType, arr);
  }
  const ordered = [...byType.entries()].sort((a, b) => {
    const ai = RELATION_ORDER.indexOf(a[0]);
    const bi = RELATION_ORDER.indexOf(b[0]);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  return ordered.map(([type, items]) => ({ type, items }));
}

const navItems: { id: View; label: string; icon: string }[] = [
  { id: "wiki", label: "仓库知识", icon: "layers" },
  { id: "browse", label: "浏览材料", icon: "book" },
  { id: "search", label: "全文搜索", icon: "spark" },
  { id: "trace", label: "代码追溯", icon: "link" },
  { id: "sync", label: "同步状态", icon: "clock" },
];

const pageTitle = computed(() => {
  switch (view.value) {
    case "wiki":
      return "代码 Wiki";
    case "browse":
      return "浏览材料";
    case "read":
      return revision.value?.title || "材料详情";
    case "search":
      return "全文搜索";
    case "trace":
      return "代码追溯";
    case "sync":
      return "同步状态";
  }
});

/** C2: hide removed sources unless the user explicitly opted in. */
const visibleSources = computed(() =>
  showRemoved.value
    ? sources.value
    : sources.value.filter((s) => !s.removed),
);

function say(text: string) {
  clearTimeout(toastTimer);
  toast.value = text;
  toastTimer = setTimeout(() => (toast.value = ""), 5000);
}

function shortCommit(c: string | null | undefined): string {
  return c ? c.slice(0, 8) : "—";
}

/** Shorten a content hash for the snapshot line. */
function shortHash(h: string | null | undefined): string {
  return h ? h.slice(0, 10) : "—";
}

/** Basename stem + first symbols are the distinctive keywords a decisions/research
 * doc would mention when discussing a code file. */
function keywordsFor(filePath: string | null, revision?: ReviewRevision | null): string {
  const parts: string[] = [];
  if (filePath) {
    const base = filePath.split("/").pop() || filePath;
    parts.push(base.replace(/\.[^.]+$/, ""));
    const segs = filePath.split("/").filter((s) => s && !["src", "apps", "packages"].includes(s));
    if (segs.length > 1) parts.push(segs[segs.length - 2]);
  }
  const symbols = (revision?.context?.symbols as string[] | undefined) || [];
  for (const s of symbols.slice(0, 3)) parts.push(s);
  return [...new Set(parts)].join(" ").trim();
}

async function loadCategories() {
  categories.value = await reviewCategories();
  if (activeCategory.value && !categories.value.some((c) => c.id === activeCategory.value))
    activeCategory.value = categories.value[0]?.id ?? "";
}

async function loadSources(category: string) {
  view.value = "browse";
  activeCategory.value = category;
  sources.value = await reviewSources(category, showRemoved.value);
}

async function openRevision(revisionId: string, selectFragmentId?: string) {
  error.value = "";
  try {
    revision.value = await reviewRevision(revisionId);
    view.value = "read";
    selectedFragmentId.value = selectFragmentId ?? null;
    fragmentDetail.value = null;
    sourceVersions.value = [];
    selectedVersionId.value = revisionId;
    // C1: load the version history for this source so the dropdown can switch
    // to older snapshots. Failure here must not block reading the current one.
    if (revision.value?.sourceId) {
      sourceVersions.value = await getSourceVersions(revision.value.sourceId).catch(
        () => [],
      );
    }
    if (selectFragmentId) await showFragment(selectFragmentId);
  } catch (e) {
    error.value = String(e);
  }
}

/** C1: switch the read view to a historical revision and reload its fragments. */
async function switchVersion(revisionId: string) {
  if (!revisionId || revisionId === selectedVersionId.value) return;
  await openRevision(revisionId);
}

/** C2: re-query the source list when the "show removed" checkbox flips. */
async function onToggleRemoved() {
  if (view.value !== "browse") return;
  await loadSources(activeCategory.value);
}

async function showFragment(fragmentId: string) {
  error.value = "";
  selectedFragmentId.value = fragmentId;
  try {
    const [detail, rels] = await Promise.all([
      reviewFragment(fragmentId),
      reviewFragmentRelations(fragmentId).catch(() => ({ fragmentId, relations: [] as ReviewRelation[] })),
    ]);
    fragmentDetail.value = detail;
    fragmentRelations.value = rels.relations;
    const kw = keywordsFor(
      detail.revision.context.filePath ?? null,
      revision.value,
    );
    if (kw) {
      [relatedDecisions.value, relatedResearch.value] = await Promise.all([
        reviewSearch(kw, "decisions").catch(() => []),
        reviewSearch(kw, "research").catch(() => []),
      ]);
    } else {
      relatedDecisions.value = [];
      relatedResearch.value = [];
    }
  } catch (e) {
    error.value = String(e);
  }
}

/** Jump to the other side of a relation (bidirectional navigation). */
async function openRelation(other: ReviewRelation["other"]) {
  if (!other || !other.revisionId) {
    say("该关联指向缺失的材料，无法跳转");
    return;
  }
  await openRevision(other.revisionId, other.fragmentId);
}

async function runSearch() {
  const q = searchInput.value.trim();
  searchQuery.value = q;
  view.value = "search";
  if (!q) {
    searchResults.value = [];
    return;
  }
  searching.value = true;
  error.value = "";
  try {
    searchResults.value = await reviewSearch(q);
  } catch (e) {
    error.value = String(e);
  } finally {
    searching.value = false;
  }
}

/** Search hits only carry a fragment id; resolve it to its revision, then open. */
async function openHit(hit: ReviewSearchHit) {
  try {
    const detail = await reviewFragment(hit.id);
    await openRevision(detail.revisionId, hit.id);
  } catch (e) {
    error.value = String(e);
  }
}

async function runTrace() {
  const path = tracePath.value.trim();
  if (!path) return;
  traceLoading.value = true;
  error.value = "";
  traceSource.value = null;
  traceDecisions.value = [];
  traceResearch.value = [];
  traceKeywords.value = "";
  traceRelations.value = [];
  try {
    const source = await reviewCode(path);
    traceSource.value = source;
    if (source) {
      // Confirmed, hand-curated chain for this file: intent→decision→research→test.
      traceRelations.value = await reviewCodeRelations(path).catch(() => []);
      // Pull the head revision so we can use its extracted symbols as association
      // keywords; path tokens alone (e.g. "runtime assistant") are too sparse for the
      // case-sensitive substring matcher to hit decision/research docs.
      let revisionForKw: ReviewRevision | null = null;
      try {
        revisionForKw = await reviewRevision(source.revisionId);
      } catch {
        /* keywords still fall back to path-derived tokens */
      }
      const kw = keywordsFor(path, revisionForKw);
      traceKeywords.value = kw;
      if (kw) {
        [traceDecisions.value, traceResearch.value] = await Promise.all([
          reviewSearch(kw, "decisions").catch(() => []),
          reviewSearch(kw, "research").catch(() => []),
        ]);
      }
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    traceLoading.value = false;
  }
}

async function openTraceSource() {
  if (traceSource.value) await openRevision(traceSource.value.revisionId);
}

async function loadSync() {
  syncState.value = await reviewSyncStatus();
}

async function runSync() {
  syncBusy.value = true;
  error.value = "";
  try {
    lastSyncResult.value = await reviewRunSync();
    await Promise.all([loadSync(), loadCategories(), refreshHealth()]);
    say("同步完成");
  } catch (e) {
    error.value = String(e);
  } finally {
    syncBusy.value = false;
  }
}

async function refreshHealth() {
  try {
    health.value = await reviewHealth();
  } catch {
    /* header badge stays absent */
  }
}

async function boot() {
  error.value = "";
  try {
    [health.value, categories.value] = await Promise.all([
      reviewHealth(),
      reviewCategories(),
    ]);
    // Code Wiki is the landing; only preload the browse list if the user opens it.
    if (view.value !== "wiki")
      await loadSources(activeCategory.value || categories.value[0]?.id || "");
    await loadSync();
  } catch (e) {
    error.value = String(e);
  }
}

onMounted(() => void boot());
</script>

<template>
  <OmShell>
    <template #top>
      <div class="top-controls">
        <input
          v-model="searchInput"
          aria-label="搜索代码材料"
          placeholder="搜索片段，如 ModelUnavailableError…"
          @keyup.enter="runSearch"
        /><OmButton variant="ghost" class="notification-button" @click="view = 'sync'"
          >同步 {{ shortCommit(health?.lastSyncCommit ?? null) }}</OmButton
        >
      </div>
    </template>
    <template #navigation>
      <div class="workspace-title">
        <b>本仓库 · omem</b><small>材料与知识 · {{ health?.sourceCount ?? 0 }} 源 / {{ health?.fragmentCount ?? 0 }} 片段</small>
      </div>
      <nav class="navigation">
        <button
          v-for="item in navItems"
          :key="item.id"
          :class="{ active: view === item.id }"
          @click="view = item.id"
        >
          <OmIcon :name="item.icon" />{{ item.label }}
        </button>
      </nav>
      <h4 class="nav-heading">材料分类 <small>{{ categories.length }}</small></h4>
      <button
        v-for="c in categories"
        :key="c.id"
        class="source-link"
        :class="{ selected: view === 'browse' && activeCategory === c.id }"
        @click="loadSources(c.id)"
      >
        <span>{{ c.name }}</span
        ><small>{{ c.sourceCount }} 源 · {{ c.fragmentCount }} 片段</small>
      </button>
    </template>

    <div class="page-bar">
      <span>本仓库 / {{ pageTitle }}</span>
      <OmBadge>知识阅读 · 固定证据</OmBadge>
    </div>
    <div v-if="error" class="error-banner" role="alert">
      {{ error
      }}<OmButton variant="ghost" @click="error = ''">关闭提示</OmButton>
    </div>

    <!-- code wiki -->
    <section v-if="view === 'wiki'" class="page wiki-page">
      <CodeWiki />
    </section>

    <!-- browse -->
    <section v-else-if="view === 'browse'" class="page">
      <span class="eyebrow">{{ activeCategory || "全部分类" }}</span>
      <h1>{{ CATEGORY_LABELS[activeCategory] || "材料" }}</h1>
      <p class="muted">按分类浏览已导入的代码与文档材料；点击任意条目查看固定版本片段。</p>
      <label class="removed-toggle">
        <input type="checkbox" v-model="showRemoved" @change="onToggleRemoved" />
        显示已删除的源
      </label>
      <OmEmpty
        v-if="!visibleSources.length"
        title="该分类暂无材料"
        description="先到“同步状态”页执行一次同步。"
      />
      <OmPanel
        v-for="s in visibleSources"
        :key="s.revisionId"
        class="stack source-row"
        @click="openRevision(s.revisionId)"
      >
        <div class="row" style="margin-top: 0">
          <span class="cat-badge" :class="s.category || 'neutral'">{{ s.category ? CATEGORY_LABELS[s.category] : s.category }}</span>
          <OmBadge v-if="s.removed" tone="danger">已删除</OmBadge>
          <small>v{{ s.version }} · {{ new Date(s.createdAt).toLocaleString("zh-CN") }}</small>
        </div>
        <p class="source-title">{{ s.title }}</p>
        <small v-if="s.filePath" class="path">{{ s.filePath }}</small>
      </OmPanel>
    </section>

    <!-- read revision -->
    <section v-else-if="view === 'read' && revision" class="page">
      <template v-if="revision">
        <div class="row">
          <span class="cat-badge" :class="revision.context.category || 'neutral'">{{ revision.context.category ? CATEGORY_LABELS[revision.context.category] : "材料" }}</span>
          <OmBadge :tone="revision.current ? 'success' : 'neutral'"
            >v{{ revision.version }} · {{ revision.current ? "当前版本" : "历史版本" }}</OmBadge
          >
          <OmBadge v-if="revision.context.dirty" tone="warning">工作树未提交</OmBadge>
        </div>
        <h1>{{ revision.title }}</h1>
        <p class="muted">
          保存于 {{ new Date(revision.createdAt).toLocaleString("zh-CN") }} ·
          {{ revision.fragments.length }} 个固定片段
        </p>

        <!-- C1: real snapshot info from sync (gitCommit / dirty / contentHash / syncedAt) -->
        <div class="snapshot-row">
          <small class="path">快照：</small>
          <small class="path" v-if="revision.context.gitCommit">commit {{ shortCommit(revision.context.gitCommit) }}</small>
          <small class="path" v-if="revision.context.contentHash">hash {{ shortHash(revision.context.contentHash) }}</small>
          <small class="path" v-if="revision.context.syncedAt">同步于 {{ new Date(revision.context.syncedAt).toLocaleString("zh-CN") }}</small>
        </div>

        <!-- C1: historical version switcher -->
        <div v-if="sourceVersions.length" class="version-row">
          <label class="version-label">历史版本：</label>
          <select
            class="version-select"
            :value="selectedVersionId"
            @change="switchVersion(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="v in sourceVersions"
              :key="v.id"
              :value="v.id"
            >v{{ v.version }}{{ v.current ? "（当前）" : "" }}</option>
          </select>
        </div>

        <p v-if="(revision.context.symbols as string[])?.length" class="muted">
          符号：{{ ((revision.context.symbols as string[]) || []).join("、") }}
        </p>

        <div
          v-for="f in revision.fragments"
          :key="f.id"
          class="fragment"
          :class="{ focused: selectedFragmentId === f.id }"
        >
          <div class="row" style="margin-bottom: 6px">
            <OmBadge v-if="!revision.current" tone="neutral">历史版本</OmBadge>
          </div>
          <pre class="frag-text">{{ f.text }}</pre>
          <div class="row">
            <small>片段 {{ f.ordinal + 1 }}</small>
            <OmButton variant="ghost" @click="showFragment(f.id)">片段详情与追溯</OmButton>
          </div>
        </div>

        <OmPanel v-if="fragmentDetail" class="stack" title="片段详情">
          <div class="row">
            <OmBadge>第 {{ fragmentDetail.ordinal + 1 }} 片段</OmBadge>
            <OmBadge>v{{ fragmentDetail.revision.version }}</OmBadge>
          </div>
          <pre class="frag-text">{{ fragmentDetail.text }}</pre>
          <p class="muted">
            来源：{{ fragmentDetail.revision.title }}
            <template v-if="fragmentDetail.revision.context.filePath">
              · <a href="#" @click.prevent="tracePath = String(fragmentDetail.revision.context.filePath); view = 'trace'; void runTrace()">{{ fragmentDetail.revision.context.filePath }}</a>
            </template>
          </p>
          <h3>实现意图与关联</h3>
          <p class="muted">
            双向关系来自人工维护的关联清单（confirmed）；词相似但未登记的只作候选。
          </p>
          <template v-if="groupRelations(fragmentRelations).length">
            <div v-for="g in groupRelations(fragmentRelations)" :key="g.type" class="relation-group">
              <h4>{{ relationLabel(g.type) }} <small>{{ g.items.length }}</small></h4>
              <OmPanel
                v-for="r in g.items"
                :key="r.id"
                class="stack relation-row"
                @click="void openRelation(r.other)"
              >
                <div class="row" style="margin-top: 0">
                  <OmBadge :tone="statusTone(r)">{{ statusLabel(r) }}</OmBadge>
                  <small v-if="r.other?.version">v{{ r.other.version }}</small>
                </div>
                <template v-if="r.other">
                  <p class="excerpt">{{ r.other.text || r.other.title }}</p>
                  <small class="path">{{ r.other.title }}<template v-if="r.other.filePath"> · {{ r.other.filePath }}</template></small>
                </template>
                <small v-else class="muted">缺失：{{ r.evidence || "关联的材料未收录" }}</small>
                <small v-if="r.evidence" class="relation-evidence">{{ r.evidence }}</small>
              </OmPanel>
            </div>
          </template>
          <p v-else class="muted">尚无登记的双向关联 —— 可在 docs/repo-review/associations.json 补充。</p>
        </OmPanel>
      </template>
    </section>

    <!-- search -->
    <section v-else-if="view === 'search'" class="page">
      <h1>搜索“{{ searchQuery }}”</h1>
      <p class="muted">精确关键词检索片段文本；点击结果打开对应版本并定位片段。</p>
      <OmEmpty v-if="!searchResults.length && !searching" title="未找到相关片段" description="试试函数名、类名或中文短语。" />
      <OmPanel
        v-for="h in searchResults"
        :key="h.id"
        class="stack"
        @click="openHit(h)"
      >
        <div class="row" style="margin-top: 0">
          <span class="cat-badge" :class="h.category || 'neutral'">{{ h.category ? CATEGORY_LABELS[h.category] : "材料" }}</span>
          <OmBadge tone="warning">候选</OmBadge>
          <small>{{ h.title }} · v{{ h.version }}</small>
        </div>
        <p class="excerpt">{{ h.snippet || h.text }}</p>
        <small v-if="h.filePath" class="path">{{ h.filePath }}</small>
      </OmPanel>
    </section>

    <!-- trace -->
    <section v-else-if="view === 'trace'" class="page">
      <span class="eyebrow">代码 → 意图 → 决策 → 调研</span>
      <h1>代码追溯</h1>
      <p class="muted">输入仓库内文件路径，查看该文件的导入材料，并按文件名/符号名匹配相关的设计决策与调研文档。</p>
      <form class="form" @submit.prevent="runTrace">
        <label
          >代码文件路径
          <input v-model="tracePath" placeholder="apps/server/src/review/app.ts" />
        </label>
        <OmButton type="submit" variant="primary" :loading="traceLoading">追溯</OmButton>
      </form>

      <template v-if="traceSource">
        <OmPanel title="① 代码文件" class="stack">
          <div class="row" style="margin-top: 0">
            <span class="cat-badge architecture">架构与实现</span>
            <small>v{{ traceSource.version }}</small>
          </div>
          <p class="source-title">{{ traceSource.title }}</p>
          <small class="path">{{ traceSource.filePath }}</small>
          <template #actions>
            <OmButton @click="openTraceSource">阅读完整片段</OmButton>
          </template>
        </OmPanel>

        <OmPanel title="② 登记链路（意图 → 决策 → 调研 → 测试）" class="stack">
          <template v-if="groupRelations(traceRelations).length">
            <div v-for="g in groupRelations(traceRelations)" :key="g.type">
              <h4>{{ relationLabel(g.type) }}</h4>
              <OmPanel
                v-for="r in g.items"
                :key="r.id"
                class="stack relation-row"
                @click="void openRelation(r.other)"
              >
                <div class="row" style="margin-top: 0">
                  <OmBadge :tone="statusTone(r)">{{ statusLabel(r) }}</OmBadge>
                </div>
                <template v-if="r.other">
                  <p class="excerpt">{{ r.other.text || r.other.title }}</p>
                  <small class="path">{{ r.other.title }}</small>
                </template>
                <small v-else class="muted">缺失：{{ r.evidence }}</small>
              </OmPanel>
            </div>
          </template>
          <OmEmpty v-else title="该文件暂无登记关系" description="在 docs/repo-review/associations.json 中人工登记 code→意图/决策/测试。" />
        </OmPanel>

        <OmPanel title="③ 设计决策（关键词候选）" class="stack">
          <p class="muted">关键词：{{ traceKeywords || "—" }}</p>
          <template v-if="traceDecisions.length">
            <OmPanel v-for="h in traceDecisions.slice(0, 5)" :key="h.id" class="stack" @click="openHit(h)">
              <div class="row" style="margin-top: 0">
                <span class="cat-badge decisions">历史决策</span>
                <OmBadge tone="warning">候选</OmBadge>
              </div>
              <p class="excerpt">{{ h.snippet || h.text }}</p>
              <small>{{ h.title }}</small>
            </OmPanel>
          </template>
          <OmEmpty v-else title="无相关决策记录" description="该文件的设计理由尚未沉淀为决策文档（待补充/推测）。" />
        </OmPanel>

        <OmPanel title="④ 调研材料（关键词候选）" class="stack">
          <template v-if="traceResearch.length">
            <OmPanel v-for="h in traceResearch.slice(0, 5)" :key="h.id" class="stack" @click="openHit(h)">
              <div class="row" style="margin-top: 0">
                <span class="cat-badge research">背景调研</span>
                <OmBadge tone="warning">候选</OmBadge>
              </div>
              <p class="excerpt">{{ h.snippet || h.text }}</p>
              <small>{{ h.title }}</small>
            </OmPanel>
          </template>
          <OmEmpty v-else title="无相关调研材料" description="该文件的背景调研尚未收录（待补充/推测）。" />
        </OmPanel>
      </template>
      <OmEmpty
        v-else-if="!traceLoading && tracePath"
        title="知识库中没有该文件"
        description="确认路径相对仓库根目录，或先在“同步状态”页同步。"
      />
    </section>

    <!-- sync -->
    <section v-else-if="view === 'sync'" class="page">
      <h1>同步状态</h1>
      <p class="muted">增量扫描仓库内架构代码、进度文档、历史决策与背景调研；内容未变的文件保持原版本（幂等）。</p>
      <OmPanel title="当前状态" class="stack">
        <div class="row" style="margin-top: 0">
          <OmBadge>最近 commit {{ shortCommit(syncState?.lastSyncCommit ?? null) }}</OmBadge>
          <OmBadge v-if="syncState?.running">同步进行中…</OmBadge>
        </div>
        <p class="muted">
          {{ syncState?.lastSyncAt ? "上次同步 " + new Date(syncState.lastSyncAt).toLocaleString("zh-CN") : "尚未同步过" }}
        </p>
        <div v-if="syncState?.stats" class="sync-grid">
          <div><b>{{ syncState.stats.totalScanned }}</b><small>扫描</small></div>
          <div><b>{{ syncState.stats.imported }}</b><small>新增</small></div>
          <div><b>{{ syncState.stats.updated }}</b><small>更新</small></div>
          <div><b>{{ syncState.stats.unchanged }}</b><small>未变</small></div>
          <div><b>{{ syncState.stats.skipped }}</b><small>跳过</small></div>
        </div>
        <template #actions>
          <OmButton variant="primary" :loading="syncBusy" @click="runSync">立即同步</OmButton>
        </template>
      </OmPanel>
      <OmPanel v-if="lastSyncResult" title="最近一次同步结果" class="stack">
        <p>
          扫描 {{ lastSyncResult.totalScanned }} · 新增 {{ lastSyncResult.imported }} ·
          更新 {{ lastSyncResult.updated }} · 未变 {{ lastSyncResult.unchanged }} ·
          跳过 {{ lastSyncResult.skipped }}
        </p>
        <small>commit {{ shortCommit(lastSyncResult.lastSyncCommit) }} · {{ new Date(lastSyncResult.lastSyncAt).toLocaleString("zh-CN") }}</small>
      </OmPanel>
      <p class="muted">当前为只读浏览/检索模式，不依赖 Agent CLI 或模型。</p>
    </section>

    <div v-if="toast" class="toast" role="status">{{ toast }}</div>
  </OmShell>
</template>

<style scoped>
.cat-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--om-line);
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 12px;
  white-space: nowrap;
}
.cat-badge.architecture {
  color: #1f4e79;
  background: #eef4fb;
}
.cat-badge.progress {
  color: #385f49;
  background: #f1f6f2;
}
.cat-badge.decisions {
  color: #7a4d10;
  background: #faf1e3;
}
.cat-badge.research {
  color: #5b3a8c;
  background: #f3eefb;
}
.source-row {
  cursor: pointer;
}
.source-row:hover {
  border-color: #999;
}
.source-title {
  margin: 8px 0 4px;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.path {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  color: var(--om-muted);
}
.frag-text {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #fafafa;
  border: 1px solid var(--om-line);
  border-radius: 6px;
  padding: 14px 16px;
  margin: 0;
}
.frag-text:not(:first-child) {
  margin-top: 8px;
}
.sync-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  margin-top: 12px;
}
.sync-grid div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sync-grid b {
  font-size: 22px;
}
h4 {
  margin: 18px 0 4px;
}
.relation-row {
  cursor: pointer;
}
.relation-row:hover {
  border-color: #999;
}
.relation-evidence {
  display: block;
  margin-top: 6px;
  color: var(--om-muted);
  font-size: 12px;
}
.removed-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 16px;
  font-size: 13px;
  color: var(--om-secondary);
  cursor: pointer;
}
.snapshot-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin: 4px 0 12px;
}
.version-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 12px;
}
.version-label {
  font-size: 13px;
  color: var(--om-secondary);
  white-space: nowrap;
}
.version-select {
  padding: 4px 8px;
  border: 1px solid var(--om-line);
  border-radius: 5px;
  background: #fff;
  font-size: 13px;
  max-width: 320px;
}
</style>
