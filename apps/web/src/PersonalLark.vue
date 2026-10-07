<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import {
  OmButton,
  OmBadge,
  OmEmpty,
  OmDisclosure,
  OmCheckbox,
  OmSelect,
} from "@omem/ui";
import { api, headers } from "./api";
import {
  attentionLabels,
  messageQuestions,
} from "../../server/src/integrations/lark-personal/policy";
import AssetImage from "./AssetImage.vue";
import FollowupFeedback from "./FollowupFeedback.vue";
import ReprocessControls from "./ReprocessControls.vue";
const emit = defineEmits<{ "open-revision": [id: string] }>();
const dimensions: Record<string, string> = {
  schedule: "安排与跟进",
  learning: "学习",
  business: "业务知识",
  code: "代码",
  attention: "关注原因",
  context: "需要补读",
  injection: "可疑指令",
};
type Settings = {
  enabled: boolean;
  intervalMinutes: number;
  historyHours: number;
  mentionExceptions: boolean;
  resources: boolean;
};
type Stream = {
  id: string;
  name: string;
  mode: string;
  last_success: string | null;
  last_error: string | null;
  kind: string;
};
type Item = {
  id: string;
  chat_name: string;
  text: string;
  sender?: string;
  link?: string;
  revision_id: string | null;
  state: string;
  error?: string;
  observed_at: string;
  decision: any;
  demonstration?: boolean;
  understanding: {
    stage: string;
    label: string;
    error?: string | null;
    note?: string;
    results: {
      id: string;
      text: string;
      state: string;
      kind: string;
      operation: string;
      applied: boolean;
      sourceCurrent: boolean;
    }[];
    questions: string[];
    projects: { id: string; name: string }[];
    requirements: {
      key: string;
      title: string;
      cited: boolean;
      current: boolean;
      state: string;
    }[];
    feedback: { id: string; text: string; active: number; scope: string }[];
    preferences?: { text: string }[];
  };
  resources: {
    kind: string;
    label: string;
    status: string;
    assetId?: string;
    revisionId?: string;
    error?: string;
  }[];
};
const settings = ref<Settings>({
  enabled: false,
  intervalMinutes: 5,
  historyHours: 24,
  mentionExceptions: true,
  resources: true,
});
const streams = ref<Stream[]>([]);
const savedSettings = ref<Settings | null>(null);
const settingsChanged = computed(
  () =>
    savedSettings.value &&
    JSON.stringify(settings.value) !== JSON.stringify(savedSettings.value),
);
const items = ref<Item[]>([]);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const query = ref("");
const limit = ref(30);
const model = ref("");
const messageFilter = ref("all"),
  messageQuery = ref(""),
  correcting = ref<Item | null>(null);
