<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { OmBadge, OmButton, OmDisclosure } from "@omem/ui";
import type { AttentionPolicy } from "../../../packages/contracts/src/work";
import { api } from "./api";

type Follow = {
  key: string;
  title: string;
  goal: string;
  attention: AttentionPolicy;
  current: boolean;
  maintenance: { enabled: boolean; state: string; error: string | null } | null;
};
type Task = {
  id: string;
  key: string;
  project: string;
  state: string;
  phase: string;
  message: string;
  error?: string;
  checks?: { name: string; exitCode: number }[];
  review?: { verdict: string; summary: string };
};
type Catalog = { requirements: Follow[]; development: Task[] };
const emit = defineEmits<{ compose: [text: string] }>();
const catalog = ref<Catalog>({ requirements: [], development: [] });
const loading = ref(true),
  error = ref("");
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
function title(key: string) {
  return (
    catalog.value.requirements.find((r) => r.key === key)?.title ?? "编码任务"
  );
}
function following(item: Follow) {
  if (!item.maintenance?.enabled) return "已暂停";
  return (
    (
      { writing: "正在更新", queued: "等待更新", failed: "更新失败" } as Record<
        string,
        string
      >
    )[item.maintenance.state] ?? (item.current ? "持续跟进中" : "等待调查")
  );
}
function phase(task: Task) {
  if (task.state === "cancelled") return "已停止";
  if (task.state === "failed") return "执行失败";
  return (
    (
      {
        queued: "等待执行",
        created: "准备项目",
        coding: "正在实现",
        checking: "正在检查",
        reviewing: "独立评审中",
        ready: "可查看结果",
        blocked: "需要补充",
        interrupted: "等待恢复",
        failed: "执行失败",
        applied: "已应用补丁",
      } as Record<string, string>
    )[task.phase] ?? "等待执行"
  );
}
function checks(task: Task) {
  const groups = new Map<
    string,
    { name: string; runs: number; failed: number; last: number }
  >();
  for (const check of task.checks ?? []) {
    const group = groups.get(check.name) ?? {
      name: check.name,
      runs: 0,
      failed: 0,
      last: 0,
    };
    group.runs++;
    group.failed += check.exitCode === 0 ? 0 : 1;
    group.last = check.exitCode;
    groups.set(check.name, group);
  }
  return [...groups.values()];
}
onMounted(() => {
  void reload();
  timer = setInterval(() => {
    if (!document.hidden) void reload();
  }, 10000);
});
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(timer);
});
defineExpose({ reload });
</script>

