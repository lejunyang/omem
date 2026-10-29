<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { authUrl, get, post } from "../api";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import { fmtTime, toast } from "../store";

/**
 * Where the data directory's disk space goes (src/core/storage-scan.ts): top-level entries, the
 * files/ store by origin and media type, and the database by module, table and source category.
 * The scan reads every page of the database, so it runs on request in the background.
 */
type FileGroup = { origin: string; type: string; bytes: number; files: number };
type Report = {
  home: string;
  scannedAt: string;
  ms: number;
  dirs: { name: string; bytes: number; files: number }[];
  files: { total: { bytes: number; files: number }; groups: FileGroup[]; largest: { name: string; bytes: number; origin: string; type: string; label?: string }[] };
  db: {
    fileBytes: number;
    walBytes: number;
    freeBytes: number;
    tables: { name: string; module: string; bytes: number; indexBytes: number; rows: number | null }[];
    sources: { category: string; count: number; textBytes: number; chunkBytes: number; vectorBytes: number }[];
  };
};
type Status = { report: Report | null; running: string | null; error: string | null };

const DIRS: Record<string, string> = {
  "omem.db": "数据库", "omem.db-wal": "数据库预写日志", "omem.db-shm": "数据库共享内存", files: "附件与图片（files）", library: "知识库（Wiki、技能、档案）",
  runs: "运行目录", workspaces: "编码工作区", repos: "仓库", ide: "网页版 VS Code", plugins: "插件", "plugin-data": "插件数据", service: "服务日志", secrets: "凭据", bin: "命令行垫片", "config.json": "配置",
};
const ORIGINS: Record<string, string> = { chat: "群聊和私聊附件", "doc-media": "在线文档里的图片和附件", import: "导入或上传的原件", unreferenced: "没有引用的文件" };
const TYPES: Record<string, string> = { image: "图片", video: "视频", audio: "音频", document: "文档", archive: "压缩包", other: "其他" };
const MODULES: Record<string, string> = {
  sources: "原件正文", chunks: "切块与向量", fts: "全文索引", code: "代码符号与调用", lark: "飞书（消息、会议、卡片）", runs: "运行与评审记录",
  chat: "会话与通知", memory: "记忆", wiki: "Wiki", items: "事项", other: "其他",
};
const KINDS: Record<string, string> = { doc: "文档", code: "代码", chat: "聊天", note: "笔记", web: "网页", image: "图片", conversation: "对话", meeting: "会议", activity: "动态" };
const VIA: Record<string, string> = { lark: "飞书", dir: "目录", url: "链接" };
const categoryLabel = (c: string) => {
  const [kind, via] = c.split(":");
  return `${KINDS[kind] ?? kind}${via ? ` · ${VIA[via] ?? via}` : ""}`;
};

const status = ref<Status | null>(null);
const report = computed(() => status.value?.report ?? null);
let timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  try {
    status.value = await get<Status>("/api/storage");
  } catch (e) {
    status.value = { report: status.value?.report ?? null, running: null, error: (e as Error).message };
  }
  poll();
}
function poll() {
  clearTimeout(timer);
  if (status.value?.running) timer = setTimeout(load, 3000);
}
async function scan() {
  try {
    status.value = await post<Status>("/api/storage/scan", {});
  } catch (e) {
    toast((e as Error).message);
  }
  poll();
}
onMounted(load);
onBeforeUnmount(() => clearTimeout(timer));

const fmt = (n: number) => {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
};
const pct = (n: number, total: number) => (total ? `${Math.max(0.5, (n / total) * 100).toFixed(1)}%` : "0%");
const total = computed(() => report.value?.dirs.reduce((s, d) => s + d.bytes, 0) ?? 0);

const fileView = ref<"type" | "origin">("type");
const fileRows = computed(() => {
  const groups = report.value?.files.groups ?? [];
  const key = fileView.value;
  const m = new Map<string, { label: string; bytes: number; files: number; parts: FileGroup[] }>();
  for (const g of groups) {
    const k = g[key];
    const row = m.get(k) ?? { label: (key === "type" ? TYPES : ORIGINS)[k] ?? k, bytes: 0, files: 0, parts: [] };
    row.bytes += g.bytes;
    row.files += g.files;
    row.parts.push(g);
    m.set(k, row);
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes);
});
const partLabel = (g: FileGroup) => (fileView.value === "type" ? ORIGINS : TYPES)[fileView.value === "type" ? g.origin : g.type];