const shownItems = computed(() =>
  items.value.filter(
    (i) =>
      (!messageQuery.value ||
        `${i.text} ${i.chat_name} ${i.understanding.projects.map((p) => p.name).join(" ")}`.includes(
          messageQuery.value,
        )) &&
      (messageFilter.value === "all" ||
        (messageFilter.value === "needs"
          ? i.understanding.stage === "needs_context" ||
            !!i.error ||
            i.understanding.stage === "failed"
          : messageFilter.value === "updated"
            ? i.understanding.stage === "applied"
            : i.understanding.stage === "understanding")),
  ),
);
const resultLabels: Record<string, string> = {
  applied: "已保存",
  awaiting_decision: "等待判断",
  rejected: "未采用",
  stale: "已过期，待重查",
  proposed: "待复查",
  approved: "已确认",
  historical: "旧结论，已被后续更新",
  failed: "未完成",
};
async function revoke(i: Item, id: string) {
  await action(async () => {
    await api(
      `/integrations/lark-personal/inbox/${encodeURIComponent(i.id)}/feedback/${id}`,
      undefined,
      "DELETE",
    );
    notice.value = "已撤销纠正，正在重新理解。";
  });
}
const filtered = computed(() =>
  streams.value.filter(
    (s) =>
      s.id !== "@mentions" &&
      s.name.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
async function refresh(initial = false) {
  const [s, i] = await Promise.all([
    api<any>("/integrations/lark-personal"),
    api<Item[]>("/integrations/lark-personal/inbox"),
  ]);
  if (initial) settings.value = s.settings;
  savedSettings.value = { ...s.settings };
  streams.value = s.streams;
  items.value = i;
  model.value = s.decisions.status;
}
async function action(work: () => Promise<unknown>) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await work();
    await refresh();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
function discover() {
  return action(async () => {
    const r = await api<any>("/integrations/lark-personal/discover", {});
    notice.value = `找到 ${r.chats.length} 个非免打扰会话，已保留已有订阅。`;
  });
}
function save() {
  return action(async () => {
    await api("/integrations/lark-personal", settings.value, "PUT");
    notice.value = settings.value.enabled ? "定时采集已开启" : "定时采集已暂停";
  });
}
function subscribe(id: string, mode: string) {
  return action(() =>
    api(
      "/integrations/lark-personal/chats/" + encodeURIComponent(id),
      { mode },
      "PUT",
    ),
  );
}
function retry(id: string) {
  return action(async () => {
    await api(
      "/integrations/lark-personal/inbox/" + encodeURIComponent(id) + "/retry",
      {},
    );
    notice.value = "已安排重新读取资源和判断。";
  });
}
function understand(id: string) {
  return action(async () => {
    await api(
      `/integrations/lark-personal/inbox/${encodeURIComponent(id)}/understand`,
      {},
    );
    notice.value = "已安排重新理解保存的消息，不重新读取飞书。";
  });
}
function sync() {
  return action(async () => {
    const r = await api<any>("/integrations/lark-personal/sync", {});
    notice.value = `已安排 ${r.queued} 个会话同步，处理结果会自动更新。`;
  });
}
const modelLabels: Record<string, string> = {
  idle: "待运行",
  loading: "加载中",
  running: "判断中",
  ready: "已就绪",
  disabled: "未启用",
  unavailable: "暂不可用",
};
const label = (i: Item) => {
  const a = i.decision?.answers?.attention;
  return !a
    ? "等待判断"
    : a.confidence < 0.6
      ? "需要 Agent 补查"
      : attentionLabels[a.choice] || "等待判断";
};
async function download(id: string, label: string) {
  await action(async () => {
    const r = await fetch("/api/assets/" + id, { headers: headers() });
    if (!r.ok) throw Error("原件下载失败");
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = label;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  action(() => refresh(true));
  timer = setInterval(() => {
    if (!busy.value) refresh().catch(() => {});
  }, 5000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <section class="page personal-lark">
    <h1>飞书消息</h1>
    <p class="muted">
      用你的飞书个人登录读取已订阅会话。保留原消息、讨论、文档和附件；不会发送回复，也不改变飞书已读状态。
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <section
      class="lark-section collection-settings"
      aria-labelledby="lark-collection-title"
    >
      <header class="section-heading">
        <h2 id="lark-collection-title">采集设置</h2>
        <p class="muted">先选择要持续跟进的会话，再开启定时采集。</p>
      </header>
      <p class="collection-status" role="status">
        <template v-if="savedSettings"
          >{{ savedSettings.enabled ? "定时采集已开启" : "定时采集已暂停" }} ·
          已订阅
          {{ streams.filter((s) => s.mode === "watch").length }}
          个会话</template
        >
        <template v-else-if="busy">正在读取采集设置…</template>
        <template v-else>采集设置暂未读取成功，请重新加载。</template>
      </p>
      <div class="collection-toggle">
        <OmCheckbox v-model="settings.enabled" :disabled="busy"
          >开启定时采集</OmCheckbox
        >
        <span class="muted">{{
          settingsChanged
            ? "有未保存的调整，保存后生效。"
            : "修改后点“保存设置”使其生效。"
        }}</span>
      </div>
      <div class="settings-grid">
        <label
          >同步间隔（分钟）<input
            type="number"
            min="1"
            max="1440"
            :disabled="busy"
            v-model.number="settings.intervalMinutes"
        /></label>
        <label
          >新订阅首次回溯（小时）<input
            type="number"
            min="1"
            max="168"
            :disabled="busy"
            v-model.number="settings.historyHours"
        /></label>
      </div>
      <OmDisclosure class="collection-options" title="提及与资源采集">
        <div class="collection-checks">
          <OmCheckbox v-model="settings.mentionExceptions" :disabled="busy"
            >同时检查所有群里的 @我 / @所有人</OmCheckbox
          >
          <OmCheckbox v-model="settings.resources" :disabled="busy"
            >读取关联飞书文档、图片和附件</OmCheckbox
          >
        </div>
        <p class="muted">
          普通免打扰群只通过提及通道补读；尊重你单独屏蔽
          @所有人的设置。明确排除的会话连提及也不读取。机器人通知沿用已有绑定。
        </p>
      </OmDisclosure>
      <div class="actions">
        <OmButton :loading="busy" @click="save">保存设置</OmButton
        ><OmButton
          variant="secondary"
          :disabled="busy || !savedSettings?.enabled"
          @click="sync"
          >立即同步</OmButton
        ><span class="muted">决策模型：{{ modelLabels[model] || model }}</span>
      </div>
    </section>
    <section
      class="lark-section conversations"
      aria-labelledby="lark-conversations-title"
    >
      <header class="section-heading">
        <h2 id="lark-conversations-title">选择会话</h2>
        <p class="muted">
          订阅需要持续跟进的群聊或单聊，也可以明确排除某个会话。
        </p>
      </header>
      <div class="conversation-tools">
        <label
          >查找会话<input v-model="query" placeholder="输入群名或联系人"
        /></label>
        <OmButton variant="secondary" :loading="busy" @click="discover"
          >读取最近活跃会话</OmButton
        >
      </div>
      <p class="muted">
        发现时最多检查最近 300
        个会话，默认排除免打扰。勾选的订阅持久保存，不因会话暂时不活跃而消失。
      </p>
      <div v-if="filtered.length" class="conversation-list">
        <div v-for="s in filtered.slice(0, limit)" :key="s.id" class="stream">
          <div>
            <strong>{{ s.name }}</strong>
            <p class="muted">
              {{
                s.last_error ||
                (s.last_success
                  ? "上次成功：" + new Date(s.last_success).toLocaleString()
                  : "尚未同步")
              }}
            </p>
          </div>
          <label class="mode"
            >采集方式<OmSelect
              :value="s.mode"
              :disabled="busy"
              @change="
                subscribe(s.id, ($event.target as HTMLSelectElement).value)
              "
            >
              <option value="off">仅提及时</option>
              <option value="watch">订阅</option>
              <option value="excluded">排除</option>
            </OmSelect></label
          >
        </div>
      </div>
      <OmButton
        v-if="filtered.length > limit"
        variant="ghost"
        @click="limit += 30"
        >再显示 30 个</OmButton
      >
      <OmEmpty
        v-if="!filtered.length"
        title="尚无会话"
        description="读取最近活跃会话后，选择需要持续跟进的群聊或单聊。"
      />
    </section>
    <section
      class="lark-section message-results"
      aria-labelledby="lark-results-title"
    >
      <header class="section-heading">
        <h2 id="lark-results-title">消息与跟进结果</h2>
        <p class="muted">
          查看助手从消息中记下什么、关联了哪些项目，以及还需要补充什么。
        </p>
      </header>
      <div class="message-filters">
        <label
          >处理情况<OmSelect v-model="messageFilter">
            <option value="all">全部消息</option>
            <option value="needs">需要处理</option>
            <option value="updated">已有实际更新</option>
            <option value="understanding">正在理解</option>
          </OmSelect></label
        ><label
          >查找消息<input v-model="messageQuery" placeholder="消息、群名或项目"
        /></label>
      </div>
      <OmEmpty
        v-if="!items.length"
        title="还没有同步的消息"
        description="选定会话并保存采集设置后，这里会显示原文和判断结果。"
      />
      <OmEmpty
        v-if="items.length && !shownItems.length"
        title="没有符合筛选的消息"
      />
      <div v-if="shownItems.length" class="message-list">
        <article v-for="i in shownItems" :key="i.id" class="message">
          <div class="actions">
            <ReprocessControls
              v-if="i.revision_id"
              target="message"
              :target-id="i.id"
              :title="i.chat_name"
              :actions="['understand', 'describe', 'refresh', 'delete']"
            />
            <OmBadge v-if="i.demonstration">演示消息 · 非真实飞书记录</OmBadge>
            <OmBadge
              :tone="
                ['needs_context', 'failed'].includes(i.understanding.stage)
                  ? 'warning'
                  : 'neutral'
              "
              >{{ i.understanding.label }}</OmBadge
            ><span>{{ i.chat_name }}</span
            ><small>{{ new Date(i.observed_at).toLocaleString() }}</small>
          </div>
          <p class="message-text">{{ i.text }}</p>
          <p v-if="i.understanding.projects.length" class="muted">
            所属项目：{{
              i.understanding.projects.map((p) => p.name).join("、")
            }}
          </p>
          <section v-if="i.understanding.results.length" class="understood">
            <h3>助手记下了什么</h3>
            <ul>
              <li
                v-for="r in i.understanding.results.filter(
                  (r) => r.state !== 'historical',
                )"
                :key="r.id"
              >
                <div class="result-heading">
                  <b>{{
                    r.kind === "task"
                      ? "事项"
                      : r.operation === "create"
                        ? "记忆"
                        : "记忆变化"
                  }}</b
                  ><span class="muted">{{
                    resultLabels[r.state] || "待复查"
                  }}</span>
                </div>
                <p>{{ r.text }}</p>
                <small
                  v-if="i.understanding.stage === 'understanding'"
                  class="muted"
                  >上次结论；正在按新材料或纠正重新核对。</small
                >
              </li>
            </ul>
            <OmDisclosure
              v-if="
                i.understanding.results.some((r) => r.state === 'historical')
              "
              title="此前的结论"
              ><p
                v-for="r in i.understanding.results.filter(
                  (r) => r.state === 'historical',
                )"
                :key="r.id"
                class="muted"
              >
                {{ r.text }} · 已被后续更新
              </p></OmDisclosure
            >
          </section>
          <section
            v-if="i.understanding.questions.length"
            class="missing-context"
          >
            <h3>需要补充</h3>
            <p v-for="q in i.understanding.questions" :key="q">{{ q }}</p>
          </section>
          <p
            v-if="i.understanding.note && !i.understanding.results.length"
            class="muted"
          >
            {{ i.understanding.note }}
          </p>
          <OmDisclosure v-else-if="i.understanding.note" title="处理说明"
            ><p>{{ i.understanding.note }}</p></OmDisclosure
          >
          <div
            v-if="i.understanding.requirements.length"
            class="related-follows"
          >
            <p class="muted">关联跟进</p>
            <a
              v-for="r in i.understanding.requirements"
              :key="r.key"
              :href="'#/knowledge/' + encodeURIComponent(r.key)"
              >{{ r.title
              }}<small>{{
                r.cited
                  ? r.current
                    ? " · 已纳入当前需求"
                    : " · 已引用，等待更新"
                  : " · 在跟进范围内，待整理"
              }}</small></a
            >
          </div>
          <p v-if="i.understanding.error" class="error">
            {{ i.understanding.error }}
          </p>
          <div
            v-for="f in i.understanding.feedback.filter((f) => f.active)"
            :key="f.id"
            class="saved-feedback"
          >
            <p><b>我的纠正：</b>{{ f.text }}</p>
            <small class="muted">{{
              f.scope === "conversation"
                ? "用于这个会话的后续消息"
                : "针对这条消息"
            }}</small
            ><OmButton variant="ghost" @click="revoke(i, f.id)">撤销</OmButton>
          </div>
          <p v-if="i.error" class="error">{{ i.error }}</p>
          <OmButton
            v-if="i.state !== 'ready'"
            variant="secondary"
            :disabled="busy"
            @click="retry(i.id)"
            >重新读取与判断</OmButton
          >
          <div class="actions">
            <OmButton
              v-if="i.understanding.stage === 'failed'"
              variant="secondary"
              :disabled="busy"
              @click="understand(i.id)"
              >重新理解</OmButton
            >
            <OmButton
              v-if="i.revision_id"
              variant="secondary"
              @click="correcting = i"
              >纠正理解</OmButton
            >
            <OmButton
              v-if="i.revision_id"
              variant="ghost"
              @click="emit('open-revision', i.revision_id)"
              >查看保存的材料</OmButton
            ><a
              v-if="i.link && /^https:\/\//.test(i.link)"
              :href="i.link"
              target="_blank"
              rel="noopener noreferrer"
              >在飞书打开原消息</a
            >
          </div>
          <OmDisclosure v-if="i.resources.length" title="文档、图片与附件"
            ><div v-for="(r, n) in i.resources" :key="n" class="resource">
              <strong>{{ r.label }}</strong
              ><OmButton
                v-if="r.assetId"
                variant="ghost"
                @click="download(r.assetId, r.label)"
                >下载原件</OmButton
              >
              <p>
                {{
                  r.status === "read"
                    ? "正文已读取"
                    : r.status === "failed"
                      ? r.error
                      : r.error ||
                        (r.assetId || r.revisionId
                          ? "原件已保存，仍需理解内容"
                          : "资源尚未读取")
                }}
              </p>
              <AssetImage
                v-if="r.kind === 'image' && r.assetId"
                :id="r.assetId"
                :label="r.label"
              /><OmButton
                v-if="r.revisionId"
                variant="ghost"
                @click="emit('open-revision', r.revisionId)"
                >查看关联材料</OmButton
              >
            </div></OmDisclosure
          >
          <OmDisclosure v-if="i.decision" title="采集分类（处理建议）"
            ><p class="muted">
              {{ label(i) }}。这些标签不代表需求、记忆或待办已经更新。
            </p>
            <dl>
              <template v-for="(v, k) in i.decision.answers" :key="k"
                ><dt>{{ dimensions[String(k)] || k }}</dt>
                <dd>
                  {{
                    messageQuestions[String(k)]?.criteria[v.choice] || v.choice
                  }}
                  · 模型分数 {{ Math.round(v.confidence * 100) }}%（不是准确率）
                </dd></template
              >
            </dl></OmDisclosure
          >
        </article>
      </div>
    </section>
    <FollowupFeedback
      v-if="correcting"
      :open="true"
      :title="correcting.chat_name"
      :target="correcting.id"
      kind="message"
      @close="correcting = null"
      @saved="
        notice = '已保存纠正，正在重新理解；关联需求也会更新。';
        refresh();
      "
    />
  </section>
</template>
<style scoped>
.personal-lark {
  max-width: 1040px;
}
.personal-lark > h1 {
  margin-bottom: 12px;
}
.personal-lark > .muted {
  max-width: 64ch;
  margin: 0;
}
.lark-section {
  display: grid;
  gap: 16px;
  min-width: 0;
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--om-line);
}
.section-heading {
  display: grid;
  gap: 8px;
}
.section-heading h2 {
  font-family: var(--om-sans);
  font-size: 20px;
  margin: 0;
}
.section-heading p,
.lark-section > p,
.collection-options p {
  margin: 0;
  max-width: 64ch;
}
.collection-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.collection-toggle > span {
  font-size: 13px;
}
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  max-width: 560px;
}
.settings-grid label,
.mode,
.conversation-tools label {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.settings-grid input {
  width: 100%;
}
.collection-options {
  max-width: 760px;
}
.collection-checks {
  display: grid;
  gap: 4px;
  margin-bottom: 12px;
}
.actions {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
  margin: 0;
}
.conversation-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.conversation-tools label {
  flex: 1 1 280px;
  max-width: 440px;
}
.conversation-tools input {
  width: 100%;
}
.stream {
  display: flex;
  gap: 24px;
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid var(--om-line);
  align-items: center;
}
.stream > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.stream p {
  margin: 4px 0;
}
.mode {
  width: 176px;
  flex-shrink: 0;
}
.message {
  padding: 24px 0;
  border-bottom: 1px solid var(--om-line);
}
.message > .actions + .message-text {
  margin-top: 16px;
}
.message > .actions:not(:first-child) {
  margin-top: 16px;
}
.message-filters {
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
  gap: 16px;
  max-width: 760px;
}
.message-filters label {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.message-filters input {
  width: 100%;
}
.understood,
.missing-context {
  padding: 16px 20px;
  margin: 24px 0;
  background: var(--om-panel);
  border: 1px solid var(--om-line);
  border-radius: 8px;
}
.understood h3,
.missing-context h3 {
  font-family: inherit;
  font-weight: 600;
  font-size: 16px;
  line-height: 1.7;
  margin: 0 0 12px;
}
.understood ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.understood li + li {
  margin-top: 20px;
  border-top: 1px solid var(--om-line);
  padding-top: 16px;
}
.understood p {
  white-space: pre-wrap;
  margin: 8px 0;
}
.result-heading {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.related-follows {
  display: grid;
  gap: 8px;
  margin: 20px 0;
}
.related-follows p {
  margin: 0;
}
.related-follows a {
  min-height: 44px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--om-ink);
  text-underline-offset: 4px;
}
.saved-feedback {
  padding: 12px 16px;
  margin: 16px 0;
  background: var(--om-soft);
  overflow-wrap: anywhere;
}
.saved-feedback p {
  margin: 4px 0;
}
.message-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 18em;
  overflow: auto;
}
.resource {
  padding: 16px 0;
  overflow-wrap: anywhere;
}
.resource :deep(img) {
  max-width: 100%;
}
.error {
  color: var(--om-danger);
}
input:not([type="checkbox"]) {
  padding: 8px;
  min-height: 44px;
  max-width: 100%;
  box-sizing: border-box;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
}
dd {
  margin: 0;
}
@media (max-width: 700px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .stream {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .mode {
    font-size: 14px;
    width: 100%;
  }
  .message-filters {
    grid-template-columns: 1fr;
  }
  dl {
    grid-template-columns: 1fr;
  }
}
</style>
