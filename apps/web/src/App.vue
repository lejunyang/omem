<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import {
  OmShell,
  OmButton,
  OmIcon,
  OmBadge,
  OmPanel,
  OmEmpty,
  OmCitation,
} from "@omem/ui";
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
import LearningView from "./LearningView.vue";
import DecisionsView from "./DecisionsView.vue";
import NotificationDetail from "./NotificationDetail.vue";
import LarkSetup from "./LarkSetup.vue";
import ReviewApp from "./ReviewApp.vue";
const view = ref("read");
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
const reviewMode = ref(false);
const busy = ref(false);
const toast = ref("");
const token = ref("");
const evidence = ref<InstanceType<typeof EvidenceReader>>();
const query = ref("");
const results = ref<
  { id: string; text: string; title: string; version: number }[]
>([]);
const history = ref<{ id: string; title: string; version: number }[]>([]);
const options = ref<
  { id: string; name: string; values: { value: string; name: string }[] }[]
>([]);
const notificationMode = ref("instant");
let pollTimer: ReturnType<typeof setInterval>;
let toastTimer: ReturnType<typeof setTimeout>;
let searchVersion = 0;
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
  } catch (e) {
    error.value = String(e);
  } finally {
    refreshing = false;
  }
}
async function boot() {
  error.value = "";
  // Review mode: the dev/prod server behind /api is the repo-review knowledge base,
  // not the personal workspace. Detect it before touching business APIs.
  try {
    const r = await fetch("/api/review/health");
    if (r.ok) {
      const h = (await r.json()) as { mode?: string };
      if (h && h.mode === "review") {
        reviewMode.value = true;
        return;
      }
    }
  } catch {
    /* network error falls through to the normal workspace boot below */
  }
  try {
    const health = await api<{ notificationMode: string }>("/health");
    notificationMode.value = health.notificationMode;
    profiles.value = await api("/profiles");
    if (!profiles.value.some((p) => p.id === profileId.value))
      profileId.value = profiles.value[0]?.id || "";
    await refresh();
    if (sources.value[0] && !revision.value)
      await openRevision(sources.value[0].id, false);
  } catch (e) {
    error.value = String(e);
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
async function search() {
  const v = ++searchVersion;
  try {
    const r = await api<typeof results.value>(
      "/search?q=" + encodeURIComponent(query.value),
    );
    if (v === searchVersion) results.value = r;
  } catch (e) {
    error.value = String(e);
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
        status: t.status === "open" ? "done" : "open",
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
async function probe() {
  busy.value = true;
  error.value = "";
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
    }>("/profiles/" + profileId.value + "/probe", {});
    options.value = (response.configOptions || [])
      .filter((o) => o.type === "select")
      .map((o) => ({
        id: o.id,
        name: o.name,
        values: (o.options || []).flatMap((v) =>
          "options" in v ? v.options : [v],
        ),
      }));
    say(response.note || "已读取 Agent 公布的模型与配置");
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
function setProfile() {
  model.value = selectedProfile.value?.model || "";
  effort.value = selectedProfile.value?.effort || "";
  options.value = [];
}
function saveToken() {
  sessionStorage.setItem("omem-token", token.value);
  token.value = "";
  void boot();
}
onMounted(async () => {
  await boot();
  if (!reviewMode.value)
    pollTimer = setInterval(() => void refresh(), 2500);
});
onBeforeUnmount(() => {
  clearInterval(pollTimer);
  clearTimeout(toastTimer);
});
</script>
<template>
  <ReviewApp v-if="reviewMode" />
  <OmShell v-else
    ><template #top
      ><div class="top-controls">
        <input
          v-model="query"
          aria-label="搜索材料"
          placeholder="搜索材料与经历…"
          @input="search"
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
          v-for="[id, icon, label] in [
            ['read', 'book', '知识阅读'],
            ['capture', 'plus', '输入材料'],
            ['learning', 'spark', '学习流程'],
            ['decisions', 'check', '待判断'],
            ['tasks', 'check', '需求与待办'],
            ['changes', 'clock', '变更历史'],
            ['notifications', 'spark', '通知中心'],
            ['lark', 'layers', '飞书机器人'],
            ['settings', 'layers', '能力与连接'],
            ['design', 'book', '设计系统'],
          ]"
          :key="id"
          :class="{ active: view === id }"
          @click="
            view = id;
            query = '';
          "
        >
          <OmIcon :name="icon" />{{ label }}
        </button>
      </nav>
      <h4 class="nav-heading">
        材料目录 <small>{{ sources.length }}</small>
      </h4>
      <button
        v-for="s in sources"
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
      </p></template
    >
    <div class="page-bar">
      <span
        >我的工作记忆 /
        {{
          view === "read"
            ? "知识阅读"
            : view === "capture"
              ? "输入材料"
              : view === "learning"
                ? "学习流程"
                : view === "decisions"
                  ? "待判断"
                  : view === "tasks"
                    ? "需求与待办"
                    : view === "changes"
                      ? "变更历史"
                      : view === "notifications"
                        ? "通知中心"
                        : view === "lark"
                          ? "飞书机器人"
                          : view === "settings"
                            ? "能力与连接"
                            : "设计系统"
        }}</span
      ><OmBadge>个人版 · 基础链路</OmBadge>
    </div>
    <div v-if="error" class="error-banner" role="alert">
      {{ error
      }}<OmButton variant="ghost" @click="error = ''">关闭提示</OmButton>
    </div>
    <section v-if="query" class="page">
      <h1>搜索“{{ query }}”</h1>
      <p class="muted">当前使用精确文本检索；语义检索尚未接入。</p>
      <OmPanel v-for="r in results" :key="r.id" :title="r.title" class="stack"
        ><p class="excerpt">{{ r.text }}</p>
        <OmCitation
          label="查看固定片段"
          :version="r.version"
          @open="evidence?.open(r.id)" /></OmPanel
      ><OmEmpty
        v-if="!results.length"
        title="未找到相关片段"
        description="试试原文关键词，或先导入材料。"
      />
    </section>
    <section v-else-if="view === 'read'" class="page reader">
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
        <p class="reading-note">
          <OmIcon name="link" />
          点击片段旁的“查看引用”逐层阅读，选择片段后可以直接追问。
        </p>
        <div
          v-for="f in revision.fragments"
          :key="f.id"
          class="fragment"
          :class="{ focused: focus?.id === f.id }"
        >
          <p>{{ f.text }}</p>
          <div class="row">
            <small>片段 {{ f.ordinal + 1 }}</small
            ><OmButton variant="ghost" @click="focus = f">以此片段提问</OmButton
            ><OmCitation label="查看引用" @open="evidence?.open(f.id)" />
          </div>
        </div>
        <template v-for="(p, i) in revision.parts" :key="i"
          ><AssetImage
            v-if="p.type === 'image'"
            :id="p.assetId"
            :label="p.label"
        /></template>
        <details class="stack">
          <summary>版本历史 · {{ history.length }}</summary>
          <div class="row">
            <OmButton
              v-for="h in history"
              :key="h.id"
              @click="openRevision(h.id)"
              >v{{ h.version }}</OmButton
            >
          </div>
        </details></template
      ><OmEmpty
        v-else
        title="让第一份材料，成为有来处的记忆"
        description="输入文本、图片或链接，也可以从飞书文档和 Git 导入。"
        ><OmButton variant="primary" @click="view = 'capture'"
          >输入材料</OmButton
        ></OmEmpty
      >
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
    <LearningView
      v-else-if="view === 'learning'"
      :jobs="jobs"
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
    <section v-else-if="view === 'tasks'" class="page">
      <span class="eyebrow">从工作中记下要推进的事</span>
      <h1>需求与待办</h1>
      <p class="muted">
        可关联当前片段、设置到期时间；到期提醒写入通知中心。自动从观测中提炼待办将在后续接入。
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
          t.status === "done" ? "已完成" : "待推进"
        }}</OmBadge>
        <p>{{ t.detail }}</p>
        <small v-if="t.dueAt"
          >到期 {{ new Date(t.dueAt).toLocaleString("zh-CN") }}</small
        ><template #actions
          ><OmButton @click="changeTask(t)">{{
            t.status === "done" ? "重新打开" : "标为完成"
          }}</OmButton
          ><OmCitation
            v-if="t.evidenceId"
            label="查看事项来源"
            @open="evidence?.open(t.evidenceId)" /></template
      ></OmPanel>
    </section>
    <section v-else-if="view === 'changes'" class="page">
      <h1>每次变化，都有来路</h1>
      <p class="muted">
        录入、引用、问答和事项状态变化会记录通知。恢复创建新版本，不覆盖历史。
      </p>
      <OmPanel v-for="c in changes" :key="c.id" :title="c.title" class="stack"
        ><small
          >{{ c.kind }} ·
          {{ new Date(c.createdAt).toLocaleString("zh-CN") }}</small
        >
        <p>{{ c.details }}</p>
        <template #actions
          ><OmButton v-if="c.beforeId" @click="openRevision(c.beforeId)"
            >查看变更前</OmButton
          ><OmButton v-if="c.afterId" @click="openRevision(c.afterId)"
            >查看变更后</OmButton
          ><OmButton v-if="c.beforeId && c.afterId" @click="restore(c)"
            >恢复为新版本</OmButton
          ></template
        ></OmPanel
      ><OmEmpty v-if="!changes.length" title="暂无变更" />
    </section>
    <section v-else-if="view === 'notifications'" class="page">
      <h1>通知中心</h1>
      <p class="muted">
        {{
          notificationMode === "instant"
            ? "每次变更即时提示，完整记录保留在这里。"
            : "变更保留在通知中心，当前关闭逐条浮动提示。"
        }}
        打开详情可核对应用回执、原始证据和各渠道的真实投递状态。
      </p>
      <OmPanel
        v-for="n in notifications"
        :key="n.id"
        :title="n.title"
        class="stack"
        ><OmBadge>{{ n.readAt ? "已读" : "未读" }}</OmBadge>
        <p>{{ n.body }}</p>
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
        使用服务器上已登录的 Agent。模型与 effort 不固定枚举，ACP
        按实际能力协商；后续可增加 API provider。
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
          ><OmButton :loading="busy" @click="probe">读取 Agent 能力</OmButton>
          <details v-if="options.length">
            <summary>已发现的配置选项</summary>
            <p v-for="o in options" :key="o.id">
              {{ o.name }}：{{ o.values.map((v) => v.name).join("、") }}
            </p>
          </details>
        </div></OmPanel
      ><OmPanel class="stack" title="服务器访问"
        ><label
          >访问令牌<input
            v-model="token"
            type="password"
            autocomplete="off"
            placeholder="仅保存在当前浏览器会话" /></label
        ><template #actions
          ><OmButton @click="saveToken">连接服务器</OmButton></template
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
      ><OmEmpty
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
    <template #assistant
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