const modules = computed(() => {
  const m = new Map<string, { module: string; bytes: number; tables: Report["db"]["tables"] }>();
  for (const t of report.value?.db.tables ?? []) {
    const row = m.get(t.module) ?? { module: t.module, bytes: 0, tables: [] };
    row.bytes += t.bytes + t.indexBytes;
    row.tables.push(t);
    m.set(t.module, row);
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes);
});
const dbUsed = computed(() => modules.value.reduce((s, m) => s + m.bytes, 0));
const open = ref<string | null>(null);
const sourceMax = computed(() => Math.max(1, ...(report.value?.db.sources ?? []).map((s) => s.textBytes + s.chunkBytes + s.vectorBytes)));
</script>

<template>
  <div class="stack">
    <div class="row wrap">
      <div class="grow stack tight">
        <strong v-if="report">数据目录共 {{ fmt(total) }}</strong>
        <span v-if="report" class="muted small">
          <span class="mono" :title="report.home">{{ report.home }}</span> · {{ fmtTime(report.scannedAt) }}统计，用时 {{ (report.ms / 1000).toFixed(1) }} 秒
        </span>
        <span v-else-if="status && !status.running" class="muted small">还没有统计过。统计会读一遍整个数据库，库大时要几分钟，期间服务照常运行。</span>
      </div>
      <button class="btn" :disabled="!status || !!status.running" @click="scan">
        <Icon name="refresh" :size="14" />{{ status?.running ? "统计中…" : report ? "重新统计" : "开始统计" }}
      </button>
    </div>
    <div v-if="status?.error" class="card pad small danger-text">{{ status.report || status.running ? "上次统计失败" : "读取失败" }}：{{ status.error }}</div>
    <Skeleton v-if="!status || (status.running && !report)" variant="lines" :rows="6" />

    <template v-if="report">
      <section class="card pad stack">
        <div class="section-title">数据目录</div>
        <div v-for="d in report.dirs" :key="d.name" class="bar-row">
          <span class="name" :title="d.name">{{ DIRS[d.name] ?? d.name }}<span v-if="DIRS[d.name]" class="muted mono small"> {{ d.name }}</span></span>
          <span class="bar"><i :style="{ width: pct(d.bytes, total) }" /></span>
          <span class="num">{{ fmt(d.bytes) }}</span>
          <span class="num muted small">{{ d.files.toLocaleString() }} 个文件</span>
        </div>
      </section>

      <section class="card pad stack">
        <div class="row wrap">
          <div class="section-title grow">附件与图片 · {{ fmt(report.files.total.bytes) }}，{{ report.files.total.files.toLocaleString() }} 个</div>
          <UiSegmented v-model="fileView" size="sm" aria-label="附件分组方式" :options="[{ value: 'type', label: '按类型' }, { value: 'origin', label: '按来源' }]" />
        </div>
        <p v-if="!fileRows.length" class="muted small">files 目录是空的。</p>
        <div v-for="r in fileRows" :key="r.label" class="stack tight">
          <div class="bar-row">
            <span class="name">{{ r.label }}</span>
            <span class="bar"><i :style="{ width: pct(r.bytes, report.files.total.bytes) }" /></span>
            <span class="num">{{ fmt(r.bytes) }}</span>
            <span class="num muted small">{{ r.files.toLocaleString() }} 个</span>
          </div>
          <div v-if="r.parts.length > 1" class="parts muted small">
            <span v-for="g in r.parts" :key="g.origin + g.type">{{ partLabel(g) }} {{ fmt(g.bytes) }}（{{ g.files }}）</span>
          </div>
        </div>
        <details v-if="report.files.largest.length">
          <summary class="small">最大的 {{ report.files.largest.length }} 个文件</summary>
          <div class="largest">
            <div v-for="f in report.files.largest" :key="f.name" class="bar-row">
              <a class="name mono small" :href="authUrl(`/api/files/${f.name}`)" target="_blank" rel="noopener" :title="f.label ?? f.name">{{ f.label || f.name }}</a>
              <span class="muted small">{{ TYPES[f.type] }} · {{ ORIGINS[f.origin] }}</span>
              <span class="num">{{ fmt(f.bytes) }}</span>
            </div>
          </div>
        </details>
      </section>

      <section class="card pad stack">
        <div class="section-title">数据库 · 文件 {{ fmt(report.db.fileBytes) }}</div>
        <p class="muted small">
          表和索引共 {{ fmt(dbUsed) }}；预写日志 {{ fmt(report.db.walBytes) }}<template v-if="report.db.freeBytes">；空闲页 {{ fmt(report.db.freeBytes) }}（删除后留下的空间，<span class="mono">vacuum</span> 后才还给磁盘）</template>。点一行展开到表。
        </p>
        <div v-for="m in modules" :key="m.module" class="stack tight">
          <button class="bar-row as-button" :aria-expanded="open === m.module" @click="open = open === m.module ? null : m.module">
            <span class="name"><Icon :name="open === m.module ? 'down' : 'right'" :size="12" />{{ MODULES[m.module] ?? m.module }}</span>
            <span class="bar"><i :style="{ width: pct(m.bytes, dbUsed) }" /></span>
            <span class="num">{{ fmt(m.bytes) }}</span>
            <span class="num muted small">{{ m.tables.length }} 张表</span>
          </button>
          <div v-if="open === m.module" class="tables">
            <div v-for="t in m.tables" :key="t.name" class="bar-row small">
              <span class="name mono" :title="t.name">{{ t.name }}</span>
              <span class="muted">{{ t.rows == null ? "" : `${t.rows.toLocaleString()} 行` }}</span>
              <span class="num">{{ fmt(t.bytes) }}</span>
              <span class="num muted">{{ t.indexBytes ? `索引 ${fmt(t.indexBytes)}` : "" }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="card pad stack">
        <div class="section-title">原件按类别</div>
        <p class="muted small">正文是原件全文，切块是检索用的分段（和正文大致等量），向量只在开了向量模型时有。全文索引另算在上面的“全文索引”里。</p>
        <div v-for="s in report.db.sources" :key="s.category" class="bar-row">
          <span class="name">{{ categoryLabel(s.category) }}<span class="muted small"> {{ s.count.toLocaleString() }} 个</span></span>
          <span class="bar stacked" :title="`正文 ${fmt(s.textBytes)} · 切块 ${fmt(s.chunkBytes)} · 向量 ${fmt(s.vectorBytes)}`">
            <i :style="{ width: pct(s.textBytes, sourceMax) }" /><i class="b" :style="{ width: pct(s.chunkBytes, sourceMax) }" /><i v-if="s.vectorBytes" class="c" :style="{ width: pct(s.vectorBytes, sourceMax) }" />
          </span>
          <span class="num">{{ fmt(s.textBytes + s.chunkBytes + s.vectorBytes) }}</span>
          <span class="num muted small">正文 {{ fmt(s.textBytes) }}</span>
        </div>
        <div class="legend muted small"><span><i />正文</span><span><i class="b" />切块</span><span><i class="c" />向量</span></div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.tight { gap: 4px; }
.grow { flex: 1; min-width: 0; }
.danger-text { color: var(--danger); }
.bar-row {
  display: grid;
  grid-template-columns: minmax(0, 15rem) minmax(4rem, 1fr) 5.5rem 7rem;
  align-items: center;
  gap: 12px;
}
.bar-row .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 4px; }
.bar-row .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.as-button { background: none; border: 0; padding: 4px 0; font: inherit; color: inherit; text-align: left; cursor: pointer; border-radius: var(--radius-sm); }
.as-button:hover { background: var(--hover); }
.bar { height: 8px; background: var(--sunken); border-radius: 4px; overflow: hidden; display: flex; }
.bar i, .legend i { display: block; height: 100%; background: var(--accent); }
.bar i.b, .legend i.b { background: var(--ok); }
.bar i.c, .legend i.c { background: var(--warn); }
.legend { display: flex; gap: 16px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; }
.parts { display: flex; flex-wrap: wrap; gap: 4px 14px; padding-left: 2px; }
.tables, .largest { padding: 4px 0 4px 18px; display: flex; flex-direction: column; gap: 6px; }
.largest .bar-row { grid-template-columns: minmax(0, 1fr) auto 5.5rem; }
.tables .bar-row { grid-template-columns: minmax(0, 1fr) auto 5.5rem 7rem; }
@media (max-width: 760px) {
  .bar-row { grid-template-columns: minmax(0, 1fr) 5rem; }
  .bar-row .bar, .bar-row > .num.muted, .tables .bar-row > .muted { display: none; }
  .largest .bar-row, .tables .bar-row { grid-template-columns: minmax(0, 1fr) 5rem; }
  .largest .bar-row > .muted { display: none; }
}
</style>
