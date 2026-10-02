<script setup lang="ts">
import ChangeHistory from "./ChangeHistory.vue";
import DailyAssistant from "./DailyAssistant.vue";
import TaskFollowUpControls from "./TaskFollowUpControls.vue";
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import {
  OmShell,
  OmMarkdown,
  OmCodeViewer,
  OmButton,
  OmIcon,
  OmBadge,
  OmPanel,
  OmEmpty,
  OmCitation,
  OmDisclosure,
  OmTrailDrawer,
  useEvidenceTrail,
} from "@omem/ui";
import KnowledgeFrame from "./knowledge/KnowledgeFrame.vue";
import type {
  RetrievalHit,
  RetrievalPurpose,
  SourceAnchor,
} from "../../server/src/retrieval/port";
import {
  api,
  type Source,
  type Revision,
  type Fragment,
  type Profile,
  type Notification,
  type Task,
  type Change,
  type Job,
  type Proposal,
  type Decision,
  type NotificationDetail as NotificationDetailType,
} from "./api";
import EvidenceReader from "./EvidenceReader.vue";
import ChatPane from "./ChatPane.vue";
import AssetImage from "./AssetImage.vue";
import PersonalKnowledge from "./knowledge/PersonalKnowledge.vue";
import LearningView from "./LearningView.vue";
import DecisionsView from "./DecisionsView.vue";
import NotificationDetail from "./NotificationDetail.vue";
import LarkSetup from "./LarkSetup.vue";
const navigation = [
  ["daily", "spark", "日常助理"],
  ["knowledge", "book", "知识库"],
  ["read", "layers", "原始材料"],
  ["capture", "plus", "输入材料"],
  ["learning", "spark", "材料处理"],
  ["decisions", "check", "待判断"],
  ["tasks", "check", "事项与待办"],
  ["changes", "clock", "变更历史"],
  ["notifications", "spark", "通知中心"],
  ["lark", "layers", "飞书机器人"],
  ["settings", "layers", "能力与连接"],
];
function hashView() {
  const key = location.hash.replace(/^#\//, "").split(/[/?]/)[0];
  return key === "design" || navigation.some(([id]) => id === key)
    ? key!
    : "knowledge";
}
const view = ref(
  location.hash
    ? hashView()
    : sessionStorage.getItem("omem-view") || "knowledge",
);
function syncView() {
  view.value = hashView();
}
const pageTitle = computed(
  () =>
    navigation.find(([id]) => id === view.value)?.[2] ??
    (view.value === "design" ? "组件预览" : "知识库"),
);
const sources = ref<Source[]>([]);
const revision = ref<Revision | null>(null);
const focus = ref<Fragment | null>(null);
const profiles = ref<Profile[]>([]);
const profileId = ref("traex");
const model = ref("");
const effort = ref("");
const notifications = ref<Notification[]>([]);
const tasks = ref<Task[]>([]);
const changes = ref<Change[]>([]);
const jobs = ref<Job[]>([]);
const proposals = ref<Proposal[]>([]);
const decisions = ref<Decision[]>([]);
const notificationDetail = ref<NotificationDetailType | null>(null);
const notificationOpen = ref(false);
const notificationLoading = ref(false);
const error = ref("");
const pollError = ref("");
watch(view, () => {
  error.value = "";
  query.value = "";
  sessionStorage.setItem("omem-view", view.value);
  if (hashView() !== view.value) location.hash = "/" + view.value;
});
const reviewMode = ref(false);
const connecting = ref(true);
const connectionError = ref("");
let bootRetryTimer: ReturnType<typeof setTimeout>;
const booting = ref(false);
const busy = ref(false);
const probing = ref(false);
const probeError = ref("");
const probeNote = ref("");
const accessProtected = ref(false);
const processing = ref({ running: false, enabled: false });
const toast = ref("");
const token = ref("");
const evidence = ref<InstanceType<typeof EvidenceReader>>();
const query = ref("");
const sourceQuery = ref("");
const results = ref<RetrievalHit[]>([]);
const searchPurpose = ref<RetrievalPurpose>("balanced");
const {
  open: searchOpen,
  frames: searchFrames,
  current: searchCurrent,
  active: searchActive,
  trigger: searchTrigger,
  loopAt: searchLoopAt,
  push: pushSearch,
  back: backSearch,
  jump: jumpSearch,
  close: closeSearch,
} = useEvidenceTrail();
const resultKinds = {
  source: "原始材料",
  knowledge: "讲解",
  memory: "已应用记忆",
  task: "当前事项",
};
function readSearchResult(result: RetrievalHit, reference?: SourceAnchor) {
  const target = reference ?? result.target;
  if (target.kind === "task") {
    query.value = "";
    view.value = "tasks";
    return;
  }
  if (target.kind === "memory") {
    if (result.references[0]) readSearchResult(result, result.references[0]);
    return;
  }
  pushSearch({
    kind: target.kind,
    id: JSON.stringify(target),
    title: result.title,
  });
}
function readSearchCitation(result: RetrievalHit, citation: string) {
  if (result.target.kind !== "knowledge") return;
  const label =
    result.citations?.find((c) => c.key === citation)?.label ?? "原文引用";
  pushSearch({
    kind: "citation",
    id: JSON.stringify({
      document: result.target.key,
      revision: result.target.revision,
      citation,
    }),
    title: label,
  });
}
const history = ref<{ id: string; title: string; version: number }[]>([]);
const options = ref<
  { id: string; name: string; values: { value: string; name: string }[] }[]
>([]);
const notificationMode = ref("instant");
let pollTimer: ReturnType<typeof setInterval>;
let toastTimer: ReturnType<typeof setTimeout>;
let searchVersion = 0;
let searchTimer: ReturnType<typeof setTimeout>;
let searchController: AbortController | undefined;
const searching = ref(false),
  searchError = ref("");
watch(
  [query, searchPurpose],
  () => {
    clearTimeout(searchTimer);
    searchController?.abort();
    const version = ++searchVersion;
    results.value = [];
    searchError.value = "";
    searching.value = !!query.value.trim();
    if (searching.value)
      searchTimer = setTimeout(
        () => void search(version, query.value.trim()),
        250,
      );
  },
  { flush: "sync" },
);
let lastNotificationId = "";
let refreshing = false;
const input = ref({
  title: "",
  text: "",
  url: "",
  source: "manual",
  externalId: "",
  filePath: "",
  repo: "",
  gitPath: "",
  gitRef: "HEAD",
});
const image = ref<{
  type: "image";
  mimeType: string;
  data: string;
  label: string;
} | null>(null);
const taskDraft = ref({ title: "", detail: "", dueAt: "" });
const importMode = ref("text");
const unread = computed(
  () => notifications.value.filter((n) => !n.readAt).length,
);
const selectedProfile = computed(() =>
  profiles.value.find((p) => p.id === profileId.value),
);
function say(text: string) {
  clearTimeout(toastTimer);
  toast.value = text;
  toastTimer = setTimeout(() => (toast.value = ""), 6000);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    [
      sources.value,
      notifications.value,
      tasks.value,
      changes.value,
      jobs.value,
      proposals.value,
      decisions.value,
    ] = await Promise.all([
      api<Source[]>("/sources"),
      api<Notification[]>("/notifications"),
      api<Task[]>("/tasks"),
      api<Change[]>("/changes"),
      api<Job[]>("/jobs"),
      api<Proposal[]>("/proposals"),
      api<Decision[]>("/decisions"),
    ]);
    if (revision.value) {
      const head = sources.value.find(
        (s) => s.sourceId === revision.value!.sourceId,
      );
      if (head) revision.value.current = head.id === revision.value.id;
    }
    const latest = notifications.value[0];
    if (
      notificationMode.value === "instant" &&
      lastNotificationId &&
      latest &&
      latest.id !== lastNotificationId
    )
      say(
        notifications.value
          .slice(
            0,
            Math.max(
              1,
              notifications.value.findIndex((n) => n.id === lastNotificationId),
            ),
          )
          .map((n) => n.title + "：" + n.body)
          .join("；"),
      );
    lastNotificationId = latest?.id || "none";
    pollError.value = "";
  } catch (e) {
    pollError.value = String(e);
  } finally {
    refreshing = false;
  }
}
async function boot() {
  if (booting.value) return;
  booting.value = true;
  clearTimeout(bootRetryTimer);
  clearInterval(pollTimer);
  error.value = "";
  connectionError.value = "";
  // Review mode: the dev/prod server behind /api is the repo-review knowledge base,
  // not the personal workspace. Detect it before touching business APIs.
  try {
    const token = sessionStorage.getItem("omem-token");
    const r = await fetch("/api/review/health", {
      headers: token ? { Authorization: "Bearer " + token } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const h = (await r.json()) as { mode?: string };
      if (h && h.mode === "review") {
        reviewMode.value = true;
        connecting.value = false;
        booting.value = false;
        return;
      }
      throw Error("服务返回了无法识别的运行模式");
    }
    // Only a real missing review route identifies the personal server. A proxy
    // failure while the API is syncing must never start personal API polling.
    if (r.status !== 404)
      throw Error(
        r.status === 401
          ? "服务需要访问令牌"
          : `服务暂未就绪（HTTP ${r.status}）`,
      );
    const health = await api<{
      notificationMode: string;
      accessProtected: boolean;
      processingEnabled: boolean;
      learning: { running: boolean; enabled: boolean };
    }>("/health");
    accessProtected.value = health.accessProtected;
    processing.value = {
      ...health.learning,
      enabled: health.processingEnabled,
    };
    notificationMode.value = health.notificationMode;
    connecting.value = false;
  } catch (e) {
    connectionError.value = e instanceof Error ? e.message : String(e);
    booting.value = false;
    bootRetryTimer = setTimeout(() => void boot(), 2000);
    return;
  }
  try {
    profiles.value = await api("/profiles");
    if (!profiles.value.some((p) => p.id === profileId.value))
      profileId.value = profiles.value[0]?.id || "";
    setProfile();
    await refresh();
    if (sources.value[0] && !revision.value)
      await openRevision(sources.value[0].id, false);
  } catch (e) {
    error.value = String(e);
  } finally {
    booting.value = false;
    pollTimer = setInterval(() => void refresh(), 2500);
  }
}
async function openRevision(id: string, navigate = true) {
  if (navigate) view.value = "read";
  try {
    revision.value = await api("/revisions/" + id);
    focus.value = revision.value!.fragments[0] || null;
    history.value = await api(
      "/sources/" + revision.value!.sourceId + "/history",
    );
  } catch (e) {
    error.value = String(e);
  }
}
async function search(version: number, text: string) {
  const controller = new AbortController();
  searchController = controller;
  try {
    const response = await api<typeof results.value>(
      "/search?" +
        new URLSearchParams({ q: text, purpose: searchPurpose.value }),
      undefined,
      "GET",
      controller.signal,
    );
    if (version === searchVersion) results.value = response;
  } catch (e) {
    if (version === searchVersion && !controller.signal.aborted)
      searchError.value = String(e);
  } finally {
    if (version === searchVersion) searching.value = false;
  }
}
async function upload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 5_000_000
  ) {
    error.value = "支持 PNG/JPEG/WebP，单张不超过 5 MB";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    image.value = {
      type: "image",
      mimeType: file.type,
      data: String(reader.result).split(",")[1]!,
      label: file.name,
    };
  };
  reader.readAsDataURL(file);
}
async function capture() {
  busy.value = true;
  error.value = "";
  try {
    let response: { revision: Revision; duplicate: boolean };
    if (importMode.value === "lark")
      response = await api("/connectors/lark", { url: input.value.url });
    else if (importMode.value === "file")
      response = await api("/connectors/file", { path: input.value.filePath });
    else if (importMode.value === "git")
      response = await api("/connectors/git", {
        repo: input.value.repo,
        path: input.value.gitPath,
        ref: input.value.gitRef,
      });
    else {
      const parts: unknown[] = [];
      if (input.value.text.trim())
        parts.push({ type: "text", text: input.value.text });
      if (input.value.url.trim())
        parts.push({ type: "link", url: input.value.url, label: "附带链接" });
      if (image.value) parts.push(image.value);
      response = await api("/captures", {
        source: input.value.source,
        externalId: input.value.externalId || crypto.randomUUID(),
        title: input.value.title,
        parts,
        context: {},
        provenance: {
          collectorId: "omem-web",
          actorId: input.value.source === "manual" ? "owner" : null,
          actorType: input.value.source === "manual" ? "owner" : "unknown",
          actorVerifiedBy:
            input.value.source === "manual"
              ? "authenticated-web-session"
              : null,
          sourceUri: input.value.url || null,
          eventId: crypto.randomUUID(),
          eventAt: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          quoted: false,
          forwarded: false,
          producerKind: "original",
        },
      });
    }
    await refresh();
    await openRevision(response.revision.id);
    say(
      response.duplicate
        ? "材料内容未改变，复用原版本"
        : "材料已保存，固定证据片段已生成",
    );
    input.value.title = "";
    input.value.text = "";
    image.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
async function createTask() {
  try {
    await api("/tasks", {
      title: taskDraft.value.title,
      detail: taskDraft.value.detail,
      dueAt: taskDraft.value.dueAt
        ? new Date(taskDraft.value.dueAt).toISOString()
        : null,
      ...(focus.value ? { evidenceId: focus.value.id } : {}),
    });
    taskDraft.value = { title: "", detail: "", dueAt: "" };
    await refresh();
  } catch (e) {
    error.value = String(e);
  }
}
async function changeTask(t: Task) {
  try {
    await api(
      "/tasks/" + t.id,
      {
        status: ["done", "cancelled"].includes(t.status) ? "open" : "done",
        expectedVersion: t.version,
      },
      "PATCH",
    );
    await refresh();
  } catch (e) {
    error.value = String(e);
  }
}
async function readNotification(n: Notification) {
  try {
    await api("/notifications/" + n.id + "/read", {});
    await refresh();
  } catch (e) {
    error.value = String(e);
  }
}
async function openNotification(n: Notification) {
  notificationOpen.value = true;
  notificationLoading.value = true;
  notificationDetail.value = null;
  try {
    notificationDetail.value = await api<NotificationDetailType>(
      "/notifications/" + n.id,
    );
    if (!n.readAt) await readNotification(n);
  } catch (e) {
    error.value = String(e);
  } finally {
    notificationLoading.value = false;
  }
}
async function restore(c: Change) {
  if (!c.afterId) return;
  try {
    const r = await api<Revision>("/changes/" + c.id + "/restore", {
      expectedHead: c.afterId,
    });
    await refresh();
    await openRevision(r.id);
    say("已恢复为新版本，历史保留");
  } catch (e) {
    error.value = String(e);
  }
}
let probeGeneration = 0;
async function probe() {
  const requestedProfile = profileId.value;
  if (!requestedProfile) return;
  const run = ++probeGeneration;
  probing.value = true;
  probeError.value = "";
  probeNote.value = "";
  try {
    const response = await api<{
      configOptions?: {
        id: string;
        name: string;
        type: string;
        options?: (
          | { value: string; name: string }
          | { options: { value: string; name: string }[] }
        )[];
      }[];
      note?: string;
    }>("/profiles/" + requestedProfile + "/probe", {});
    if (run !== probeGeneration) return;
    options.value = (response.configOptions || [])
      .filter((o) => o.type === "select")
      .map((o) => ({
        id: o.id,
        name: o.name,
        values: (o.options || []).flatMap((v) =>
          "options" in v ? v.options : [v],
        ),
      }));
    probeNote.value = response.note || "已读取此 Agent 支持的模型与思考强度";
  } catch (e) {
    if (run === probeGeneration) probeError.value = String(e);
  } finally {
    if (run === probeGeneration) probing.value = false;
  }
}
function setProfile() {
  model.value = selectedProfile.value?.model || "";
  effort.value = selectedProfile.value?.effort || "";
  options.value = [];
  probeNote.value = "";
  probeGeneration++;
  probing.value = false;
  if (view.value === "settings") void probe();
}
watch(view, (v) => {
  if (v === "settings" && !probeNote.value && !probing.value) void probe();
});
function saveToken() {
  sessionStorage.setItem("omem-token", token.value);
  token.value = "";
  void boot();
}
onMounted(() => {
  window.addEventListener("hashchange", syncView);
  void boot();
});
onBeforeUnmount(() => {
  window.removeEventListener("hashchange", syncView);
  clearTimeout(bootRetryTimer);
  clearInterval(pollTimer);
  clearTimeout(toastTimer);
  clearTimeout(searchTimer);
  searchController?.abort();
  searchVersion++;
});
</script>
<template>
  <OmShell v-if="connecting">
    <OmPanel title="正在连接服务">
      <p role="status">正在等待服务就绪，连接恢复后会自动进入对应工作区。</p>
      <p v-if="connectionError">{{ connectionError }}</p>
      <OmButton :disabled="booting" @click="boot">重新连接</OmButton>
      <OmDisclosure title="访问令牌">
        <label for="startup-token">服务访问令牌</label>
        <input
          id="startup-token"
          v-model="token"
          type="password"
          autocomplete="off"
        />
        <OmButton @click="saveToken">保存并连接</OmButton>
      </OmDisclosure>
    </OmPanel>
  </OmShell>
  <OmPanel v-else-if="reviewMode" title="知识库已合并到主应用"
    ><p>
      请使用 osdk run dev 启动统一的个人助理。仓库知识将在同一个知识库中展示。
    </p></OmPanel
  >
  <OmShell v-else
    ><template #top
      ><div class="top-controls">
        <input
          v-model="query"
          aria-label="搜索材料"
          placeholder="搜索材料与经历…"
        /><OmButton
          variant="ghost"
          class="notification-button"
          @click="view = 'notifications'"
          >通知 <span v-if="unread">{{ unread }}</span></OmButton
        >
      </div></template
    ><template #navigation
      ><div class="workspace-title">
        <b>我的工作记忆</b><small>个人空间 · 本地 / 服务器</small>
      </div>
      <nav class="navigation">
        <button
          v-for="[id, icon, label] in navigation"
          :key="id"
          :title="label"
          :class="{ active: view === id }"
          @click="
            view = id;
            query = '';
          "
        >
          <OmIcon :name="icon" />{{ label }}
        </button>
      </nav>
    </template>
    <div class="page-bar">
      <span>我的工作记忆 / {{ pageTitle }}</span
      ><OmBadge>个人版 · 基础链路</OmBadge>
    </div>
    <div v-if="error || pollError" class="error-banner" role="alert">
      {{ error || pollError
      }}<OmButton
        variant="ghost"
        @click="
          error = '';
          pollError = '';
        "
        >关闭提示</OmButton
      >
    </div>
    <section v-if="query.trim()" class="page" :aria-busy="searching">
      <h1>搜索“{{ query }}”</h1>
      <p class="muted">
        先读相关讲解，再沿引用查看原文和实现；当前事项与已应用记忆也可一起查找。
      </p>
      <label class="search-purpose"
        >查找用途
        <select v-model="searchPurpose">
          <option value="balanced">综合查找</option>
          <option value="concept">理解概念</option>
          <option value="implementation">定位实现</option>
          <option value="background">了解背景</option>
          <option value="follow-up">跟进事项</option>
        </select></label
      >
      <p v-if="searching" class="search-loading" role="status">
        <span class="search-spinner" aria-hidden="true" />正在搜索相关材料…
      </p>
      <p v-else-if="searchError" class="error" role="alert">
        搜索失败：{{ searchError }}
        <OmButton
          variant="secondary"
          @click="
            searching = true;
            search(++searchVersion, query.trim());
          "
          >重试</OmButton
        >
      </p>
      <OmPanel v-for="r in results" :key="r.id" :title="r.title" class="stack"
        ><p class="search-section">
          {{ resultKinds[r.kind]
          }}<span v-if="r.headingPath.length">
            · {{ r.headingPath.join(" / ") }}</span
          ><span v-if="r.target.kind === 'source'">
            · 第 {{ r.target.startLine }}–{{ r.target.endLine }} 行</span
          >
        </p>
        <OmMarkdown
          v-if="r.kind === 'knowledge'"
          :source="r.text"
          :citations="r.citations"
          @cite="readSearchCitation(r, $event)"
        />
        <p v-else class="excerpt">{{ r.text }}</p>
        <div class="search-actions">
          <OmButton
            v-if="r.kind !== 'memory' || r.references.length"
            variant="secondary"
            @click="readSearchResult(r)"
            >{{
              r.kind === "knowledge"
                ? "阅读讲解"
                : r.kind === "task"
                  ? "查看事项"
                  : r.kind === "memory"
                    ? "查看原始依据"
                    : "阅读原文"
            }}</OmButton
          >
          <OmButton
            v-if="r.kind === 'knowledge' && r.references.length"
            variant="ghost"
            @click="readSearchResult(r, r.references[0])"
            >查看对应原文</OmButton
          >
        </div></OmPanel
      ><OmEmpty
        v-if="!searching && !searchError && !results.length"
        title="未找到相关内容"
        description="试试原文关键词，或先导入材料。"
      />
    </section>
    <section v-else-if="view === 'read'" class="materials-layout">
      <aside class="materials-directory" aria-label="材料目录">
        <h4 class="nav-heading">
          材料目录 <small>{{ sources.length }}</small>
        </h4>
        <input
          v-model="sourceQuery"
          aria-label="查找原始材料"
          placeholder="查找原始材料"
          class="source-filter"
        />
        <button
          v-for="s in sources
            .filter((s) =>
              s.title.toLowerCase().includes(sourceQuery.toLowerCase()),
            )
            .slice(0, 80)"
          :key="s.id"
          class="source-link"
          :class="{ selected: revision?.sourceId === s.sourceId }"
          @click="
            openRevision(s.id);
            query = '';
          "
        >
          <span>{{ s.title }}</span
          ><small>{{ s.source }} · v{{ s.version }}</small>
        </button>
        <p v-if="!sources.length" class="muted">
          导入第一份材料，开始积累记忆。
        </p>
        <small v-if="sources.length > 80">显示前 80 项，可输入名称筛选。</small>
      </aside>
      <div class="page reader">
        <template v-if="revision"
          ><div class="row">
            <OmBadge>{{ revision.source }}</OmBadge
            ><OmBadge :tone="revision.current ? 'neutral' : 'warning'"
              >v{{ revision.version }} ·
              {{ revision.current ? "当前版本" : "历史版本" }}</OmBadge
            >
          </div>
          <h1>{{ revision.title }}</h1>
          <p class="muted">
            保存于 {{ new Date(revision.createdAt).toLocaleString("zh-CN") }} ·
            每个片段都有固定身份
          </p>
          <OmCodeViewer
            v-if="/\.(?:[cm]?[jt]sx?|vue|json|toml|css)$/.test(revision.title)"
            :code="
              revision.parts
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n')
            "
            :language="revision.title.split('.').pop()"
          />
          <OmMarkdown
            v-else
            :source="
              revision.parts
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n\n')
            "
          />
          <OmDisclosure class="stack" title="选择原文提问或查看来源">
            <div v-for="f in revision.fragments" :key="f.id" class="fragment">
              <p>
                {{ f.text.slice(0, 120) }}{{ f.text.length > 120 ? "…" : "" }}
              </p>
              <OmButton variant="ghost" @click="focus = f">就这段提问</OmButton>
              <OmCitation label="打开这段原文" @open="evidence?.open(f.id)" />
            </div>
          </OmDisclosure>
          <template v-for="(p, i) in revision.parts" :key="i"
            ><AssetImage
              v-if="p.type === 'image'"
              :id="p.assetId"
              :label="p.label"
          /></template>
          <OmDisclosure class="stack" title="版本历史"
            ><template #title>版本历史 · {{ history.length }}</template>
            <div class="row">
              <OmButton
                v-for="h in history"
                :key="h.id"
                @click="openRevision(h.id)"
                >v{{ h.version }}</OmButton
              >
            </div>
          </OmDisclosure></template
        ><OmEmpty
          v-else
          title="让第一份材料，成为有来处的记忆"
          description="输入文本、图片或链接，也可以从飞书文档和 Git 导入。"
          ><OmButton variant="primary" @click="view = 'capture'"
            >输入材料</OmButton
          ></OmEmpty
        >
      </div>
    </section>
    <section v-else-if="view === 'capture'" class="page">
      <span class="eyebrow">记忆的起点</span>
      <h1>输入材料</h1>
      <p class="muted">
        群聊、屏幕观测、Agent 会话都可以按相同的多模态协议接入。
      </p>
      <div class="tabs">
        <OmButton
          v-for="[id, label] in [
            ['text', '文本＋图片＋链接'],
            ['lark', '飞书文档'],
            ['git', 'Git 文件'],
            ['file', '服务器文本文件'],
          ]"
          :key="id"
          :variant="importMode === id ? 'primary' : 'ghost'"
          @click="importMode = id"
          >{{ label }}</OmButton
        >
      </div>
      <form class="form" @submit.prevent="capture">
        <template v-if="importMode === 'text'"
          ><label
            >材料标题<input
              v-model="input.title"
              required
              placeholder="例如：会议中的需求与行动项"
          /></label>
          <div class="form-grid">
            <label
              >来源类型<select v-model="input.source">
                <option value="manual">主动输入</option>
                <option value="chat">群聊材料</option>
                <option value="screen">屏幕观测</option>
                <option value="agent">Agent 会话</option>
              </select></label
            ><label
              >来源标识（相同标识产生新版本）<input
                v-model="input.externalId"
                placeholder="可留空，自动分配"
            /></label>
          </div>
          <label
            >材料正文<textarea
              v-model="input.text"
              rows="9"
              placeholder="输入或粘贴材料；段落会成为固定片段。"
            /></label
          ><label
            >附带链接<input
              v-model="input.url"
              type="url"
              placeholder="https://…" /></label
          ><label
            >附带图片<input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              @change="upload"
            /><small>{{
              image?.label || "最多一张，5 MB；API 支持多图片。"
            }}</small></label
          ></template
        ><template v-else-if="importMode === 'lark'"
          ><label
            >飞书文档或 Wiki 链接<input
              v-model="input.url"
              required
              type="url"
              placeholder="https://…/docx/…"
          /></label>
          <p class="muted">
            调用服务器已有的 lark-cli 用户登录态读取，不会自动共享或写回文档。
          </p></template
        ><template v-else-if="importMode === 'git'"
          ><label
            >服务器 Git 仓库路径<input v-model="input.repo" required /></label
          ><label
            >仓库内文件路径<input v-model="input.gitPath" required /></label
          ><label>Git ref<input v-model="input.gitRef" required /></label>
          <p class="muted">
            只读取指定 commit 文件，不 pull 或执行仓库脚本；仓库须在
            captureRoots 内。
          </p></template
        ><template v-else
          ><label
            >服务器文件路径<input v-model="input.filePath" required
          /></label>
          <p class="muted">
            只读取配置 captureRoots 允许的 UTF-8 文件，最多 500 KB。
          </p></template
        ><OmButton type="submit" variant="primary" :loading="busy"
          >保存材料与证据</OmButton
        >
      </form>
    </section>
    <PersonalKnowledge v-else-if="view === 'knowledge'" />
    <LearningView
      v-else-if="view === 'learning'"
      :jobs="jobs"
      :processing="processing"
      :sources="sources"
      :proposals="proposals"
      @refresh="refresh"
      @open="(id) => evidence?.open(id)"
      @error="(text) => (error = text)" />
    <DecisionsView
      v-else-if="view === 'decisions'"
      :decisions="decisions"
      @refresh="refresh"
      @open="(id) => evidence?.open(id)"
      @error="(text) => (error = text)"
      @notice="say" />
    <DailyAssistant
      v-else-if="view === 'daily'"
      @open="(id) => evidence?.open(id)"
      @refresh="refresh" />
    <section v-else-if="view === 'tasks'" class="page">
      <span class="eyebrow">从工作中记下要推进的事</span>
      <h1>需求与待办</h1>
      <p class="muted">
        可在助手中交办、改期、登记等待或稍后跟进。截止时间与跟进时间分开，提醒进入通知中心；完成或取消后停止提醒。
      </p>
      <form class="form" @submit.prevent="createTask">
        <label
          >事项<input
            v-model="taskDraft.title"
            required
            placeholder="下一步要做什么？" /></label
        ><label>补充背景<textarea v-model="taskDraft.detail" rows="2" /></label
        ><label
          >到期时间<input
            v-model="taskDraft.dueAt"
            type="datetime-local" /></label
        ><small v-if="focus">将关联当前选中片段 {{ focus.ordinal + 1 }}</small
        ><OmButton type="submit" variant="primary">记录待办</OmButton>
      </form>
      <OmPanel v-for="t in tasks" :key="t.id" class="stack" :title="t.title"
        ><OmBadge :tone="t.status === 'done' ? 'success' : 'neutral'">{{
          {
            done: "已完成",
            waiting: "等待回复",
            cancelled: "已取消",
            open: "待推进",
          }[t.status]
        }}</OmBadge>
        <p>{{ t.detail }}</p>
        <p v-if="t.followUp?.waiting_on">等待：{{ t.followUp.waiting_on }}</p>
        <small v-if="t.followUp?.next_check_at"
          >下次跟进
          {{
            new Date(t.followUp.next_check_at).toLocaleString("zh-CN", {
              timeZone: t.followUp.timezone,
            })
          }}（{{ t.followUp.timezone }}）</small
        >
        <small v-if="t.followUp?.snoozed_until"
          >已暂缓提醒至
          {{
            new Date(t.followUp.snoozed_until).toLocaleString("zh-CN", {
              timeZone: t.followUp.timezone,
            })
          }}</small
        >
        <TaskFollowUpControls
          :task="t"
          @refresh="refresh"
          @error="(text) => (error = text)" />
        <small v-if="t.dueAt"
          >到期 {{ new Date(t.dueAt).toLocaleString("zh-CN") }}</small
        ><template #actions
          ><OmButton @click="changeTask(t)">{{
            ["done", "cancelled"].includes(t.status) ? "重新打开" : "标为完成"
          }}</OmButton
          ><OmCitation
            v-if="t.evidenceId"
            label="查看事项来源"
            @open="evidence?.open(t.evidenceId)" /></template
      ></OmPanel>
    </section>
    <ChangeHistory
      v-else-if="view === 'changes'"
      :changes="changes"
      @open="openRevision"
      @restore="restore" />
    <section v-else-if="view === 'notifications'" class="page">
      <h1>通知中心</h1>
      <p class="muted">
        {{
          notificationMode === "instant"
            ? "每次变更即时提示，完整记录保留在这里。"
            : "变更保留在通知中心，当前关闭逐条浮动提示。"
        }}
        标为已读仅清除未读提醒，不会批准变更、完成待办或取消后续提醒。
      </p>
      <OmPanel
        v-for="n in notifications"
        :key="n.id"
        :title="n.title"
        class="stack"
        ><OmBadge>{{ n.readAt ? "已读" : "未读" }}</OmBadge>
        <p>
          {{
            n.body === "已保存新的知识正文、固定引用与独立模型复核记录。"
              ? "旧版知识整理通知，未记录可比较的正文版本。"
              : n.body.includes("之前：") && n.body.includes("当前：")
                ? "原始材料已更新，打开详情查看完整内容差异。"
                : n.body
          }}
        </p>
        <small>{{ new Date(n.createdAt).toLocaleString("zh-CN") }}</small
        ><template #actions
          ><OmButton v-if="!n.readAt" @click="readNotification(n)"
            >标为已读</OmButton
          ><OmButton @click="openNotification(n)">查看详情</OmButton></template
        ></OmPanel
      ><OmEmpty v-if="!notifications.length" title="暂无通知" />
    </section>
    <LarkSetup
      v-else-if="view === 'lark'"
      @error="(text) => (error = text)"
      @notice="say" />
    <section v-else-if="view === 'settings'" class="page">
      <h1>能力与连接</h1>
      <p class="muted">
        使用运行 omem 的电脑上已登录的
        Agent。进入此页会自动读取可用模型与思考强度；问答使用这里选择的配置。
      </p>
      <OmPanel title="问答运行配置"
        ><div class="form">
          <label
            >Agent 接入<select v-model="profileId" @change="setProfile">
              <option v-for="p in profiles" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select></label
          >
          <div class="form-grid">
            <label
              >模型（留空使用宿主默认）<input
                v-model="model"
                list="model-values"
                placeholder="模型 ID"
              /><datalist id="model-values">
                <option
                  v-for="o in options.find((o) => o.id === 'model')?.values ||
                  []"
                  :key="o.value"
                  :value="o.value"
                >
                  {{ o.name }}
                </option>
              </datalist></label
            ><label
              >Effort（留空使用宿主默认）<input
                v-model="effort"
                list="effort-values"
                placeholder="思考强度"
              /><datalist id="effort-values">
                <option
                  v-for="o in options.find((o) => o.id === 'reasoning_effort')
                    ?.values || []"
                  :key="o.value"
                  :value="o.value"
                >
                  {{ o.name }}
                </option>
              </datalist></label
            >
          </div>
          <small
            >上下文上限
            {{ selectedProfile?.maxContextChars }}
            字符；超限明确拒绝，不静默截断焦点。</small
          >
          <p v-if="probing" role="status">
            正在连接 Agent，读取支持的模型与思考强度…
          </p>
          <p v-else-if="probeError" role="alert">
            能力读取失败：{{ probeError }}
          </p>
          <p v-else-if="probeNote" class="muted">{{ probeNote }}</p>
          <OmButton :loading="probing" @click="probe"
            >重新读取 Agent 能力</OmButton
          >
          <OmDisclosure v-if="options.length" title="已发现的配置选项">
            <p v-for="o in options" :key="o.id">
              {{ o.name }}：{{ o.values.map((v) => v.name).join("、") }}
            </p>
          </OmDisclosure>
        </div></OmPanel
      ><OmPanel class="stack" title="浏览器与 omem 的连接"
        ><p>
          {{
            accessProtected
              ? "此服务已启用访问保护，浏览器使用服务访问令牌连接。"
              : "当前已连接本地服务，未启用访问令牌，无需填写。"
          }}
        </p>
        <OmDisclosure title="更换服务访问令牌"
          ><p class="muted">
            令牌由 omem 服务的 token 配置或 OMEM_TOKEN
            设置，用来防止其他人访问你的材料。它不是模型 API Key
            或飞书令牌；仅保存在当前浏览器会话中。
          </p>
          <label
            >omem 服务访问令牌<input
              v-model="token"
              type="password"
              autocomplete="off"
              placeholder="仅保存在当前浏览器会话" /></label
          ><OmButton @click="saveToken"
            >保存令牌并重新连接</OmButton
          ></OmDisclosure
        ></OmPanel
      >
      <p class="muted">
        命令、参数、默认模型、上下文指令和通知模式在 omem.local.json
        配置。服务不会暴露凭据或允许网页修改执行命令。
      </p>
    </section>
    <section v-else class="page">
      <span class="eyebrow">OMEm DESIGN SYSTEM / V1</span>
      <h1>围绕证据，安静地阅读</h1>
      <p class="muted">
        Vue 公共组件由 @omem/ui 提供；主题与移动端规范见项目根 design.md。
      </p>
      <OmPanel title="动作与状态"
        ><div class="row">
          <OmButton variant="primary">主要动作</OmButton
          ><OmButton>次要动作</OmButton><OmButton disabled>暂不可用</OmButton>
        </div>
        <div class="row">
          <OmBadge>固定版本</OmBadge><OmBadge tone="warning">待核对</OmBadge
          ><OmBadge tone="danger">读取失败</OmBadge
          ><OmBadge tone="success">已验证</OmBadge>
        </div></OmPanel
      ><OmPanel class="stack" title="引用片段"
        ><p class="sample-quote">每一个结论，都应该保留可以继续阅读的来路。</p>
        <OmCitation
          label="选择真实材料后可体验引用"
          :version="1"
          @open="focus && evidence?.open(focus.id)" /></OmPanel
      ><OmPanel class="stack" title="折叠与目录">
        <OmDisclosure title="展开阅读补充说明"
          ><p>整行标题可展开，键盘 Enter / Space 也可操作。</p>
          <label
            >展开内容保留输入<input
              placeholder="收起后再展开，内容保持" /></label
        ></OmDisclosure>
        <OmDisclosure
          title="分类目录"
          title-action
          @select="toast = '点击分类标题打开分类，箭头单独展开目录。'"
          ><template #meta>2 篇</template>
          <p>分类标题与箭头分别执行导航和展开操作。</p></OmDisclosure
        >
      </OmPanel>
      <OmEmpty
        title="内容暂未产生"
        description="空态提供下一步，不用演示数据假装系统已经工作。"
        ><OmButton @click="view = 'capture'">输入材料</OmButton></OmEmpty
      >
    </section>
    <EvidenceReader
      ref="evidence"
      :profile-id="profileId"
      :model="model"
      :effort="effort"
      @saved="refresh" />
    <OmTrailDrawer
      :open="searchOpen"
      :frames="searchFrames"
      :current="searchCurrent"
      :loop-at="searchLoopAt"
      :return-focus-to="searchTrigger"
      @close="closeSearch"
      @back="backSearch"
      @jump="jumpSearch"
      @dismiss-loop="searchLoopAt = null"
    >
      <KeepAlive v-if="searchOpen"
        ><KnowledgeFrame
          v-if="searchActive"
          :key="searchActive.kind + searchActive.id"
          :frame="searchActive"
          prefix="/api/knowledge"
          @navigate="pushSearch"
          @loaded="
            (title, id) => {
              const frame = searchFrames.find((f) => f.id === id);
              if (frame) frame.title = title;
            }
          "
      /></KeepAlive>
    </OmTrailDrawer>
    <NotificationDetail
      :open="notificationOpen"
      :detail="notificationDetail"
      :loading="notificationLoading"
      @close="notificationOpen = false"
      @open-evidence="(id) => evidence?.open(id)"
      @open-revision="
        (id) => {
          notificationOpen = false;
          openRevision(id);
        }
      " />
    <div v-if="toast" class="toast" role="status">{{ toast }}</div>
    <template v-if="view === 'read'" #assistant
      ><ChatPane
        :key="focus?.id"
        :focus="focus"
        :profile-id="profileId"
        :model="model"
        :effort="effort"
        @open="(id) => evidence?.open(id)"
        @saved="refresh" /></template
  ></OmShell>
</template>

<style scoped>
.materials-layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  min-height: 100%;
}
.materials-directory {
  padding: 20px 16px;
  border-right: 1px solid var(--om-line);
  min-width: 0;
  align-self: start;
  position: sticky;
  top: 0;
  max-height: calc(100dvh - 140px);
  overflow: auto;
}
.materials-layout .reader {
  min-width: 0;
  padding: 28px;
}
.materials-directory .source-link {
  width: 100%;
}
.materials-directory .nav-heading {
  margin-top: 0;
}
@media (max-width: 1000px) {
  .materials-layout {
    grid-template-columns: 190px minmax(0, 1fr);
  }
}
@media (max-width: 700px) {
  .materials-layout {
    display: block;
  }
  .materials-directory {
    position: static;
    max-height: 260px;
    border-right: 0;
    border-bottom: 1px solid var(--om-line);
  }
  .materials-layout .reader {
    padding: 20px;
  }
}
</style>

<style scoped>
.source-filter {
  width: 100%;
  min-height: 44px;
  padding: 8px;
  border: 1px solid var(--om-line);
  border-radius: 6px;
}
</style>

<style scoped>
.search-loading {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 96px;
  color: var(--om-secondary);
}
.search-purpose {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 24px 0;
}
.search-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.search-purpose select {
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--om-line);
  border-radius: 6px;
  background: var(--om-panel);
}
.search-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--om-line);
  border-top-color: var(--om-ink);
  border-radius: 50%;
  animation: search-turn 0.8s linear infinite;
}
@keyframes search-turn {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .search-spinner {
    animation: none;
  }
}
</style>
