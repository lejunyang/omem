<script setup lang="ts">
/** Code Wiki vertical slice container. Owns: repo/snapshot overview, the
 * deterministic SVG module graph, module/file detail, the single controlled
 * trail drawer (>=5 levels, loop detection, breadcrumb, focus/scroll restore),
 * and hash deep-linking. All data comes from the real /api/review/code and
 * /api/review APIs; nothing is mocked. */
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import {
  OmButton,
  OmBadge,
  OmPanel,
  OmEmpty,
  OmRelationGraph,
  OmTrailDrawer,
  type GraphModule,
  type GraphEdge,
  type TrailFrame,
  parseHash,
  writeHash,
} from "@omem/ui";
import {
  codeCurrentSnapshot,
  codeGraph,
  codeRunSync,
  type CodeSnapshot,
  type CodeGraph,
  type CodeFile,
} from "../review-api";
import { aggregateGraph, moduleLabel, type AggModule } from "./modules";
import ModuleFrame from "./ModuleFrame.vue";
import FileFrame from "./FileFrame.vue";
import FragmentFrame from "./FragmentFrame.vue";

type WikiView = "overview" | "graph" | "module" | "file";

const view = ref<WikiView>("overview");
const snapshot = ref<CodeSnapshot | null>(null);
const graph = ref<CodeGraph | null>(null);
const loading = ref(true);
const loadError = ref("");
const syncing = ref(false);

const selectedModule = ref<string>("");
const selectedFile = ref<CodeFile | null>(null);
const anchorLine = ref<number | undefined>();

const modules = computed<AggModule[]>(() =>
  graph.value ? aggregateGraph(graph.value.files, graph.value.symbols, graph.value.edges).modules : [],
);
const graphEdges = computed<GraphEdge[]>(() =>
  graph.value
    ? aggregateGraph(graph.value.files, graph.value.symbols, graph.value.edges).edges
    : [],
);
const graphNodes = computed<GraphModule[]>(() =>
  modules.value.map((m) => ({ id: m.id, label: moduleLabel(m.id), fileCount: m.fileCount, symbolCount: m.symbolCount })),
);

const fileMap = computed(() => new Map((graph.value?.files ?? []).map((f) => [f.fileId, f])));
const symbolMap = computed(() => new Map((graph.value?.symbols ?? []).map((s) => [s.symbolId, s])));

// ---- trail stack ----
const trail = ref<TrailFrame[]>([]);
const trailCurrent = ref(0);
const trailOpen = ref(false);
const loopAt = ref<number | null>(null);
let restoring = false;

