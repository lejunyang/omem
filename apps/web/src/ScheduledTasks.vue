<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  OmBadge,
  OmButton,
  OmCheckbox,
  OmDialog,
  OmDisclosure,
  OmEmpty,
  OmMarkdown,
  OmPanel,
  OmSelect,
} from "@omem/ui";
import type { MaterialContext } from "../../../packages/contracts/src/contexts";
import type {
  ScheduleInput,
  ScheduleRun,
  ScheduledTask,
} from "../../../packages/contracts/src/schedules";
import { api } from "./api";

const emit = defineEmits<{ "open-revision": [id: string] }>();
function openResultReference(path: string) {
  const match = /^\/__omem\/revision\/([^/?#]+)$/.exec(path);
  if (!match) return;
  try {
    emit("open-revision", decodeURIComponent(match[1]!));
  } catch {
    editorError.value = "这条材料引用暂时无法打开。";
  }
}

type AutoWatchSettings = {
  enabled: boolean;
  intervalMinutes: number;
  recentLimit: number;
  maxAutoSubscriptions: number;
  focus: string;
  ignore: string;
};
type PollSettings = {
  enabled: boolean;
  intervalMinutes: number;
  historyHours: number;
  mentionExceptions: boolean;
  resources: boolean;
};
type DiscoveryDecision = {
  chatId: string;
  name: string;
  reason: string;
  modelJudged?: boolean;
};
type DiscoveryRun = {
  at: string;
  status: string;
  discovered: number;
  hasMore: boolean;
  selected: DiscoveryDecision[];
  skipped: DiscoveryDecision[];
  pending: DiscoveryDecision[];
  failed: DiscoveryDecision[];
};
type LarkStatus = {
  settings: PollSettings & { autoWatch?: AutoWatchSettings };
  running: boolean;
  streams: {
    id: string;
    name: string;
    mode: string;
    next_at: string | null;
    last_success: string | null;
    last_error: string | null;
    last_batch?: { fetched: number; processed: number; at: string } | null;
  }[];
  autoWatch?: {
    settings: AutoWatchSettings;
    running: boolean;
    nextAt: string | null;
    lastRun: DiscoveryRun | null;
    notice?: string | null;
  };
};
type SystemReminder = {
  id: string;
  name: string;
  kind: "task_reminders";
  enabled: boolean;
  intervalSeconds: number;
  lastCheckedAt: string | null;
  nextRunAt: string | null;
  pendingCount: number;
  detail: string;
};
const tasks = ref<ScheduledTask[]>([]);
const systemTasks = ref<SystemReminder[]>([]);
const lark = ref<LarkStatus | null>(null);
const contexts = ref<MaterialContext[]>([]);
const loading = ref(true);
const busy = ref("");
const scheduleError = ref("");
const larkError = ref("");
const contextError = ref("");
const actionError = ref("");
const notice = ref("");
const query = ref("");
const filter = ref("all");
const pollOpen = ref(false);
const autoOpen = ref(false);
const pollDraft = ref<PollSettings>({
  enabled: false,
  intervalMinutes: 5,
  historyHours: 24,
  mentionExceptions: true,
  resources: true,
});
const autoDraft = ref<AutoWatchSettings>({
  enabled: false,
  intervalMinutes: 30,
  recentLimit: 100,
  maxAutoSubscriptions: 20,
  focus: "",
  ignore: "",
});
const runLabels: Record<ScheduleRun["state"], string> = {
  queued: "等待执行",
  running: "执行中",
  retry_wait: "等待重试",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};
function runText(run: ScheduleRun) {
  return run.state === "succeeded" && run.skipped
    ? "无新增内容"
    : runLabels[run.state];
}
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const watches = computed(
  () => lark.value?.streams.filter((s) => s.mode === "watch") ?? [],
);
const pollFailures = computed(
  () => lark.value?.streams.filter((s) => s.last_error) ?? [],
);
const pollLast = computed(() =>
  lark.value?.streams
    .map((s) => s.last_success)
    .filter((at): at is string => !!at)
    .sort()
    .at(-1),
);
const pollNext = computed(() =>
  lark.value?.settings.enabled
    ? lark.value.streams
        .filter(
          (s) =>
            s.mode === "watch" ||
            (s.id === "@mentions" && lark.value?.settings.mentionExceptions),
        )
        .map((s) => s.next_at)
        .filter((at): at is string => !!at)
        .sort()[0]
    : null,
);
const autoSettings = computed(
  () => lark.value?.autoWatch?.settings ?? lark.value?.settings.autoWatch,
);
const autoRun = computed(() => lark.value?.autoWatch?.lastRun);
const discoveryTask = computed(() =>
  tasks.value.find((task) => task.kind === "lark_discovery"),
);
const autoNeedsAttention = computed(
  () =>
    !!(autoRun.value?.failed.length || autoRun.value?.pending.length) ||
    discoveryTask.value?.lastRun?.state === "failed" ||
    discoveryTask.value?.lastRun?.state === "retry_wait",
);
const shownTasks = computed(() =>
  tasks.value.filter(
    (task) =>
      task.kind !== "lark_discovery" &&
      matches(
        task.name + " " + task.instruction,
        task.enabled,
        task.lastRun?.state === "failed" ||
          task.lastRun?.state === "retry_wait",
      ),
  ),
);
const showPoll = computed(() =>
  matches(
    "飞书消息轮询 定时采集",
    !!lark.value?.settings.enabled,
    !!pollFailures.value.length,
  ),
);
const showAuto = computed(() =>
  matches(
    "自动发现关注会话 飞书群聊",
    !!autoSettings.value?.enabled,
    autoNeedsAttention.value,
  ),
);
const shownSystemTasks = computed(() =>
  systemTasks.value.filter((task) =>
    matches(`${task.name} ${task.detail}`, task.enabled, false),
  ),
);
const enabledCount = computed(
  () =>
    tasks.value.filter((t) => t.enabled).length +
    Number(!!lark.value?.settings.enabled) +
    systemTasks.value.filter((t) => t.enabled).length,
);
function matches(text: string, enabled: boolean, attention: boolean) {
  return (
    text.toLowerCase().includes(query.value.trim().toLowerCase()) &&
    (filter.value === "all" ||
      (filter.value === "enabled" && enabled) ||
      (filter.value === "paused" && !enabled) ||
      (filter.value === "attention" && attention))
  );
}
function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function time(at?: string | null, fallback = "尚未执行") {
  if (!at) return fallback;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "时间暂不可用";
  if (date.getTime() <= 0) return "等待后台检查";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function timingText(task: ScheduledTask) {
  if (task.timing.type === "interval")
    return `每 ${task.timing.everyMinutes} 分钟`;
  const fields = task.timing.expression.trim().split(/\s+/);
  if (
    fields.length === 5 &&
    /^\d+$/.test(fields[0]!) &&
    /^\d+$/.test(fields[1]!) &&
    fields[2] === "*" &&
    fields[3] === "*"
  ) {
    const clock = `${fields[1]!.padStart(2, "0")}:${fields[0]!.padStart(2, "0")}`;
    if (fields[4] === "*") return `每天 ${clock} · ${task.timing.timezone}`;
    if (/^[0-6]$/.test(fields[4]!))
      return `每${weekdays[Number(fields[4])]} ${clock} · ${task.timing.timezone}`;
  }
  return `自定义时间 · ${task.timing.timezone}`;
}
function scopeText(task: ScheduledTask) {
  return task.contextIds.length
    ? task.contextIds
        .map(
          (id) =>
            contexts.value.find((c) => c.id === id)?.name ??
            "暂无法读取的项目或主题",
        )
        .join("、")
    : "个人库中的材料与事项";
}
function taskPayload(
  task: ScheduledTask,
  enabled = task.enabled,
): ScheduleInput {
  return {
    kind: task.kind,
    name: task.name,
    instruction: task.instruction,
    contextIds: task.contextIds,
    enabled,
    timing: task.timing,
    expectedVersion: task.version,
  };
}
let stopped = false;
let refreshSequence = 0;
async function refresh(initial = false) {
  const sequence = ++refreshSequence;
  const paths = [
    "/schedules",
    "/integrations/lark-personal",
    ...(initial ? ["/contexts"] : []),
  ];
  const responses = await Promise.allSettled(
    paths.map((path) => api<unknown>(path)),
  );
  if (stopped || sequence !== refreshSequence) return;
  const schedules = responses[0]!;
  if (schedules.status === "fulfilled") {
    const response = schedules.value as {
      tasks: ScheduledTask[];
      system?: SystemReminder[];
    };
    tasks.value = response.tasks;
    systemTasks.value = (response.system ?? []).filter(
      (task) => task.kind === "task_reminders",
    );
    scheduleError.value = "";
  } else
    scheduleError.value = `定时简报暂无法读取：${message(schedules.reason)}`;
  const personal = responses[1]!;
  if (personal.status === "fulfilled") {
    lark.value = personal.value as LarkStatus;
    larkError.value = "";
    if (!pollOpen.value) {
      const {
        enabled,
        intervalMinutes,
        historyHours,
        mentionExceptions,
        resources,
      } = lark.value.settings;
      pollDraft.value = {
        enabled,
        intervalMinutes,
        historyHours,
        mentionExceptions,
        resources,
      };
    }
    if (!autoOpen.value && autoSettings.value)
      autoDraft.value = { ...autoSettings.value };
  } else larkError.value = `飞书任务暂无法读取：${message(personal.reason)}`;
  const loadedContexts = responses[2];
  if (loadedContexts?.status === "fulfilled") {
    contexts.value = loadedContexts.value as MaterialContext[];
    contextError.value = "";
  } else if (loadedContexts?.status === "rejected")
    contextError.value = `项目与主题暂无法读取：${message(loadedContexts.reason)}`;
}
async function action(key: string, work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = key;
  actionError.value = "";
  notice.value = "";
  try {
    await work();
    if (key !== "refresh") await refresh();
  } catch (e) {
    actionError.value = message(e);
  } finally {
    busy.value = "";
  }
}
function reload() {
  return action("refresh", () => refresh(true));
}
function updatePoll(patch: Partial<PollSettings>, close = false) {
  return action("poll", async () => {
    await api("/integrations/lark-personal/settings", patch, "PUT");
    if (patch.enabled !== undefined) pollDraft.value.enabled = patch.enabled;
    if (close) pollOpen.value = false;
    notice.value = "飞书消息采集设置已保存。";
  });
}
function syncPoll() {
  return action("poll-run", async () => {
    const result = await api<{ queued: number }>(
      "/integrations/lark-personal/sync",
      {},
    );
    notice.value = `已安排 ${result.queued} 个会话同步，执行结果会自动更新。`;
  });
}
function updateAuto(patch: Partial<AutoWatchSettings>, close = false) {
  return action("auto", async () => {
    await api("/integrations/lark-personal/auto-watch", patch, "PUT");
    if (patch.enabled !== undefined) autoDraft.value.enabled = patch.enabled;
    if (close) autoOpen.value = false;
    notice.value = "自动发现关注会话的设置已保存。";
  });
}
function runAuto() {
  return action("auto-run", async () => {
    if (discoveryTask.value) {
      const result = await api<{ duplicate: boolean }>(
        `/schedules/${encodeURIComponent(discoveryTask.value.id)}/run`,
        {},
      );
      notice.value = result.duplicate
        ? "关注会话检查已经在等待或执行，已保留同一次运行。"
        : "已安排检查关注会话，执行结果会自动更新。";
    } else {
      const result = await api<DiscoveryRun & { notice?: string }>(
        "/integrations/lark-personal/auto-watch/run",
        {},
      );
      if (result.status === "disabled")
        throw Error(result.notice ?? "请先开启自动发现和消息轮询。");
      if (result.status === "failed")
        throw Error("本次关注会话检查失败，请查看实际判断中的原因。");
      notice.value = "已完成本次关注会话检查，请查看实际结果。";
    }
  });
}
function toggle(task: ScheduledTask) {
  return action(task.id, async () => {
    if (task.enabled)
      await api(`/schedules/${encodeURIComponent(task.id)}/pause`, {
        expectedVersion: task.version,
      });
    else
      await api(
        `/schedules/${encodeURIComponent(task.id)}`,
        taskPayload(task, true),
        "PUT",
      );
    notice.value = `${task.name}${task.enabled ? "已暂停" : "已恢复"}。`;
  });
}
function run(task: ScheduledTask) {
  return action(task.id, async () => {
    const result = await api<{ duplicate: boolean }>(
      `/schedules/${encodeURIComponent(task.id)}/run`,
      {},
    );
    notice.value = result.duplicate
      ? "这个任务正在等待或执行，已保留同一次运行。"
      : "已安排执行，结果会自动更新。";
  });
}

type Editor = {
  name: string;
  instruction: string;
  enabled: boolean;
  cadence: "daily" | "weekly" | "interval" | "cron";
  clock: string;
  weekday: string;
  interval: number;
  timezone: string;
  expression: string;
  scope: "all" | "selected";
  contextIds: string[];
};
const dialogMode = ref<"edit" | "result" | "delete" | null>(null);
const selected = ref<ScheduledTask | null>(null);
const editorError = ref("");
const resultLoading = ref(false);
const selectedRunId = ref("");
function newEditor(): Editor {
  return {
    name: "每日简报",
    instruction: "",
    enabled: true,
    cadence: "daily",
    clock: "09:00",
    weekday: "1",
    interval: 60,
    timezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    expression: "0 9 * * *",
    scope: "all",
    contextIds: [],
  };
}
const draft = ref<Editor>(newEditor());
const resultTask = computed(
  () => tasks.value.find((t) => t.id === selected.value?.id) ?? selected.value,
);
const selectedRun = computed(
  () =>
    resultTask.value?.recentRuns.find((r) => r.id === selectedRunId.value) ??
    resultTask.value?.lastRun,
);
const dialogTitle = computed(() =>
  dialogMode.value === "edit"
    ? selected.value
      ? "设置定时任务"
      : "新建定时简报"
    : dialogMode.value === "delete"
      ? "删除定时任务"
      : `${selected.value?.name ?? "任务"} · 执行结果`,
);
function edit(task?: ScheduledTask) {
  selected.value = task ?? null;
  draft.value = newEditor();
  if (task) {
    draft.value.name = task.name;
    draft.value.instruction = task.instruction;
    draft.value.enabled = task.enabled;
    draft.value.contextIds = [...task.contextIds];
    draft.value.scope = task.contextIds.length ? "selected" : "all";
    if (task.timing.type === "interval") {
      draft.value.cadence = "interval";
      draft.value.interval = task.timing.everyMinutes;
    } else {
      draft.value.cadence = "cron";
      draft.value.expression = task.timing.expression;
      draft.value.timezone = task.timing.timezone;
      const fields = task.timing.expression.trim().split(/\s+/);
      if (
        fields.length === 5 &&
        /^\d+$/.test(fields[0]!) &&
        /^\d+$/.test(fields[1]!) &&
        fields[2] === "*" &&
        fields[3] === "*" &&
        (fields[4] === "*" || /^[0-6]$/.test(fields[4]!))
      ) {
        draft.value.cadence = fields[4] === "*" ? "daily" : "weekly";
        draft.value.clock = `${fields[1]!.padStart(2, "0")}:${fields[0]!.padStart(2, "0")}`;
        if (fields[4] !== "*") draft.value.weekday = fields[4]!;
      }
    }
  }
  editorError.value = "";
  dialogMode.value = "edit";
}
function closeDialog() {
  if (busy.value === "save" || busy.value === "delete") return;
  dialogMode.value = null;
}
async function results(task: ScheduledTask) {
  selected.value = task;
  selectedRunId.value = task.lastRun?.id ?? "";
  editorError.value = "";
  dialogMode.value = "result";
  resultLoading.value = true;
  try {
    const result = await api<ScheduledTask>(
      `/schedules/${encodeURIComponent(task.id)}`,
    );
    if (selected.value?.id === task.id) {
      selected.value = result;
      const index = tasks.value.findIndex((t) => t.id === task.id);
      if (index >= 0) tasks.value[index] = result;
    }
  } catch (e) {
    editorError.value = message(e);
  } finally {
    resultLoading.value = false;
  }
}
function submitEditor() {
  editorError.value = "";
  const value = draft.value;
  if (!value.name.trim()) {
    editorError.value = "请填写任务名称。";
    return;
  }
  if (
    !value.instruction.trim() &&
    (!selected.value || selected.value.kind === "daily_brief")
  ) {
    editorError.value = "请说明简报要回答什么问题。";
    return;
  }
  if (value.scope === "selected" && !value.contextIds.length) {
    editorError.value = "请选择至少一个项目或主题。";
    return;
  }
  const [hour, minute] = value.clock.split(":").map(Number);
  if (
    (value.cadence === "daily" || value.cadence === "weekly") &&
    (!Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour! < 0 ||
      hour! > 23 ||
      minute! < 0 ||
      minute! > 59)
  ) {
    editorError.value = "请选择有效的执行时间。";
    return;
  }
  const timing: ScheduleInput["timing"] =
    value.cadence === "interval"
      ? { type: "interval", everyMinutes: value.interval }
      : {
          type: "cron",
          expression:
            value.cadence === "cron"
              ? value.expression
              : `${minute} ${hour} * * ${value.cadence === "weekly" ? value.weekday : "*"}`,
          timezone: value.timezone.trim(),
        };
  const payload: ScheduleInput = {
    kind: selected.value?.kind ?? "daily_brief",
    name: value.name.trim(),
    instruction: value.instruction.trim(),
    enabled: value.enabled,
    timing,
    contextIds: value.scope === "all" ? [] : value.contextIds,
    ...(selected.value ? { expectedVersion: selected.value.version } : {}),
  };
  return action("save", async () => {
    try {
      await api(
        selected.value
          ? `/schedules/${encodeURIComponent(selected.value.id)}`
          : "/schedules",
        payload,
        selected.value ? "PUT" : "POST",
      );
      dialogMode.value = null;
      notice.value = `“${payload.name}”已保存${payload.enabled ? "，会按设置时间执行" : "，当前暂停"}。`;
    } catch (e) {
      editorError.value = message(e);
      throw e;
    }
  });
}
function remove(task: ScheduledTask) {
  selected.value = task;
  editorError.value = "";
  dialogMode.value = "delete";
}
function confirmRemove() {
  const task = selected.value;
  if (!task) return;
  return action("delete", async () => {
    try {
      await api(
        `/schedules/${encodeURIComponent(task.id)}`,
        { expectedVersion: task.version },
        "DELETE",
      );
      dialogMode.value = null;
      notice.value = `“${task.name}”已删除。`;
    } catch (e) {
      editorError.value = message(e);
      throw e;
    }
  });
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await refresh(true);
  if (stopped) return;
  loading.value = false;
  timer = setInterval(() => {
    if (!busy.value) void refresh();
  }, 8000);
});
onBeforeUnmount(() => {
  stopped = true;
  clearInterval(timer);
});
</script>

<template>
  <section class="page scheduled-tasks">
    <header class="page-heading">
      <div>
        <h1>定时任务</h1>
        <p class="muted">
          查看消息采集、关注会话与 AI 简报，调整它们的时间和读取范围。
        </p>
      </div>
      <OmButton
        variant="primary"
        :disabled="!!busy || !!scheduleError"
        @click="edit()"
        >新建简报</OmButton
      >
    </header>
    <p v-if="loading" role="status">正在读取定时任务…</p>
    <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div class="board-tools">
      <label
        >查找任务<input
          v-model="query"
          placeholder="名称或简报要求"
          type="search"
      /></label>
      <label
        >任务状态<OmSelect v-model="filter"
          ><option value="all">全部</option>
          <option value="enabled">已开启</option>
          <option value="paused">已暂停</option>
          <option value="attention">需要处理</option></OmSelect
        ></label
      >
      <OmButton :loading="busy === 'refresh'" :disabled="!!busy" @click="reload"
        >重新加载</OmButton
      >
    </div>
    <p v-if="!loading" class="muted board-summary">
      已开启 {{ enabledCount }} 项任务。下次时间由后台保存；服务运行时才会执行。
    </p>

    <p v-if="larkError" class="error" role="alert">{{ larkError }}</p>
    <OmPanel v-if="lark && showPoll" class="task-card">
      <template #heading
        ><div class="task-heading">
          <div>
            <h2>飞书消息轮询</h2>
            <p class="muted">
              读取已订阅会话的新消息，沿用飞书消息页的采集设置。
            </p>
          </div>
          <OmBadge :tone="pollFailures.length ? 'danger' : 'neutral'">{{
            lark.running
              ? "采集中"
              : lark.settings.enabled
                ? "已开启"
                : "已暂停"
          }}</OmBadge>
        </div></template
      >
      <dl class="task-meta">
        <div>
          <dt>执行时间</dt>
          <dd>每 {{ lark.settings.intervalMinutes }} 分钟</dd>
        </div>
        <div>
          <dt>读取范围</dt>
          <dd>
            {{ watches.length }} 个订阅会话{{
              lark.settings.mentionExceptions ? "，以及提及我的消息" : ""
            }}
          </dd>
        </div>
        <div>
          <dt>下次检查</dt>
          <dd>
            {{
              time(
                pollNext,
                lark.settings.enabled ? "等待后台检查" : "暂停期间不执行",
              )
            }}
          </dd>
        </div>
        <div>
          <dt>上次成功</dt>
          <dd>{{ time(pollLast) }}</dd>
        </div>
      </dl>
      <p v-if="pollFailures.length" class="error">
        {{ pollFailures.length }}
        个会话采集失败。查看结果了解原因，修复后可以立即同步。
      </p>
      <div class="actions">
        <OmButton
          :disabled="!!busy"
          @click="updatePoll({ enabled: !lark.settings.enabled })"
          >{{ lark.settings.enabled ? "暂停" : "恢复" }}</OmButton
        ><OmButton :disabled="!!busy" @click="pollOpen = !pollOpen">{{
          pollOpen ? "收起设置" : "设置"
        }}</OmButton
        ><OmButton
          :loading="busy === 'poll-run'"
          :disabled="!!busy || !lark.settings.enabled"
          @click="syncPoll"
          >立即同步</OmButton
        ><a class="text-link" href="#/messages">查看会话与消息</a>
      </div>
      <OmDisclosure v-model:open="pollOpen" title="采集频率与范围">
        <form
          class="settings-form"
          @submit.prevent="updatePoll(pollDraft, true)"
        >
          <OmCheckbox v-model="pollDraft.enabled" :disabled="!!busy"
            >开启消息轮询</OmCheckbox
          >
          <div class="form-grid">
            <label
              >同步间隔（分钟）<input
                v-model.number="pollDraft.intervalMinutes"
                type="number"
                min="1"
                max="1440"
                required /></label
            ><label
              >新订阅首次回溯（小时）<input
                v-model.number="pollDraft.historyHours"
                type="number"
                min="1"
                max="168"
                required
            /></label>
          </div>
          <OmCheckbox v-model="pollDraft.mentionExceptions" :disabled="!!busy"
            >同时检查所有群里的 @我 / @所有人</OmCheckbox
          ><OmCheckbox v-model="pollDraft.resources" :disabled="!!busy"
            >读取关联飞书文档、图片和附件</OmCheckbox
          >
          <p class="muted">
            明确排除的会话连提及也不读取。消息会保存到个人库，采集不会改变飞书已读状态。
          </p>
          <div class="actions">
            <OmButton
              type="submit"
              variant="primary"
              :loading="busy === 'poll'"
              :disabled="!!busy"
              >保存采集设置</OmButton
            >
          </div>
        </form>
      </OmDisclosure>
      <OmDisclosure title="消息采集结果"
        ><p v-if="!lark.streams.some((s) => s.last_success || s.last_error)">
          尚未执行。先在飞书消息页选择会话，再开启消息轮询。
        </p>
        <div
          v-for="stream in lark.streams.filter(
            (s) => s.last_success || s.last_error,
          )"
          :key="stream.id"
          class="stream-result"
        >
          <strong>{{
            stream.id === "@mentions" ? "提及我的消息" : stream.name
          }}</strong>
          <p v-if="stream.last_error" class="error">{{ stream.last_error }}</p>
          <p v-else class="muted">
            {{ time(stream.last_success) }} ·
            {{
              stream.last_batch
                ? `最近一批读取 ${stream.last_batch.fetched} 条，处理 ${stream.last_batch.processed} 条`
                : "已完成采集"
            }}
          </p>
        </div></OmDisclosure
      >
    </OmPanel>

    <OmPanel v-if="lark && autoSettings && showAuto" class="task-card">
      <template #heading
        ><div class="task-heading">
          <div>
            <h2>自动发现关注会话</h2>
            <p class="muted">
              从最近活跃群聊中判断需要持续跟进的会话，按关注点保存订阅。
            </p>
          </div>
          <OmBadge :tone="autoNeedsAttention ? 'warning' : 'neutral'">{{
            discoveryTask?.lastRun &&
            ["queued", "running", "retry_wait"].includes(
              discoveryTask.lastRun.state,
            )
              ? runLabels[discoveryTask.lastRun.state]
              : lark.autoWatch?.running
                ? "检查中"
                : autoSettings.enabled
                  ? "已开启"
                  : "已暂停"
          }}</OmBadge>
        </div></template
      >
      <dl class="task-meta">
        <div>
          <dt>执行时间</dt>
          <dd>
            {{
              discoveryTask
                ? timingText(discoveryTask)
                : `每 ${autoSettings.intervalMinutes} 分钟`
            }}
          </dd>
        </div>
        <div>
          <dt>读取范围</dt>
          <dd>
            最近 {{ autoSettings.recentLimit }} 个活跃会话，最多保留
            {{ autoSettings.maxAutoSubscriptions }} 个自动订阅
          </dd>
        </div>
        <div>
          <dt>下次检查</dt>
          <dd>
            {{
              time(
                discoveryTask?.nextRunAt ?? lark.autoWatch?.nextAt,
                autoSettings.enabled ? "等待后台检查" : "暂停期间不执行",
              )
            }}
          </dd>
        </div>
        <div>
          <dt>上次检查</dt>
          <dd>{{ time(discoveryTask?.lastRun?.startedAt ?? autoRun?.at) }}</dd>
        </div>
      </dl>
      <p v-if="lark.autoWatch?.notice" class="muted">
        {{ lark.autoWatch.notice }}
      </p>
      <p v-if="!autoSettings.enabled || !lark.settings.enabled" class="muted">
        立即检查需要先开启自动发现和飞书消息轮询。
      </p>
      <p v-if="autoRun" class="run-summary">
        最近一次：关注 {{ autoRun.selected.length }} 个，待判断
        {{ autoRun.pending.length }} 个，失败 {{ autoRun.failed.length }} 个。
      </p>
      <p v-if="discoveryTask?.lastRun?.error" class="error">
        {{ discoveryTask.lastRun.error }}
      </p>
      <div class="actions">
        <OmButton
          :disabled="!!busy"
          @click="updateAuto({ enabled: !autoSettings.enabled })"
          >{{ autoSettings.enabled ? "暂停" : "恢复" }}</OmButton
        ><OmButton :disabled="!!busy" @click="autoOpen = !autoOpen">{{
          autoOpen ? "收起设置" : "设置"
        }}</OmButton
        ><OmButton
          :loading="busy === 'auto-run'"
          :disabled="
            !!busy ||
            !autoSettings.enabled ||
            !lark.settings.enabled ||
            !!(
              discoveryTask?.lastRun &&
              ['queued', 'running', 'retry_wait'].includes(
                discoveryTask.lastRun.state,
              )
            )
          "
          @click="runAuto"
          >立即检查</OmButton
        ><OmButton
          v-if="discoveryTask"
          :disabled="!!busy"
          @click="results(discoveryTask)"
          >查看执行结果</OmButton
        >
      </div>
      <OmDisclosure v-model:open="autoOpen" title="关注点与发现范围"
        ><form
          class="settings-form"
          @submit.prevent="updateAuto(autoDraft, true)"
        >
          <OmCheckbox v-model="autoDraft.enabled" :disabled="!!busy"
            >开启自动发现</OmCheckbox
          ><label
            >希望关注什么<textarea
              v-model="autoDraft.focus"
              rows="3"
              maxlength="2000"
              placeholder="例如：我负责项目的进度、需要我确认的事项、相关学习讨论"
            /></label
          ><label
            >哪些讨论可以略过<textarea
              v-model="autoDraft.ignore"
              rows="2"
              maxlength="2000"
              placeholder="例如：闲聊、与当前工作无关的推广信息"
            />
          </label>
          <div class="form-grid">
            <label
              >检查间隔（分钟）<input
                v-model.number="autoDraft.intervalMinutes"
                type="number"
                min="1"
                max="1440"
                required /></label
            ><label
              >最近会话数量上限<input
                v-model.number="autoDraft.recentLimit"
                type="number"
                min="1"
                max="300"
                required /></label
            ><label
              >自动订阅数量上限<input
                v-model.number="autoDraft.maxAutoSubscriptions"
                type="number"
                min="1"
                max="100"
                required
            /></label>
          </div>
          <p class="muted">
            只检查最近活跃群聊，抽样阅读最近 24
            小时的少量消息。免打扰、手动排除与手动关闭的会话会跳过；手动订阅保留。持续采集需要同时开启消息轮询。
          </p>
          <div class="actions">
            <OmButton
              type="submit"
              variant="primary"
              :loading="busy === 'auto'"
              :disabled="!!busy"
              >保存关注设置</OmButton
            >
          </div>
        </form></OmDisclosure
      >
      <OmDisclosure title="关注会话的实际判断"
        ><p v-if="!autoRun">尚未检查。可以先填写关注点，再立即检查一次。</p>
        <template v-else
          ><p class="muted">
            {{ time(autoRun.at) }} · 发现 {{ autoRun.discovered }} 个会话{{
              autoRun.hasMore ? "，本次仅检查设置范围内的会话" : ""
            }}
          </p>
          <div
            v-for="group in [
              { label: '已关注', items: autoRun.selected },
              { label: '等待判断', items: autoRun.pending },
              { label: '未关注', items: autoRun.skipped },
              { label: '检查失败', items: autoRun.failed },
            ]"
            :key="group.label"
            class="decision-group"
          >
            <template v-if="group.items.length"
              ><h3>{{ group.label }}</h3>
              <div
                v-for="item in group.items"
                :key="item.chatId"
                class="stream-result"
              >
                <strong>{{ item.name || "未命名会话" }}</strong>
                <p>{{ item.reason }}</p>
                <small>{{
                  item.modelJudged ? "AI 阅读消息后判断" : "按会话设置筛选"
                }}</small>
              </div></template
            >
          </div></template
        ></OmDisclosure
      >
    </OmPanel>

    <p v-if="scheduleError" class="error" role="alert">{{ scheduleError }}</p>
    <OmPanel v-for="task in shownTasks" :key="task.id" class="task-card">
      <template #heading
        ><div class="task-heading">
          <div>
            <h2>{{ task.name }}</h2>
            <p class="muted">
              {{ task.kind === "daily_brief" ? "AI 简报" : "关注会话检查" }}
            </p>
          </div>
          <OmBadge
            :tone="task.lastRun?.state === 'failed' ? 'danger' : 'neutral'"
            >{{
              task.lastRun &&
              ["queued", "running", "retry_wait"].includes(task.lastRun.state)
                ? runLabels[task.lastRun.state]
                : task.enabled
                  ? "已开启"
                  : "已暂停"
            }}</OmBadge
          >
        </div></template
      >
      <p v-if="task.instruction" class="task-instruction">
        {{ task.instruction }}
      </p>
      <dl class="task-meta">
        <div>
          <dt>执行时间</dt>
          <dd>{{ timingText(task) }}</dd>
        </div>
        <div>
          <dt>读取范围</dt>
          <dd>{{ scopeText(task) }}</dd>
        </div>
        <div>
          <dt>下次执行</dt>
          <dd>
            {{
              time(
                task.nextRunAt,
                task.enabled ? "等待后台检查" : "暂停期间不执行",
              )
            }}
          </dd>
        </div>
        <div>
          <dt>上次执行</dt>
          <dd>
            {{
              task.lastRun
                ? `${time(task.lastRun.startedAt ?? task.lastRun.queuedAt)} · ${runText(task.lastRun)}`
                : "尚未执行"
            }}
          </dd>
        </div>
      </dl>
      <p v-if="task.lastRun?.error" class="error">{{ task.lastRun.error }}</p>
      <p v-else-if="task.lastRun?.summary" class="run-summary">
        {{ task.lastRun.summary }}
      </p>
      <div class="actions">
        <OmButton :disabled="!!busy" @click="toggle(task)">{{
          task.enabled ? "暂停" : "恢复"
        }}</OmButton
        ><OmButton :disabled="!!busy" @click="edit(task)">设置</OmButton
        ><OmButton
          :loading="busy === task.id"
          :disabled="
            !!busy ||
            !!(
              task.lastRun &&
              ['queued', 'running', 'retry_wait'].includes(task.lastRun.state)
            )
          "
          @click="run(task)"
          >立即执行</OmButton
        ><OmButton :disabled="!!busy" @click="results(task)">查看结果</OmButton
        ><OmButton variant="ghost" :disabled="!!busy" @click="remove(task)"
          >删除</OmButton
        >
      </div>
    </OmPanel>
    <OmPanel v-for="task in shownSystemTasks" :key="task.id" class="task-card">
      <template #heading>
        <div class="task-heading">
          <div>
            <h2>{{ task.name }}</h2>
            <p class="muted">{{ task.detail }}</p>
          </div>
          <OmBadge>服务运行中</OmBadge>
        </div>
      </template>
      <dl class="task-meta">
        <div>
          <dt>检查频率</dt>
          <dd>每 {{ task.intervalSeconds }} 秒</dd>
        </div>
        <div>
          <dt>等待提醒</dt>
          <dd>{{ task.pendingCount }} 项</dd>
        </div>
        <div>
          <dt>下次检查</dt>
          <dd>{{ time(task.nextRunAt, "等待后台检查") }}</dd>
        </div>
        <div>
          <dt>上次检查</dt>
          <dd>{{ time(task.lastCheckedAt, "尚未检查") }}</dd>
        </div>
      </dl>
      <div class="actions">
        <a class="text-link" href="#/tasks">设置事项提醒时间</a>
      </div>
    </OmPanel>
    <OmEmpty
      v-if="!loading && !scheduleError && !shownTasks.length"
      :title="
        query || filter !== 'all' ? '没有符合筛选的简报' : '还没有定时简报'
      "
      :description="
        query || filter !== 'all'
          ? '可以调整关键词或任务状态。'
          : '填写要关注的问题和执行时间，让助手定期整理个人库里的材料与事项。'
      "
    />

    <OmDialog
      :open="dialogMode !== null"
      :title="dialogTitle"
      @close="closeDialog"
      @back="closeDialog"
    >
      <form
        v-if="dialogMode === 'edit'"
        id="schedule-editor"
        class="settings-form"
        @submit.prevent="submitEditor"
      >
        <p class="muted">
          指定要回答的问题、读取范围与执行时间。结果保存在任务里，失败会保留原因。
        </p>
        <label
          >任务名称<input
            v-model="draft.name"
            maxlength="120"
            required /></label
        ><label
          >简报要求<textarea
            v-model="draft.instruction"
            rows="4"
            maxlength="6000"
            :required="!selected || selected.kind === 'daily_brief'"
            placeholder="例如：汇总本周项目进展、等待我回复的问题和明天需要准备的事项。说明时间范围和你希望重点了解的内容。"
          />
        </label>
        <div class="form-grid">
          <label
            >执行频率<OmSelect v-model="draft.cadence"
              ><option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="interval">固定间隔</option>
              <option value="cron">自定义时间</option></OmSelect
            ></label
          ><label v-if="draft.cadence === 'weekly'"
            >星期<OmSelect v-model="draft.weekday"
              ><option
                v-for="(day, index) in weekdays"
                :key="day"
                :value="String(index)"
              >
                {{ day }}
              </option></OmSelect
            ></label
          ><label v-if="draft.cadence === 'daily' || draft.cadence === 'weekly'"
            >执行时间<input v-model="draft.clock" type="time" required /></label
          ><label v-if="draft.cadence === 'interval'"
            >间隔（分钟）<input
              v-model.number="draft.interval"
              type="number"
              min="1"
              max="525600"
              required /></label
          ><label v-if="draft.cadence !== 'interval'"
            >时区<input
              v-model="draft.timezone"
              list="schedule-timezones"
              maxlength="100"
              required
              placeholder="Asia/Shanghai"
          /></label>
        </div>
        <datalist id="schedule-timezones">
          <option value="Asia/Shanghai" />
          <option value="Asia/Tokyo" />
          <option value="Europe/London" />
          <option value="America/New_York" />
          <option value="UTC" />
        </datalist>
        <OmDisclosure
          v-if="draft.cadence === 'cron'"
          title="高级时间设置"
          :default-open="true"
          ><label
            >Cron 表达式<input
              v-model="draft.expression"
              maxlength="200"
              required
              placeholder="0 9 * * *"
          /></label>
          <p class="muted">
            按“分钟 小时 日期 月份 星期”填写，例如
            <code>0 9 * * 1-5</code> 表示工作日 09:00。后台会校验表达式和时区。
          </p></OmDisclosure
        >
        <label
          >读取范围<OmSelect v-model="draft.scope"
            ><option value="all">个人库中的材料与事项</option>
            <option value="selected">指定项目或主题</option></OmSelect
          ></label
        >
        <fieldset v-if="draft.scope === 'selected'" class="scope-options">
          <legend>选择项目或主题</legend>
          <p v-if="contextError" class="error">{{ contextError }}</p>
          <p v-else-if="!contexts.length" class="muted">
            还没有项目或主题。可以先在材料页保存归属，或选择个人库范围。
          </p>
          <OmCheckbox
            v-for="context in contexts"
            :key="context.id"
            v-model="draft.contextIds"
            :value="context.id"
            ><strong>{{ context.name }}</strong
            ><span class="context-note"
              >{{ context.kind === "project" ? "项目" : "主题" }} ·
              {{ context.sourceCount }} 份材料</span
            ></OmCheckbox
          >
          <p
            v-if="
              draft.contextIds.some((id) => !contexts.some((c) => c.id === id))
            "
            class="muted"
          >
            已有读取范围中有暂无法读取的项目或主题；保存时会保留原选择。
          </p>
        </fieldset>
        <OmCheckbox v-model="draft.enabled">保存后按时间执行</OmCheckbox>
        <p class="muted">
          后台与已配置的助手 Agent 运行时执行任务。暂停后仍可手动运行一次。
        </p>
      </form>
      <div v-else-if="dialogMode === 'result'" class="result-view">
        <p v-if="resultLoading" role="status">正在读取执行记录…</p>
        <p v-if="editorError" class="error" role="alert">{{ editorError }}</p>
        <template v-if="selectedRun"
          ><label v-if="(resultTask?.recentRuns.length ?? 0) > 1"
            >执行记录<OmSelect v-model="selectedRunId"
              ><option
                v-for="entry in resultTask?.recentRuns"
                :key="entry.id"
                :value="entry.id"
              >
                {{ time(entry.queuedAt) }} · {{ runText(entry) }}
              </option></OmSelect
            ></label
          >
          <dl class="task-meta">
            <div>
              <dt>结果状态</dt>
              <dd>{{ runText(selectedRun) }}</dd>
            </div>
            <div>
              <dt>触发方式</dt>
              <dd>
                {{ selectedRun.trigger === "manual" ? "手动执行" : "定时执行" }}
              </dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{{ time(selectedRun.startedAt, "等待执行") }}</dd>
            </div>
            <div>
              <dt>结束时间</dt>
              <dd>{{ time(selectedRun.finishedAt, "尚未结束") }}</dd>
            </div>
            <div>
              <dt>通知状态</dt>
              <dd>{{ selectedRun.notificationState || "暂无通知记录" }}</dd>
            </div>
          </dl>
          <p v-if="selectedRun.error" class="error">{{ selectedRun.error }}</p>
          <p v-if="selectedRun.state === 'failed'" class="muted">
            检查错误原因与助手配置后，可以回到任务卡片立即执行。此前完成的结果保留在执行记录中。
          </p>
          <OmMarkdown
            v-if="selectedRun.detail || selectedRun.summary"
            :source="selectedRun.detail || selectedRun.summary || ''"
            @navigate-internal="openResultReference"
          />
          <p v-else class="muted">
            {{
              ["queued", "running", "retry_wait"].includes(selectedRun.state)
                ? "还没有完成结果，状态会自动更新。"
                : "这次执行没有返回正文。"
            }}
          </p></template
        ><OmEmpty
          v-else-if="!resultLoading"
          title="尚未执行"
          description="可以回到任务卡片立即执行一次，或等待下次执行时间。"
        />
      </div>
      <div v-else-if="dialogMode === 'delete'" class="result-view">
        <p>
          删除“{{
            selected?.name
          }}”后，将停止后续定时执行。删除不会撤销已经保存的材料和事项。
        </p>
      </div>
      <template #actions>
        <p
          v-if="
            editorError && (dialogMode === 'edit' || dialogMode === 'delete')
          "
          class="error dialog-action-error"
          role="alert"
        >
          {{ editorError }}
        </p>
        <template v-if="dialogMode === 'edit'"
          ><OmButton
            variant="primary"
            type="submit"
            form="schedule-editor"
            :loading="busy === 'save'"
            :disabled="!!busy"
            >保存任务</OmButton
          ><OmButton :disabled="!!busy" @click="closeDialog"
            >取消</OmButton
          ></template
        ><template v-else-if="dialogMode === 'delete'"
          ><OmButton
            variant="primary"
            :loading="busy === 'delete'"
            :disabled="!!busy"
            @click="confirmRemove"
            >删除任务</OmButton
          ><OmButton :disabled="!!busy" @click="closeDialog"
            >取消</OmButton
          ></template
        ><OmButton v-else @click="closeDialog">关闭</OmButton></template
      >
    </OmDialog>
  </section>
