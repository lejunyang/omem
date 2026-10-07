<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed } from "vue";
import { OmBadge, OmButton, OmDisclosure, OmEmpty, OmSelect } from "@omem/ui";
import type { AssistantWork } from "../../server/src/assistant/work";
import { api } from "./api";
import FollowupFeedback from "./FollowupFeedback.vue";
type Catalog = ReturnType<AssistantWork["catalog"]>;
type Follow = Catalog["requirements"][number];
type Task = Catalog["development"][number];
const emit = defineEmits<{
  compose: [text: string];
  "open-revision": [id: string];
}>();
const catalog = ref<Catalog | null>(null),
  loading = ref(true),
  error = ref(""),
  notice = ref("");
const project = ref(""),
  filter = ref("all"),
  edit = ref<{ item: Follow; mode: "correction" | "attention" } | null>(null);
const diff = ref<Record<string, string>>({}),
  nextLine = ref<Record<string, number | null>>({}),
  resultBusy = ref("");
const visible = computed(() =>
  (catalog.value?.requirements ?? []).filter(
    (r) => !project.value || r.key === project.value,
  ),
);
const personal = (item: Follow) => [
  ...new Map(
    [
      ...item.personalTasks,
      ...item.actions.flatMap((a) =>
        a.personalTask &&
        !["done", "cancelled"].includes(String(a.personalTask.status))
          ? [a.personalTask]
          : [],
      ),
    ].map((t) => [t.id, t]),
  ).values(),
];
const needs = (item: Follow) =>
  item.questions.filter((q) => q.kind === "decision" && q.blocking).length;
const counts = computed(() => ({
  all: visible.value.length,
  needs: visible.value.reduce((n, r) => n + needs(r), 0),
  waiting: visible.value.reduce(
    (n, r) => n + r.actions.filter((a) => a.status === "waiting").length,
    0,
  ),
  todos: visible.value.reduce((n, r) => n + personal(r).length, 0),
}));
function actions(item: Follow) {
  return item.actions.filter((a) =>
    filter.value === "needs"
      ? false
      : filter.value === "waiting"
        ? a.status === "waiting"
        : filter.value === "todos"
          ? !!a.personalTask &&
            !["done", "cancelled"].includes(String(a.personalTask.status))
          : !["done", "cancelled"].includes(a.status),
  );
}
const shown = computed(() =>
  visible.value.filter(
    (r) =>
      filter.value === "all" ||
      (filter.value === "needs"
        ? needs(r) > 0
        : filter.value === "todos"
          ? personal(r).length > 0
          : actions(r).length > 0),
  ),
);
let timer: ReturnType<typeof setInterval> | undefined,
  disposed = false,
  pending = false;
