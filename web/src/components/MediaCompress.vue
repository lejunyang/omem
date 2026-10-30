<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { get, post, put } from "../api";
import { confirmDialog } from "../lib/dialog";
import { fmtTime, toast } from "../store";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * Compressing stored media with ffmpeg (src/core/media.ts): install and detect ffmpeg, choose what
 * and how, follow the job. References keep the original name; the server opens the compressed copy.
 */
type Kind = "image" | "video" | "audio";
type Tally = Record<Kind, { files: number; bytes: number }>;
type Tool = { installed: boolean; version: string | null; via: "path" | "osdk" | null };
type Result = { name: string; type: Kind; status: "done" | "kept" | "failed"; from: number; to?: number; error?: string };
type Job = {
  options: { types: Kind[]; mode: "lossless" | "lossy"; quality: string; maxSide: number; deleteOriginals: boolean; limit: number };
  startedAt: string; finishedAt: string | null; stopped: boolean; error: string | null;
  total: number; totalBytes: number; done: number; kept: number; failed: number; processedBytes: number; savedBytes: number;
  running?: { name: string; type: Kind; bytes: number; progress: number }[];
  recent: Result[];
  auto?: boolean;
  resumed?: number;
};
type AutoSettings = { enabled: boolean; types: Kind[]; mode: "lossless" | "lossy"; quality: "high" | "medium" | "low"; maxSide: number; minBytes: number; deleteOriginals: boolean };
type State = {
  ffmpeg: { spec: string; command: string; ffmpeg: Tool; ffprobe: Tool; encoders: string[]; installing: { startedAt: string; log: string } | null; installError: string | null };
  overview: { lossy: Tally; lossless: Tally };
  compressed: { files: number; originalBytes: number; bytes: number; originalsOnDisk: { files: number; bytes: number }; skipped: number; failed: number };
  job: Job | null;
  settings: { concurrency: number; auto: AutoSettings };
  cpus: number;
};

