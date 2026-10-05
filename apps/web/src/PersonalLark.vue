<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { OmButton, OmPanel, OmBadge, OmEmpty, OmDisclosure } from "@omem/ui";
import { api, headers } from "./api";
import {
  attentionLabels,
  messageQuestions,
} from "../../server/src/integrations/lark-personal/policy";
import AssetImage from "./AssetImage.vue";
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
const items = ref<Item[]>([]);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const query = ref("");
const limit = ref(30);
const model = ref("");
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
    <OmPanel title="采集范围与频率">
      <div class="settings-grid">
        <label
          ><input type="checkbox" v-model="settings.enabled" />
          开启定时采集</label
        >
        <label
          >同步间隔（分钟）<input
            type="number"
            min="1"
            max="1440"
            v-model.number="settings.intervalMinutes"
        /></label>
        <label
          >新订阅首次回溯（小时）<input
            type="number"
            min="1"
            max="168"
            v-model.number="settings.historyHours"
        /></label>
        <label
          ><input type="checkbox" v-model="settings.mentionExceptions" />
          同时检查所有群里的 @我 / @所有人</label
        >
        <label
          ><input type="checkbox" v-model="settings.resources" />
          读取关联飞书文档、图片和附件</label
        >
      </div>
      <p class="muted">
        普通免打扰群只通过提及通道补读；尊重你单独屏蔽
        @所有人的设置。明确排除的会话连提及也不读取。机器人通知沿用已有绑定。
      </p>
      <div class="actions">
        <OmButton :loading="busy" @click="save">保存设置</OmButton
        ><OmButton
          variant="secondary"
          :disabled="busy || !settings.enabled"
          @click="sync"
          >立即同步</OmButton
        ><span class="muted">决策模型：{{ modelLabels[model] || model }}</span>
      </div>
    </OmPanel>
    <OmDisclosure title="选择会话" :default-open="true">
      <div class="actions">
        <OmButton variant="secondary" :loading="busy" @click="discover"
          >读取最近活跃会话</OmButton
        ><label
          >查找会话<input v-model="query" placeholder="输入群名或联系人"
        /></label>
      </div>
      <p class="muted">
        发现时最多检查最近 300
        个会话，默认排除免打扰。勾选的订阅持久保存，不因会话暂时不活跃而消失。
      </p>
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
          >采集方式<select
            :value="s.mode"
            :disabled="busy"
            @change="
              subscribe(s.id, ($event.target as HTMLSelectElement).value)
            "
          >
            <option value="off">仅提及时</option>
            <option value="watch">订阅</option>
            <option value="excluded">排除</option>
          </select></label
        >
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
    </OmDisclosure>
    <h2>最近消息与判断</h2>
    <p class="muted">
      小模型判断关注原因、安排、学习、业务与代码，并检查缺失背景及可疑指令。标签只是处理建议，事项和记忆仍由现有
      Agent 调查与复核。
    </p>
    <OmEmpty
      v-if="!items.length"
      title="还没有同步的消息"
      description="选定会话并保存采集设置后，这里会显示原文和判断结果。"
    />
    <article v-for="i in items" :key="i.id" class="message">
      <div class="actions">
        <OmBadge>{{ label(i) }}</OmBadge
        ><span>{{ i.chat_name }}</span
        ><small>{{ new Date(i.observed_at).toLocaleString() }}</small>
      </div>
      <p class="message-text">{{ i.text }}</p>
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
      <OmDisclosure v-if="i.decision" title="判断依据与分类"
        ><dl>
          <template v-for="(v, k) in i.decision.answers" :key="k"
            ><dt>{{ dimensions[String(k)] || k }}</dt>
            <dd>
              {{ messageQuestions[String(k)]?.criteria[v.choice] || v.choice }}
              · 模型分数 {{ Math.round(v.confidence * 100) }}%（不是准确率）
            </dd></template
          >
        </dl></OmDisclosure
      >
    </article>
  </section>
</template>
<style scoped>
.personal-lark {
  max-width: 1120px;
}
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.settings-grid label {
  display: flex;
  flex-direction: row;
  justify-content: flex-start;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.actions {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
  margin: 16px 0;
}
.actions label {
  display: flex;
  flex-direction: row;
  gap: 8px;
  align-items: center;
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
  flex-shrink: 0;
}
.mode select {
  display: block;
  min-height: 44px;
}
.message {
  padding: 24px 0;
  border-bottom: 1px solid var(--om-line);
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
input[type="number"] {
  width: 90px;
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
    align-items: flex-start;
    gap: 12px;
  }
  .actions label {
    flex-wrap: wrap;
  }
  .mode {
    font-size: 14px;
  }
  dl {
    grid-template-columns: 1fr;
  }
}
</style>