<template>
  <section class="work-panel" aria-label="需求跟进与编码">
    <div class="work-heading">
      <h2>正在跟进</h2>
      <OmButton variant="ghost" :disabled="loading" @click="reload"
        >刷新状态</OmButton
      >
    </div>
    <p v-if="loading" role="status" class="muted">正在读取跟进和后台任务…</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="!loading && !error && !catalog.requirements.length" class="muted">
      告诉助手要跟进哪个项目、重点关注什么。明确说“开始实现”后，才会交给编码
      Agent。
    </p>
    <OmDisclosure
      v-for="item in catalog.requirements"
      :key="item.key"
      :title="item.title"
    >
      <template #meta
        ><OmBadge
          :tone="item.maintenance?.state === 'failed' ? 'danger' : 'neutral'"
          >{{ following(item) }}</OmBadge
        ></template
      >
      <div class="work-detail">
        <p><b>跟进目标：</b>{{ item.goal }}</p>
        <p v-if="item.attention.focus.length">
          <b>重点关注：</b>{{ item.attention.focus.join("、") }}
        </p>
        <p v-if="item.attention.ignore.length" class="muted">
          暂不关注：{{ item.attention.ignore.join("、") }}
        </p>
        <p v-if="item.attention.instruction" class="muted">
          你的交代：{{ item.attention.instruction }}
        </p>
        <p class="muted">
          {{
            item.attention.notifications === "all"
              ? "有变化时通知"
              : "重要进展或需要处理时通知"
          }}
        </p>
        <p v-if="item.maintenance?.error" class="error">
          {{ item.maintenance.error }}
        </p>
        <div class="work-actions">
          <a
            class="work-link"
            :href="'#/knowledge/' + encodeURIComponent(item.key)"
            >阅读需求</a
          >
          <OmButton
            variant="ghost"
            @click="emit('compose', `关于「${item.title}」，我想调整关注点：`)"
            >在对话中调整</OmButton
          >
          <OmButton
            variant="ghost"
            @click="
              emit(
                'compose',
                `请说明「${item.title}」目前的进展、阻塞和需要我处理的事。`,
              )
            "
            >询问进展</OmButton
          >
        </div>
      </div>
    </OmDisclosure>
    <section
      v-if="catalog.development.length"
      class="development-list"
      aria-label="后台编码"
    >
      <h3>后台编码</h3>
      <article
        v-for="task in catalog.development"
        :key="task.id"
        class="development-item"
      >
        <div class="work-heading">
          <h4>{{ title(task.key) }}</h4>
          <OmBadge>{{ phase(task) }}</OmBadge>
        </div>
        <p v-if="task.phase === 'ready'">
          实现与独立评审已完成，可以查看检查结果。
        </p>
        <p v-else-if="['blocked', 'failed', 'applied'].includes(task.phase)">
          {{ task.message }}
        </p>
        <p v-else class="muted">后台会继续执行；有结果或需要补充时会通知你。</p>
        <p v-if="task.error" class="error">{{ task.error }}</p>
        <OmDisclosure
          v-if="task.checks?.length || task.review"
          title="检查与评审结果"
        >
          <ul v-if="task.checks?.length">
            <li v-for="check in checks(task)" :key="check.name">
              {{ check.name }}：{{
                check.failed === 0
                  ? `${check.runs} 次通过`
                  : `最近一次${check.last === 0 ? "通过" : "未通过"}，共 ${check.runs} 次检查`
              }}
            </li>
          </ul>
          <p v-if="task.review">{{ task.review.summary }}</p>
          <p v-if="task.phase === 'ready'" class="muted">
            修改保留在独立副本中，尚未应用到原仓库。
          </p>
        </OmDisclosure>
        <OmButton
          variant="ghost"
          @click="
            emit(
              'compose',
              `请查询「${title(task.key)}」在 ${task.project} 项目的编码任务，说明实际修改、检查和剩余问题。`,
            )
          "
          >在对话中查看结果</OmButton
        >
      </article>
    </section>
    <p
      v-if="catalog.requirements.length || catalog.development.length"
      class="work-help muted"
    >
      对话按钮会填入消息，你可以补充后发送。
    </p>
  </section>
</template>

<style scoped>
.work-panel {
  margin: 24px 0 32px;
  padding: 24px 0;
  border-block: 1px solid var(--om-line);
  max-width: 76ch;
  overflow-wrap: anywhere;
}
.work-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.work-heading h2,
.work-heading h4 {
  margin: 0;
}
.work-heading h2 {
  font-size: 22px;
}
.work-heading h4 {
  font-size: 16px;
  font-family: inherit;
}
.work-detail {
  padding: 0 8px 16px;
}
.work-detail p,
.development-item p {
  margin: 12px 0;
}
.work-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 16px;
}
.work-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 8px;
  color: var(--om-ink);
  text-underline-offset: 4px;
}
.development-list {
  margin-top: 24px;
}
.development-item {
  padding: 16px 0;
  border-bottom: 1px solid var(--om-line);
}
.work-help {
  font-size: 13px;
  margin-top: 20px;
}
@media (max-width: 700px) {
  .work-panel {
    padding-block: 16px;
  }
  .work-detail {
    padding-inline: 0;
  }
}
</style>