async function loadAll() {
  loading.value = true;
  loadError.value = "";
  try {
    const [snap, g] = await Promise.all([codeCurrentSnapshot(), codeGraph()]);
    snapshot.value = snap;
    graph.value = g;
  } catch (e) {
    loadError.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function runSync() {
  syncing.value = true;
  try {
    await codeRunSync();
    await loadAll();
  } catch (e) {
    loadError.value = String(e);
  } finally {
    syncing.value = false;
  }
}

function openModule(id: string) {
  selectedModule.value = id;
  view.value = "module";
  syncHash();
}
function openFile(f: CodeFile, line?: number) {
  selectedFile.value = f;
  anchorLine.value = line;
  view.value = "file";
  syncHash();
}

// ---- trail ----
function pushTrail(frame: Omit<TrailFrame, "id"> & { id: string }) {
  const idx = trail.value.findIndex((f) => f.kind === frame.kind && f.id === frame.id);
  if (idx >= 0) {
    loopAt.value = idx;
    return;
  }
  trail.value = [...trail.value, frame as TrailFrame].slice(-8);
  trailCurrent.value = trail.value.length - 1;
  trailOpen.value = true;
  syncHash();
}
function backTrail() {
  if (trailCurrent.value > 0) trailCurrent.value--;
  else if (trail.value.length) trail.value = [];
  if (!trail.value.length) trailOpen.value = false;
  syncHash();
}
function jumpTrail(i: number) {
  trail.value = trail.value.slice(0, i + 1);
  trailCurrent.value = i;
  syncHash();
}
function closeTrail() {
  trail.value = [];
  trailOpen.value = false;
  syncHash();
}
function dismissLoop() {
  loopAt.value = null;
}

function onDrill(target: {
  type: "file";
  fileId: string;
  line?: number;
} | { type: "fragment"; fragmentId: string; title?: string }) {
  if (target.type === "file") {
    const f = graph.value?.files.find((x) => x.fileId === target.fileId);
    if (!f) return;
    pushTrail({ kind: "file", id: f.fileId, title: f.path.split("/").pop() || f.fileId, fileId: f.fileId, line: target.line });
  } else {
    pushTrail({ kind: "fragment", id: target.fragmentId, title: target.title || "片段", fragmentId: target.fragmentId });
  }
}

// ---- hash routing ----
function syncHash() {
  if (restoring) return;
  let url: string;
  if (view.value === "overview") url = "#/overview";
  else if (view.value === "graph") url = "#/graph";
  else if (view.value === "module") url = "#/module/" + encodeURIComponent(selectedModule.value);
  else if (view.value === "file" && selectedFile.value) {
    url = "#/file/" + encodeURIComponent(selectedFile.value.fileId);
    if (anchorLine.value) url += "?line=" + anchorLine.value;
  } else url = "#/overview";
  if (trail.value.length) {
    url += "/trail/" + trail.value.map((f) => encodeURIComponent(f.kind) + "/" + encodeURIComponent(f.id)).join("/");
  }
  history.replaceState(null, "", url);
}

function restoreFromHash() {
  const route = parseHash(location.hash);
  restoring = true;
  if (route.view.name === "module") openModule(route.view.module);
  else if (route.view.name === "file") {
    const v = route.view as { fileId: string; line?: number }; const f = graph.value?.files.find((x) => x.fileId === v.fileId);
    if (f) openFile(f, v.line);
  } else {
    view.value = route.view.name as WikiView;
  }
  if (route.trail.length) {
    trail.value = route.trail;
    trailCurrent.value = route.trail.length - 1;
    trailOpen.value = true;
  }
  setTimeout(() => (restoring = false), 50);
}

function onPopState() {
  restoreFromHash();
}

onMounted(() => {
  window.addEventListener("popstate", onPopState);
  void loadAll().then(() => restoreFromHash());
});
onBeforeUnmount(() => window.removeEventListener("popstate", onPopState));

const currentFrame = computed(() => trail.value[trailCurrent.value] ?? null);
</script>

<template>
  <div class="code-wiki">
    <div v-if="loadError" class="error-banner" role="alert">
      无法加载代码图：{{ loadError }}
      <OmButton variant="ghost" @click="loadAll">重试</OmButton>
    </div>

    <!-- overview -->
    <section v-if="view === 'overview' && !loading" class="page">
      <span class="eyebrow">仓库 / 快照总览</span>
      <h1>Code Wiki</h1>
      <OmEmpty
        v-if="!snapshot"
        title="还没有代码快照"
        description="先执行一次代码同步，解析仓库内 TS/Vue 文件的符号与边。"
      >
        <OmButton variant="primary" :loading="syncing" @click="runSync">立即同步代码图</OmButton>
      </OmEmpty>
      <template v-else>
        <div class="snap-row">
          <OmBadge>commit {{ snapshot.commit?.slice(0, 8) ?? "—" }}</OmBadge>
          <OmBadge v-if="snapshot.dirty" tone="warning">工作树未提交</OmBadge>
          <OmBadge v-else tone="success">干净</OmBadge>
          <OmBadge>{{ snapshot.parserVersion }}</OmBadge>
          <OmBadge>{{ snapshot.fileCount }} 文件</OmBadge>
          <OmBadge>{{ graph?.symbols.length ?? 0 }} 符号</OmBadge>
          <OmBadge>{{ graph?.edges.length ?? 0 }} 边</OmBadge>
          <OmButton variant="ghost" :loading="syncing" @click="runSync">重新同步</OmButton>
        </div>
        <h2>模块</h2>
        <p class="muted">点击模块查看文件与符号；「依赖图」展示模块间 import 关系。</p>
        <div class="module-grid">
          <OmPanel v-for="m in modules" :key="m.id" class="mod-card" @click="openModule(m.id)">
            <b>{{ moduleLabel(m.id) }}</b>
            <small>{{ m.fileCount }} 文件 · {{ m.symbolCount }} 符号</small>
          </OmPanel>
        </div>
        <div class="row">
          <OmButton variant="primary" @click="view = 'graph'; syncHash()">打开模块依赖图</OmButton>
        </div>
      </template>
    </section>

    <!-- graph -->
    <section v-else-if="view === 'graph'" class="page">
      <div class="row">
        <OmButton variant="ghost" @click="view = 'overview'; syncHash()">< 返回总览</OmButton>
        <h1 style="margin:0">模块依赖图</h1>
      </div>
      <p class="muted">
        确定性分层 SVG：左为被依赖的底层模块，右为入口。数字 = 模块间 confirmed import 边数。虚线 = 候选。
      </p>
      <OmRelationGraph
        v-if="graphNodes.length"
        :modules="graphNodes"
        :edges="graphEdges"
        :selected-id="selectedModule"
        @select-node="openModule"
      />
      <OmEmpty v-else title="图为空" description="先同步代码图。" />
      <div class="mod-list">
        <button
          v-for="m in modules"
          :key="m.id"
          class="mod-list-row"
          @click="openModule(m.id)"
        >
          {{ moduleLabel(m.id) }} <small>{{ m.fileCount }} 文件</small>
        </button>
      </div>
    </section>

    <!-- module -->
    <section v-else-if="view === 'module'" class="page">
      <div class="row">
        <OmButton variant="ghost" @click="view = 'graph'; syncHash()">< 返回图</OmButton>
      </div>
      <ModuleFrame
        v-if="modules.find((m) => m.id === selectedModule)"
        :mod="modules.find((m) => m.id === selectedModule)!"
        @drill="onDrill"
      />
    </section>

    <!-- file -->
    <section v-else-if="view === 'file' && selectedFile" class="page">
      <div class="row">
        <OmButton variant="ghost" @click="view = 'module'; syncHash()">< 返回模块</OmButton>
      </div>
      <FileFrame :file="selectedFile" :anchor-line="anchorLine" :file-map="fileMap" :symbol-map="symbolMap" @drill="onDrill" />
    </section>

    <!-- trail drawer -->
    <OmTrailDrawer
      :open="trailOpen"
      :frames="trail"
      :current="trailCurrent"
      :loop-at="loopAt"
      @close="closeTrail"
      @back="backTrail"
      @jump="jumpTrail"
      @dismiss-loop="dismissLoop"
    >
      <template v-if="currentFrame?.kind === 'module'">
        <ModuleFrame
          v-if="modules.find((m) => m.id === ((currentFrame as TrailFrame).module ?? currentFrame.id))"
          :mod="modules.find((m) => m.id === ((currentFrame as TrailFrame).module ?? currentFrame.id))!"
          @drill="onDrill"
        />
      </template>
      <template v-else-if="currentFrame?.kind === 'file'">
        <FileFrame
          v-if="graph?.files.find((f) => f.fileId === ((currentFrame as TrailFrame).fileId ?? currentFrame.id))"
          :file="graph!.files.find((f) => f.fileId === ((currentFrame as TrailFrame).fileId ?? currentFrame.id))!"
          :anchor-line="(currentFrame as TrailFrame).line" :file-map="fileMap" :symbol-map="symbolMap"
          @drill="onDrill"
        />
      </template>
      <template v-else-if="currentFrame?.kind === 'fragment'">
        <FragmentFrame
          :fragment-id="(currentFrame as TrailFrame).fragmentId ?? currentFrame.id"
          @drill="onDrill"
        />
      </template>
    </OmTrailDrawer>
  </div>
</template>

<style scoped>
.code-wiki { padding: 0 28px 40px; }
.page { max-width: 1100px; }
.eyebrow { font-size: 12px; color: var(--om-muted); letter-spacing: .08em; }
.snap-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin: 12px 0; }
.module-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin: 16px 0; }
.mod-card { cursor:pointer; display:flex; flex-direction:column; gap:4px; }
.mod-card:hover { border-color: var(--om-ink); }
.row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin: 10px 0; }
.muted { color: var(--om-secondary); }
.mod-list { display:flex; flex-wrap:wrap; gap:6px; margin-top:16px; }
.mod-list-row { border:1px solid var(--om-line); background:var(--om-panel); padding:6px 10px; border-radius:6px; font-size:13px; }
.mod-list-row:hover { border-color: var(--om-ink); }
.error-banner { border:1px solid #eccaca; background:#fff0f0; color:var(--om-danger); padding:10px 12px; border-radius:6px; display:flex; gap:10px; align-items:center; margin: 12px 0; }
@media (max-width: 700px) {
  .code-wiki { padding: 0 14px 32px; }
}
</style>