const state = ref<State | null>(null);
const error = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
const busy = computed(() => !!state.value?.ffmpeg.installing || (!!state.value?.job && !state.value.job.finishedAt));
async function load() {
  try {
    state.value = await get<State>("/api/media");
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  }
  poll();
}
function poll() {
  clearTimeout(timer);
  if (busy.value) timer = setTimeout(load, 2000);
}
async function call(path: string, body: unknown = {}) {
  try {
    state.value = await post<State>(path, body);
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
const KINDS: Record<Kind, string> = { image: "图片", video: "视频", audio: "音频" };
const ENCODERS: Record<string, string> = { libwebp: "WebP", libwebp_anim: "WebP 动图", libsvtav1: "AV1", libx264: "H.264", libopus: "Opus", aac: "AAC", flac: "FLAC" };

const mode = ref<"lossy" | "lossless">("lossy");
const quality = ref<"high" | "medium" | "low">("medium");
const types = ref<Kind[]>(["image", "video", "audio"]);
const maxSide = ref(0);
const minBytes = ref(100 * 1024);
const deleteOriginals = ref(true);
const limit = ref(0);
const retryFailed = ref(false);
const concurrencyOptions = computed(() => {
  const n = state.value?.cpus ?? 4;
  return [...new Set([1, 2, 4, 8, 16, n].filter((v) => v <= Math.max(n, 1)))].sort((a, b) => a - b)
    .map((v) => ({ value: v, label: v === n ? `${v}（核数）` : String(v) }));
});
async function saveMedia(patch: Partial<State["settings"]>, ok = "已保存") {
  if (!state.value) return;
  const media = { ...state.value.settings, ...patch };
  try {
    await put("/api/settings", { media });
    state.value.settings = media;
    toast(ok, "ok");
  } catch (e) {
    toast((e as Error).message);
  }
}
const formSettings = (): Omit<AutoSettings, "enabled"> => ({ types: chosen.value.length ? chosen.value : types.value, mode: mode.value, quality: quality.value, maxSide: maxSide.value, minBytes: minBytes.value, deleteOriginals: deleteOriginals.value });
async function setAuto(on: boolean) {
  if (!state.value) return;
  // Turning it on takes what the form says; afterwards "改用上面的设置" updates it.
  const next = on ? { ...formSettings(), enabled: true } : { ...state.value.settings.auto, enabled: false };
  if (on && next.mode === "lossy" && next.deleteOriginals && !(await confirmDialog("新下载的附件有损压缩后删除原文件？", {
    message: "以后飞书聊天、文档里新下载的图片、视频、音频会自动按上面的设置压缩并删掉原文件，损失不能恢复。已有的文件不受影响，要压缩它们照常点“开始压缩”。",
    okText: "打开",
    danger: true,
  }))) return;
  await saveMedia({ auto: next }, on ? "已打开自动压缩" : "已关闭自动压缩");
}
const QUALITY = { high: "高", medium: "均衡", low: "省空间" };
const describe = (a: Omit<AutoSettings, "enabled">) =>
  [a.types.map((t) => KINDS[t]).join("、"), a.mode === "lossy" ? `有损 · ${QUALITY[a.quality]}` : "无损", a.mode === "lossy" && a.maxSide ? `长边 ≤ ${a.maxSide}` : "", a.minBytes ? `跳过小于 ${fmt(a.minBytes)} 的` : "", a.deleteOriginals ? "删除原文件" : "保留原文件"].filter(Boolean).join("，");
const autoDiffers = computed(() => {
  const a = state.value?.settings.auto;
  if (!a) return false;
  const f = formSettings();
  return JSON.stringify(f) !== JSON.stringify({ types: a.types, mode: a.mode, quality: a.quality, maxSide: a.maxSide, minBytes: a.minBytes, deleteOriginals: a.deleteOriginals });
});
const tally = computed(() => state.value?.overview[mode.value]);
const chosen = computed(() => types.value.filter((t) => tally.value?.[t].files));
const chosenBytes = computed(() => chosen.value.reduce((s, t) => s + (tally.value?.[t].bytes ?? 0), 0));
const videoCodec = computed(() => (state.value?.ffmpeg.encoders.includes("libsvtav1") ? "AV1" : "H.264"));
const audioCodec = computed(() => (state.value?.ffmpeg.encoders.includes("libopus") ? "Opus" : "AAC"));

async function start() {
  if (deleteOriginals.value && !limit.value) {
    const ok = await confirmDialog("压缩后删除原文件？", {
      message: mode.value === "lossy"
        ? "有损压缩后原文件会被删除，画质和音质的损失不能恢复。没把握时先“试 20 个”看看效果，或者关掉“压缩后删除原文件”。"
        : "无损压缩后原文件会被删除；内容不变，但文件格式换成了 WebP / FLAC。",
      okText: "开始压缩",
      danger: mode.value === "lossy",
    });
    if (!ok) return;
  }
  await call("/api/media/compress", { types: chosen.value, mode: mode.value, quality: quality.value, maxSide: maxSide.value, minBytes: minBytes.value, deleteOriginals: deleteOriginals.value, limit: limit.value, retryFailed: retryFailed.value });
}
async function deleteOriginalsNow() {
  const o = state.value?.compressed.originalsOnDisk;
  if (!o?.files || !(await confirmDialog(`删除 ${o.files} 个已压缩文件的原件？`, { message: `能腾出 ${fmt(o.bytes)}。删除后打开这些附件看到的是压缩后的版本，原件不能恢复。`, okText: "删除原件", danger: true }))) return;
  await call("/api/media/delete-originals");
}

const job = computed(() => state.value?.job ?? null);
const running = computed(() => !!job.value && !job.value.finishedAt);
const jobPct = computed(() => {
  const j = job.value;
  if (!j?.totalBytes) return 0;
  return Math.min(100, ((j.processedBytes + (j.running ?? []).reduce((s, r) => s + r.bytes * r.progress, 0)) / j.totalBytes) * 100);
});
const left = computed(() => (job.value ? job.value.total - job.value.done - job.value.kept - job.value.failed : 0));
const resultText = (r: Result) =>
  r.status === "done" ? `${fmt(r.from)} → ${fmt(r.to ?? 0)}（${Math.round((1 - (r.to ?? 0) / r.from) * 100)}%↓）` : r.error ?? "";
</script>

<template>
  <section class="card pad stack">
    <div class="section-title">压缩附件</div>
    <div v-if="error" class="small danger-text">读取失败：{{ error }}</div>
    <Skeleton v-if="!state && !error" variant="lines" :rows="3" />
    <template v-if="state">
      <div class="row wrap">
        <div class="grow stack tight">
          <span v-if="state.ffmpeg.ffmpeg.installed">
            <Icon name="check" :size="14" /> ffmpeg {{ state.ffmpeg.ffmpeg.version ?? "" }}
            <span class="muted small">{{ state.ffmpeg.ffmpeg.via === "path" ? "（在 PATH 上）" : "（经 osdk）" }}</span>
          </span>
          <span v-else>还没有 ffmpeg。压缩要用它，经 osdk 安装（<span class="mono small">{{ state.ffmpeg.command }}</span>），下载约一两分钟。</span>
          <span v-if="state.ffmpeg.ffmpeg.installed" class="muted small">
            可用编码：{{ state.ffmpeg.encoders.map((e) => ENCODERS[e] ?? e).join("、") || "没有可用的" }}<template v-if="!state.ffmpeg.ffprobe.installed">；没有 ffprobe，压缩后不核对时长</template>
          </span>
        </div>
        <button v-if="!state.ffmpeg.ffmpeg.installed || state.ffmpeg.installing" class="btn" :disabled="!!state.ffmpeg.installing" @click="call('/api/media/ffmpeg/install')">
          <Icon name="upload" :size="14" />{{ state.ffmpeg.installing ? "安装中…" : "安装 ffmpeg" }}
        </button>
      </div>
      <pre v-if="state.ffmpeg.installing?.log" class="log small">{{ state.ffmpeg.installing.log }}</pre>
      <div v-if="state.ffmpeg.installError" class="small danger-text">安装失败：{{ state.ffmpeg.installError }}。也可以在终端运行 <span class="mono">omem setup ffmpeg</span> 看完整输出。</div>

      <p v-if="state.compressed.files" class="small">
        已压缩 {{ state.compressed.files.toLocaleString() }} 个文件：{{ fmt(state.compressed.originalBytes) }} → {{ fmt(state.compressed.bytes) }}，省下 {{ fmt(state.compressed.originalBytes - state.compressed.bytes) }}<template v-if="state.compressed.skipped">；另有 {{ state.compressed.skipped.toLocaleString() }} 个没压小或失败，保留原样</template>。
      </p>
      <div v-if="state.compressed.originalsOnDisk.files" class="row wrap small">
        <span class="grow">其中 {{ state.compressed.originalsOnDisk.files.toLocaleString() }} 个的原件还在（{{ fmt(state.compressed.originalsOnDisk.bytes) }}），打开时仍用原件。</span>
        <button class="btn sm danger" :disabled="running" @click="deleteOriginalsNow"><Icon name="trash" :size="14" />删除这些原件</button>
      </div>

      <template v-if="state.ffmpeg.ffmpeg.installed">
        <div class="form">
          <span class="label">方式</span>
          <UiSegmented v-model="mode" size="sm" aria-label="压缩方式" :options="[{ value: 'lossy', label: '有损' }, { value: 'lossless', label: '无损' }]" />
          <span class="label">范围</span>
          <div class="row wrap">
            <UiCheckbox v-for="k in (['image', 'video', 'audio'] as Kind[])" :key="k" v-model="types" :value="k" size="sm">
              {{ KINDS[k] }} <span class="muted">{{ tally?.[k].files ? `${tally[k].files.toLocaleString()} 个 · ${fmt(tally[k].bytes)}` : "无" }}</span>
            </UiCheckbox>
          </div>
          <template v-if="mode === 'lossy'">
            <span class="label">质量</span>
            <UiSegmented v-model="quality" size="sm" aria-label="质量" :options="[{ value: 'high', label: '高' }, { value: 'medium', label: '均衡' }, { value: 'low', label: '省空间' }]" />
            <span class="label">长边上限</span>
            <UiSelect v-model="maxSide" size="sm" width="9rem" aria-label="长边上限" :options="[{ value: 0, label: '保持原尺寸' }, { value: 3840, label: '3840（4K）' }, { value: 2560, label: '2560' }, { value: 1920, label: '1920（1080p）' }, { value: 1280, label: '1280（720p）' }]" />
          </template>
          <span class="label">跳过小文件</span>
          <UiSelect v-model="minBytes" size="sm" width="9rem" aria-label="最小文件" :options="[{ value: 0, label: '不跳过' }, { value: 100 * 1024, label: '小于 100 KB' }, { value: 1024 * 1024, label: '小于 1 MB' }, { value: 10 * 1024 * 1024, label: '小于 10 MB' }]" />
          <span class="label">一次处理</span>
          <UiSelect v-model="limit" size="sm" width="9rem" aria-label="一次处理多少" :options="[{ value: 0, label: '全部' }, { value: 20, label: '先试 20 个' }, { value: 200, label: '200 个' }]" />
          <span class="label">同时压缩</span>
          <div class="row wrap">
            <UiSelect :model-value="state.settings.concurrency" size="sm" width="9rem" aria-label="同时压缩几个" :options="concurrencyOptions" @change="(v) => saveMedia({ concurrency: Number(v) })" />
            <span class="muted small">个文件；改了对进行中的压缩也生效，每个 ffmpeg 分到“核数 ÷ 这个数”的线程</span>
          </div>
          <span class="label" />
          <UiCheckbox v-model="deleteOriginals" switch size="sm">压缩后删除原文件<span class="muted">（关掉则两份都留着，确认没问题后再删）</span></UiCheckbox>
          <template v-if="state.compressed.failed">
            <span class="label" />
            <UiCheckbox v-model="retryFailed" size="sm">重试之前失败的 {{ state.compressed.failed.toLocaleString() }} 个<span class="muted">（默认同样设置不再重试）</span></UiCheckbox>
          </template>
        </div>
        <p class="muted small">
          <template v-if="mode === 'lossy'">图片转 WebP，视频转 {{ videoCodec }}（MP4），音频转 {{ audioCodec }}。已经是 WebP / Opus 的跳过。</template>
          <template v-else>PNG、BMP、TIFF、GIF 转无损 WebP，WAV 转 FLAC，内容逐像素、逐采样不变。JPEG 和 MP3 这类本来有损的格式无损重编码只会变大，跳过；视频没有无损压缩，也跳过。</template>
          只有小 10% 以上才替换，否则保留原文件并记下，同样设置不再重试。聊天、文档里原来的引用不变，打开时自动换成压缩后的文件。从大到小处理，ffmpeg 优先级调低。压缩在服务里后台进行，关掉页面不影响；服务重启或机器意外关机后，启动时接着做。
        </p>
        <div class="row wrap">
          <span class="grow small">{{ chosen.length ? `将处理 ${chosen.map((t) => KINDS[t]).join("、")}，共 ${fmt(chosenBytes)}${minBytes ? "（跳过小文件前）" : ""}` : "选中的类型里没有可压缩的文件" }}</span>
          <button v-if="running" class="btn" @click="call('/api/media/stop')"><Icon name="stop" :size="14" />停止</button>
          <button v-else class="btn primary" :disabled="!chosen.length || busy" @click="start"><Icon name="zap" :size="14" />开始压缩</button>
        </div>
        <div class="stack tight auto">
          <UiCheckbox :model-value="state.settings.auto.enabled" switch size="sm" @change="setAuto">新下载的附件自动压缩<span class="muted">（打开之后新存下的图片、视频、音频）</span></UiCheckbox>
          <div v-if="state.settings.auto.enabled" class="row wrap small">
            <span class="grow muted">按 {{ describe(state.settings.auto) }} 压缩；每分钟看一次有没有新文件，有压缩在进行时等它结束。</span>
            <button v-if="autoDiffers" class="btn sm" @click="saveMedia({ auto: { ...formSettings(), enabled: true } }, '自动压缩已改用上面的设置')">改用上面的设置</button>
          </div>
        </div>
      </template>

      <div v-if="job" class="stack tight job">
        <div class="row wrap small">
          <strong class="grow">{{ running ? "压缩中" : job.stopped ? "已停止" : job.error ? "出错停止" : "上次压缩完成" }}<span class="muted"> · {{ job.auto ? "自动压缩新文件 · " : "" }}{{ fmtTime(job.startedAt) }}开始 · {{ job.options.mode === "lossy" ? "有损" : "无损" }}<template v-if="job.resumed"> · 接着做过 {{ job.resumed }} 次</template></span></strong>
          <span>{{ (job.done + job.kept + job.failed).toLocaleString() }} / {{ job.total.toLocaleString() }} 个 · 省下 {{ fmt(job.savedBytes) }}</span>
        </div>
        <span class="bar"><i :style="{ width: `${jobPct.toFixed(1)}%` }" /></span>
        <div class="row wrap small">
          <span class="muted grow">压小 {{ job.done }}，没压小 {{ job.kept }}，失败 {{ job.failed }}<template v-if="running && job.running?.length"> · 正在处理 {{ job.running.length }} 个</template></span>
          <button v-if="job.stopped && left > 0 && !busy && state.ffmpeg.ffmpeg.installed" class="btn sm" @click="call('/api/media/resume')"><Icon name="play" :size="14" />继续剩下的 {{ left.toLocaleString() }} 个</button>
        </div>
        <div v-if="running && job.running?.length" class="recent">
          <div v-for="r in job.running" :key="r.name" class="result small">
            <span class="mono name" :title="r.name">{{ r.name }}</span>
            <span class="muted">{{ KINDS[r.type] }}</span>
            <span class="muted">{{ fmt(r.bytes) }}<template v-if="r.progress"> · {{ Math.round(r.progress * 100) }}%</template></span>
          </div>
        </div>
        <div v-if="job.error" class="small danger-text">{{ job.error }}</div>
        <details v-if="job.recent.length">
          <summary class="small">最近 {{ job.recent.length }} 个结果</summary>
          <div class="recent">
            <div v-for="r in job.recent" :key="r.name" class="result small">
              <span class="mono name" :title="r.name">{{ r.name }}</span>
              <span class="muted">{{ KINDS[r.type] }}</span>
              <span :class="{ 'danger-text': r.status === 'failed', muted: r.status === 'kept' }" :title="resultText(r)">{{ resultText(r) }}</span>
            </div>
          </div>
        </details>
      </div>
    </template>
  </section>
</template>

<style scoped>
.tight { gap: 4px; }
.grow { flex: 1; min-width: 0; }
.danger-text { color: var(--danger); }
.form { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 16px; align-items: center; }
.form .label { color: var(--muted); font-size: 13px; }
.form > :not(.label) { justify-self: start; }
.log { max-height: 10rem; overflow: auto; background: var(--sunken); padding: 8px; border-radius: var(--radius-sm); white-space: pre-wrap; word-break: break-all; margin: 0; }
.auto, .job { border-top: 1px solid var(--line); padding-top: 12px; }
.bar { height: 8px; background: var(--sunken); border-radius: 4px; overflow: hidden; display: flex; }
.bar i { display: block; height: 100%; background: var(--accent); transition: width 0.4s; }
.recent { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 0 18px; }
.result { display: grid; grid-template-columns: minmax(0, 12rem) 3rem minmax(0, 1fr); gap: 12px; }
.result > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 760px) {
  .form { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .form .label:empty { display: none; }
  .result { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .result > span:nth-child(2) { display: none; }
}
</style>