</template>

<style scoped>
.scheduled-tasks {
  display: grid;
  gap: 24px;
  width: 100%;
  max-width: 1040px;
  min-width: 0;
  margin-inline: auto;
}
.scheduled-tasks > * {
  min-width: 0;
  margin-block: 0;
}
.page-heading,
.task-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  width: 100%;
}
.page-heading h1 {
  margin: 0 0 8px;
}
.page-heading p,
.task-heading p {
  margin: 0;
}
.page-heading :deep(.om-button) {
  flex-shrink: 0;
  white-space: nowrap;
}
.task-heading h2 {
  margin: 0 0 4px;
  font-size: 22px;
}
.task-heading > div {
  min-width: 0;
}
.task-heading :deep(.om-badge) {
  flex-shrink: 0;
}
.muted {
  color: var(--om-secondary);
}
.error {
  color: var(--om-danger);
  overflow-wrap: anywhere;
}
.notice {
  padding: 12px 16px;
  border: 1px solid var(--om-line);
  background: var(--om-panel);
  border-radius: var(--om-radius);
}
.board-tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 200px) auto;
  align-items: end;
  gap: 16px;
}
.board-summary {
  font-size: 13px;
}
.task-card {
  width: 100%;
}
.task-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 24px;
  margin: 0;
}
.task-meta div {
  min-width: 0;
}
.task-meta dt {
  color: var(--om-muted);
  font-size: 12px;
  margin-bottom: 4px;
}
.task-meta dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.task-instruction {
  white-space: pre-wrap;
  line-height: 1.9;
  overflow-wrap: anywhere;
}
.run-summary {
  padding: 12px 16px;
  border-left: 2px solid var(--om-line);
  background: var(--om-paper);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.actions :deep(.om-button) {
  font-size: 14px;
}
.text-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 8px 4px;
  color: var(--om-secondary);
  text-underline-offset: 3px;
}
.settings-form,
.result-view {
  display: grid;
  gap: 24px;
  min-width: 0;
}
.settings-form > *,
.result-view > * {
  min-width: 0;
  margin-block: 0;
}
.scheduled-tasks :deep(.om-dialog footer) {
  flex-wrap: wrap;
}
.dialog-action-error {
  flex-basis: 100%;
  margin: 0 0 4px;
  font-size: 14px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
label {
  display: grid;
  gap: 8px;
  font-size: 14px;
  min-width: 0;
}
input,
textarea {
  width: 100%;
}
textarea {
  resize: vertical;
  line-height: 1.8;
}
.scope-options {
  margin: 0;
  padding: 12px 16px;
  border: 1px solid var(--om-line);
  border-radius: var(--om-radius);
  min-width: 0;
}
.scope-options legend {
  padding-inline: 8px;
  font-size: 14px;
}
.context-note {
  display: block;
  color: var(--om-muted);
  font-size: 12px;
  margin-top: 4px;
}
.stream-result {
  display: grid;
  gap: 4px;
  padding-block: 12px;
  border-bottom: 1px solid var(--om-line);
  overflow-wrap: anywhere;
}
.stream-result:last-child {
  border-bottom: 0;
}
.stream-result p {
  margin: 0;
}
.decision-group {
  display: grid;
  gap: 8px;
}
.decision-group h3 {
  margin: 0;
  font-size: 16px;
}
.decision-group:empty {
  display: none;
}
@media (max-width: 700px) {
  .scheduled-tasks {
    gap: 20px;
  }
  .page-heading {
    flex-direction: column;
  }
  .page-heading > :deep(.om-button) {
    align-self: flex-start;
  }
  .board-tools,
  .task-meta,
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .board-tools > :deep(.om-button) {
    justify-self: start;
  }
  .task-heading {
    flex-wrap: wrap;
  }
  .task-heading h2 {
    font-size: 20px;
  }
  .task-heading > div {
    flex-basis: 100%;
  }
  .task-meta {
    gap: 16px;
  }
  .actions {
    gap: 8px;
  }
  .settings-form,
  .result-view {
    gap: 20px;
  }
}
</style>