async function reload() {
  if (pending) return;
  pending = true;
  try {
    const data = await api<Catalog>("/work");
    if (!disposed) {
      catalog.value = data;
      error.value = "";
    }
  } catch (e) {
    if (!disposed)
      error.value = `跟进状态暂时无法读取：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    pending = false;
    if (!disposed) loading.value = false;
  }
}
function following(item: Follow) {
  if (!item.maintenance?.enabled) return "已暂停自动跟进";
  return (
    (
      {
        writing: "正在更新理解",
        queued: "等待更新",
        failed: "更新未完成",
      } as Record<string, string>
    )[item.maintenance.state] ??
    (item.current ? "持续跟进" : "材料变化，等待复查")
  );
}
function phase(task: Task) {
  if (task.state === "cancelled") return "已停止";
  return (
    (
      {
        queued: "等待执行",
        created: "准备项目",
        coding: "正在实现",
        checking: "正在检查",
        reviewing: "独立评审中",
        ready: "检查与评审已完成",
        blocked: "需要补充",
        interrupted: "等待恢复",
        failed: "执行未完成",
        applied: "已应用补丁",
      } as Record<string, string>
    )[task.phase] ?? "等待执行"
  );
}
function checks(task: Task) {
  return [...new Map((task.checks ?? []).map((c) => [c.name, c])).values()];
}
function title(key: string) {
  return (
    catalog.value?.requirements.find((r) => r.key === key)?.title ?? "编码任务"
  );
}
async function showDiff(task: Task, more = false) {
  if (diff.value[task.id] && !more) {
    delete diff.value[task.id];
    return;
  }
  resultBusy.value = task.id;
  try {
    const r = await api<Awaited<ReturnType<AssistantWork["result"]>>>(
      `/work/development/${task.id}/result?startLine=${more ? (nextLine.value[task.id] ?? 1) : 1}`,
    );
    diff.value[task.id] =
      (more ? diff.value[task.id] + "\n" : "") +
      (r.diff?.text ?? "还没有保存代码差异。");
    nextLine.value[task.id] = r.diff?.nextLine ?? null;
  } catch (e) {
    error.value = String(e);
  } finally {
    resultBusy.value = "";
  }
}
async function revoke(item: Follow, feedbackId: string) {
  try {
    await api("/work/actions", {
      requestId: crypto.randomUUID(),
      userText: "撤销这条纠正",
      action: {
        operation: "revoke_feedback",
        key: item.key,
        expectedVersion: item.version,
        feedbackId,
      },
    });
    notice.value = "已撤销，正在重新调查。";
    await reload();
  } catch (e) {
    error.value = String(e);
  }
}
onMounted(() => {
  void reload();
  timer = setInterval(() => {
    if (!document.hidden) void reload();
  }, 5000);
});
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(timer);
});
defineExpose({ reload });
</script>
<template>
  <section class="work-panel" aria-label="项目跟进">
    <div class="work-heading">
      <div>
        <h2>项目跟进</h2>
        <p class="muted">看变化、等回复、推进自己的事。</p>
      </div>
      <OmButton variant="ghost" :disabled="loading" @click="reload"
        >刷新状态</OmButton
      >
    </div>
    <p v-if="loading" role="status">正在读取跟进…</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="catalog?.requirements.length">
      <div class="work-filters">
        <label
          >查看项目<OmSelect v-model="project">
            <option value="">所有跟进项目</option>
            <option
              v-for="r in catalog.requirements"
              :key="r.key"
              :value="r.key"
            >
              {{ r.title }}
            </option>
          </OmSelect></label
        >
        <div class="filter-tabs" aria-label="跟进内容">
          <OmButton
            v-for="(name, k) in {
              all: '全部',
              needs: '需要你决定',
              waiting: '等待回复',
              todos: '个人待办',
            }"
            :key="k"
            :variant="filter === k ? 'primary' : 'secondary'"
            :aria-pressed="filter === k"
            @click="filter = k"
            >{{ name }} {{ counts[k] }}</OmButton
          >
        </div>
      </div>
      <OmEmpty
        v-if="!shown.length"
        title="当前筛选下没有待处理内容"
        description="可以查看全部项目，或调整关注点。"
      />
      <article v-for="item in shown" :key="item.key" class="follow-card">
        <div class="work-heading">
          <h3>{{ item.title }}</h3>
          <OmBadge
            :tone="item.maintenance?.state === 'failed' ? 'danger' : 'neutral'"
            >{{ following(item) }}</OmBadge
          >
        </div>
        <p class="summary">{{ item.summary || item.goal }}</p>
        <p v-if="!item.current" class="muted">
          当前展示上次整理结果；新材料与纠正处理完成后会更新。
        </p>
        <div
          v-if="filter === 'all' && item.latestChange?.lines.length"
          class="recent-change"
        >
          <h4>最近变化</h4>
          <ul>
            <li v-for="line in item.latestChange.lines.slice(0, 4)" :key="line">
              {{ line }}
            </li>
          </ul>
          <small class="muted">{{
            new Date(item.latestChange.at).toLocaleString("zh-CN")
          }}</small>
        </div>
        <section
          v-if="
            (filter === 'all' || filter === 'needs') &&
            item.questions.some(
              (q) =>
                q.kind === 'decision' && (filter !== 'needs' || q.blocking),
            )
          "
          class="questions"
          aria-label="需要你决定"
        >
          <h4>
            {{ item.current ? "需要你决定" : "上次整理留下的选择，请等待更新" }}
          </h4>
          <div
            v-for="q in item.questions.filter(
              (q) =>
                q.kind === 'decision' && (filter !== 'needs' || q.blocking),
            )"
            :key="q.id"
            class="decision-question"
          >
            <strong>{{ q.question }}</strong>
            <p class="muted">
              {{ q.blocking ? "需要现在选择" : "可稍后决定" }} · {{ q.why }}
            </p>
            <p>{{ q.nextStep }}</p>
          </div>
        </section>
        <OmDisclosure
          v-if="
            filter === 'all' &&
            item.questions.some((q) => q.kind !== 'decision')
          "
          title="待补查资料与可并行完善的细节"
        >
          <div
            v-for="q in item.questions.filter((q) => q.kind !== 'decision')"
            :key="q.id"
          >
            <h4>{{ q.question }}</h4>
            <p class="muted">
              {{ q.kind === "supplement" ? "非阻塞补充" : "助手需补查" }} ·
              {{ q.nextStep }}
            </p>
          </div>
        </OmDisclosure>
        <ul
          v-if="filter === 'todos' && personal(item).length"
          class="action-list"
        >
          <li v-for="t in personal(item)" :key="String(t.id)">
            <b>{{ t.title }}</b>
            <p>{{ t.nextStep || t.detail }}</p>
            <p v-if="t.followUp?.waiting_on" class="muted">
              等待：{{ t.followUp.waiting_on }}
            </p>
            <p v-if="t.followUp?.next_check_at" class="muted">
              检查时间：{{
                new Date(t.followUp.next_check_at).toLocaleString("zh-CN")
              }}
            </p>
            <a class="work-link" href="#/tasks">打开个人待办</a>
          </li>
        </ul>
        <ul v-else-if="actions(item).length" class="action-list">
          <li v-for="a in actions(item)" :key="a.id">
            <div class="work-heading">
              <b>{{ a.title }}</b
              ><OmBadge
                :tone="a.certainty === 'confirmed' ? 'neutral' : 'warning'"
                >{{
                  a.certainty === "proposed"
                    ? "提议，尚未决定"
                    : a.certainty === "uncertain"
                      ? "需要核实"
                      : a.status === "waiting"
                        ? "等待回复"
                        : a.personalTask
                          ? "个人待办"
                          : "待推进"
                }}</OmBadge
              >
            </div>
            <p v-if="a.detail" class="action-detail">{{ a.detail }}</p>
            <p v-if="a.owner || a.waitingOn || a.dueExpression" class="muted">
              {{ a.owner ? `负责人：${a.owner}` : ""
              }}{{ a.waitingOn ? ` · 等待：${a.waitingOn}` : ""
              }}{{ a.dueExpression ? ` · 时间：${a.dueExpression}` : "" }}
            </p>
            <div class="work-actions">
              <OmButton
                v-for="s in a.sources"
                :key="s.revisionId"
                variant="ghost"
                @click="emit('open-revision', s.revisionId)"
                >来源：{{ s.title }}</OmButton
              ><a v-if="a.personalTask" class="work-link" href="#/tasks"
                >打开个人待办</a
              >
            </div>
          </li>
        </ul>
        <p v-else-if="filter === 'all' && !item.questions.length" class="muted">
          当前没有待推进行动；继续留意所选材料的变化。
        </p>
        <p v-if="item.maintenance?.error" class="error">
          {{ item.maintenance.error }}
        </p>
        <div class="work-actions">
          <a
            class="work-link"
            :href="'#/knowledge/' + encodeURIComponent(item.key)"
            >阅读完整需求</a
          ><OmButton
            variant="secondary"
            @click="edit = { item, mode: 'correction' }"
            >纠正理解</OmButton
          ><OmButton variant="ghost" @click="edit = { item, mode: 'attention' }"
            >调整关注点</OmButton
          >
        </div>
        <OmDisclosure title="关注点与我的反馈"
          ><p>
            <b>重点关注：</b
            >{{ item.attention.focus.join("、") || "项目整体进展" }}
          </p>
          <p v-if="item.attention.ignore.length">
            暂不关注：{{ item.attention.ignore.join("、") }}
          </p>
          <p>
            {{
              item.attention.notifications === "all"
                ? "有变化时通知"
                : "重要进展或需要处理时通知"
            }}
          </p>
          <div
            v-for="f in item.feedback.filter((f) => f.active)"
            :key="f.id"
            class="feedback-line"
          >
            <p>{{ f.text }}</p>
            <OmButton variant="ghost" @click="revoke(item, f.id)"
              >撤销这条反馈</OmButton
            >
          </div></OmDisclosure
        >
      </article>
    </template>
    <OmEmpty
      v-else-if="!loading && !error"
      title="还没有跟进项目"
      description="告诉助手要跟进哪个项目、关注什么；明确交办实现后才会开始编码。"
    />
    <section
      v-if="catalog?.development.length"
      class="development-list"
      aria-label="编码进展"
    >
      <h3>编码进展与调整计划</h3>
      <article
        v-for="task in catalog.development.filter(
          (t) => !project || t.key === project,
        )"
        :key="task.id"
        class="development-item"
      >
        <div class="work-heading">
          <h4>{{ title(task.key) }}</h4>
          <OmBadge>{{ phase(task) }}</OmBadge>
        </div>
        <p v-if="task.phase === 'ready'">
          本轮实现已完成，检查与独立评审通过。
        </p>
        <p v-else>{{ task.message }}</p>
        <p v-if="task.phase === 'ready'" class="muted">
          修改在独立副本中，尚未应用到原仓库，也未发布。
        </p>
        <section v-if="task.changePlan" class="change-plan">
          <h4>本轮怎么调整</h4>
          <p>{{ task.changePlan.summary }}</p>
          <div class="plan-columns">
            <div v-if="task.changePlan.preserve.length">
              <b>保留</b>
              <ul>
                <li v-for="s in task.changePlan.preserve" :key="s">{{ s }}</li>
              </ul>
            </div>
            <div v-if="task.changePlan.change.length">
              <b>调整</b>
              <ul>
                <li v-for="s in task.changePlan.change" :key="s">{{ s }}</li>
              </ul>
            </div>
          </div>
          <p v-for="q in task.changePlan.questions" :key="q">待确认：{{ q }}</p>
        </section>
        <OmDisclosure
          v-if="task.requirementChanges.length"
          title="调整来自哪些变化"
          ><div
            v-for="change in task.requirementChanges"
            :key="change.toRevision"
          >
            <p><b>原目标：</b>{{ change.before.objective }}</p>
            <p><b>新目标：</b>{{ change.after.objective }}</p>
            <ul>
              <li
                v-for="c in change.after.criteria.filter(
                  (c) =>
                    change.criteria.added.includes(c.id) ||
                    change.criteria.changed.includes(c.id),
                )"
                :key="c.id"
              >
                {{ c.description }}
              </li>
            </ul>
            <a
              class="work-link"
              :href="'#/knowledge/' + encodeURIComponent(task.key)"
              >查看需求与消息来源</a
            >
          </div></OmDisclosure
        >
        <OmDisclosure
          v-if="task.checks?.length || task.review"
          title="检查与独立评审"
          ><ul>
            <li v-for="check in checks(task)" :key="check.name">
              {{ check.name }}：{{
                check.exitCode === 0 ? "最近一次通过" : "最近一次未通过"
              }}
            </li>
          </ul>
          <p v-if="task.review">{{ task.review.summary }}</p></OmDisclosure
        >
        <section v-if="task.phase === 'ready'" class="implementation-summary">
          <h4>实现说明</h4>
          <p class="action-detail">{{ task.message }}</p>
        </section>
        <p v-if="task.error" class="error">{{ task.error }}</p>
        <div class="work-actions">
          <OmButton
            variant="secondary"
            :loading="resultBusy === task.id"
            @click="showDiff(task)"
            >{{ diff[task.id] ? "收起代码差异" : "查看代码差异" }}</OmButton
          ><OmButton
            variant="ghost"
            @click="
              emit(
                'compose',
                `请查询「${title(task.key)}」的编码结果，说明还需要处理什么。`,
              )
            "
            >向助手询问</OmButton
          >
        </div>
        <pre v-if="diff[task.id]" class="code-diff">{{ diff[task.id] }}</pre>
        <OmButton
          v-if="diff[task.id] && nextLine[task.id]"
          variant="secondary"
          :loading="resultBusy === task.id"
          @click="showDiff(task, true)"
          >继续查看差异</OmButton
        >
      </article>
    </section>
    <FollowupFeedback
      v-if="edit"
      :open="true"
      :title="edit.item.title"
      :target="edit.item.key"
      kind="requirement"
      :mode="edit.mode"
      :version="edit.item.version"
      :attention="edit.item.attention"
      @close="edit = null"
      @saved="
        notice = '已保存，正在按你的反馈重新调查。';
        reload();
      "
    />
  </section>
</template>
<style scoped>
.work-panel {
  margin: 24px 0 32px;
  padding: 24px 0;
  border-block: 1px solid var(--om-line);
  max-width: 88ch;
  overflow-wrap: anywhere;
}
.work-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
h2,
h3,
h4 {
  margin: 0;
}
h2 {
  font-size: 24px;
}
h3 {
  font-size: 21px;
}
h4 {
  font-size: 16px;
  font-family: inherit;
}
p {
  margin: 12px 0;
}
.work-heading p {
  margin: 4px 0 0;
}
.work-filters {
  margin: 24px 0;
  display: grid;
  gap: 16px;
}
label {
  max-width: 420px;
  min-width: 0;
}
.filter-tabs,
.work-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.work-actions {
  margin: 16px 0;
}
.work-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 8px;
  color: var(--om-ink);
  text-underline-offset: 4px;
}
.follow-card {
  padding: 24px;
  margin: 24px 0;
  border: 1px solid var(--om-line);
  border-radius: 8px;
  background: var(--om-panel);
}
.summary {
  max-width: 72ch;
}
.recent-change,
.change-plan {
  padding: 16px;
  background: var(--om-paper);
  border-left: 3px solid var(--om-line);
  margin: 24px 0;
}
ul {
  padding-left: 22px;
  margin: 12px 0;
}
li + li {
  margin-top: 8px;
}
.action-list {
  list-style: none;
  padding: 0;
  margin: 24px 0;
}
.action-list > li {
  padding: 20px 0;
  border-bottom: 1px solid var(--om-line);
}
.action-list p {
  margin: 8px 0;
}
.questions {
  margin: 24px 0;
  padding: 16px 20px;
  border-left: 2px solid var(--om-ink);
  background: var(--om-paper);
}
.decision-question {
  margin-top: 16px;
}
.decision-question + .decision-question {
  padding-top: 16px;
  border-top: 1px solid var(--om-line);
}
.decision-question p {
  margin: 8px 0 0;
}
.action-detail {
  max-width: 72ch;
  white-space: pre-wrap;
}
.feedback-line {
  margin: 16px 0;
}
.development-list {
  margin-top: 32px;
}
.development-item {
  padding: 24px 0;
  border-bottom: 1px solid var(--om-line);
}
.plan-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
  margin-top: 16px;
}
.code-diff {
  background: var(--om-soft);
  border: 1px solid var(--om-line);
  padding: 16px;
  margin-top: 16px;
  max-height: 400px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre;
}
.error {
  color: var(--om-danger);
}
@media (max-width: 700px) {
  .follow-card {
    padding: 16px;
  }
  .work-panel {
    padding-block: 16px;
  }
  .plan-columns {
    grid-template-columns: 1fr;
    gap: 16px;
  }
}
</style>
