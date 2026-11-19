<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { RecordingTarget } from "../shared/omem-client";
import { stepTitle } from "../shared/recording";
import type { OmemContext } from "./use-omem";
import { type TabChoice, useRecording } from "./use-recording";

// 侧栏的「录制」：说要教什么、选标签页、开始；录的时候步骤一条条出现，可以加标记、删步骤；
// 停下后选“整理成技能”（交给助手）或“只保存”，上传给 omem。录制的数据在后台和 IndexedDB 里，关掉侧栏不丢。

const props = defineProps<{ omem: OmemContext }>();
const emit = defineEmits<{ recording: [live: boolean] }>();
const rec = useRecording();
const { session, items, isRecording, notice, pointing, pointed, now, loading } = rec;

// 告诉侧栏是不是正在录（标签上的红点；打开侧栏时正在录就切到这一页）
watch(
  () => [loading.value, isRecording.value] as const,
  ([pending, live]) => {
    if (!pending) emit("recording", live);
  },
  { immediate: true }
);

const goal = ref("");
const tabChoices = ref<TabChoice[]>([]);
const tabId = ref<number | null>(null);
const marking = ref(false);
const note = ref("");
const confirmDiscard = ref(false);
const confirmRemove = ref<string | null>(null);
const targets = ref<RecordingTarget[]>([]);
const target = ref("");
const editedGoal = ref("");

type UploadState =
  | { phase: "sending"; organize: boolean }
  | { phase: "error"; message: string }
  | { phase: "done"; organize: boolean; recordingId: string; link: string | null };
const uploadState = ref<UploadState | null>(null);

async function refreshTabs(): Promise<void> {
  tabChoices.value = await rec.tabs();
  if (!tabChoices.value.some((tab) => tab.id === tabId.value)) tabId.value = tabChoices.value.find((tab) => tab.active)?.id ?? tabChoices.value[0]?.id ?? null;
}

const onActivated = () => void refreshTabs();
onMounted(() => {
  void refreshTabs();
  chrome.tabs.onActivated.addListener(onActivated);
});
onBeforeUnmount(() => chrome.tabs.onActivated.removeListener(onActivated));

// 停下后再读能接着的关注和事项（只读一次）
watch(
  () => session.value?.status === "stopped" && props.omem.status.value.state === "ok",
  async (ready) => {
    if (ready && !targets.value.length) targets.value = await props.omem.recordingTargets().catch(() => []);
  },
  { immediate: true }
);
watch(
  () => session.value?.goal,
  (value) => (editedGoal.value = value ?? ""),
  { immediate: true }
);

const elapsed = computed(() => {
  const s = session.value;
  if (!s) return "";
  const seconds = Math.max(0, Math.round(((s.stoppedAt ?? now.value) - s.startedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
});

const isOwner = computed(() => props.omem.status.value.state === "ok" && props.omem.status.value.me.id === "owner");
const uploadHint = computed(() => {
  const status = props.omem.status.value;
  if (!props.omem.active.value) return "先连接 omem";
  if (status.state === "error") return status.message;
  if (status.state !== "ok") return "正在连接 omem";
  if (!isOwner.value) return "只有 omem 的本人能上传录制";
  return items.value.length ? "" : "还没有记下任何一步";
});
const canUpload = computed(() => !uploadHint.value && uploadState.value?.phase !== "sending");

async function start(): Promise<void> {
  if (tabId.value === null) return;
  uploadState.value = null;
  if (await rec.start(goal.value, tabId.value)) goal.value = "";
}

async function addCurrentTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id === "number") await rec.addTab(tab.id);
}

function openMark(): void {
  marking.value = true;
  note.value = "";
  pointed.value = null;
}

async function saveMark(): Promise<void> {
  if (!note.value.trim()) return;
  if (await rec.mark(note.value)) {
    marking.value = false;
    note.value = "";
  }
}

function cancelMark(): void {
  marking.value = false;
  pointed.value = null;
}

async function remove(id: string): Promise<void> {
  if (confirmRemove.value !== id) {
    confirmRemove.value = id;
    setTimeout(() => confirmRemove.value === id && (confirmRemove.value = null), 3000);
    return;
  }
  confirmRemove.value = null;
  await rec.deleteStep(id);
}

async function discard(): Promise<void> {
  if (!confirmDiscard.value) {
    confirmDiscard.value = true;
    setTimeout(() => (confirmDiscard.value = false), 3000);
    return;
  }
  confirmDiscard.value = false;
  await rec.discard();
}

async function upload(organize: boolean): Promise<void> {
  uploadState.value = { phase: "sending", organize };
  try {
    if (editedGoal.value !== (session.value?.goal ?? "")) await rec.setGoal(editedGoal.value);
    const [kind, id] = target.value.split(":");
    const result = await rec.upload(props.omem, { organize, ...(kind === "context" ? { contextId: id } : kind === "item" ? { itemId: id } : {}) });
    uploadState.value = { phase: "done", organize, recordingId: result.recording.id, link: result.conversationId ? props.omem.webUrl(`/ask/${result.conversationId}`) : null };
  } catch (error) {
    uploadState.value = { phase: "error", message: (error as Error).message };
  }
}

function host(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

function time(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const kindLabel: Record<string, string> = { click: "点击", input: "填写", submit: "提交", enter: "回车", navigate: "页面", mark: "标记" };
</script>

<template>
  <section class="rec" aria-label="录制">
    <div v-if="uploadState && !session" class="send-result rec-result" :class="`is-${uploadState.phase}`" role="status" data-testid="record-upload-result">
      <template v-if="uploadState.phase === 'error'">上传失败：{{ uploadState.message }}</template>
      <template v-else-if="uploadState.phase === 'done'">
        <span>{{ uploadState.organize ? "已交给助手整理成技能。" : "已保存到 omem。" }}录制 {{ uploadState.recordingId }}</span>
        <a v-if="uploadState.link" :href="uploadState.link" target="_blank" rel="noreferrer">在 omem 中继续</a>
      </template>
    </div>

    <!-- 没有录制：说要教什么、选标签页 -->
    <div v-if="!session" class="rec-setup">
      <label class="rec-label" for="rec-goal">要教助手做什么</label>
      <textarea id="rec-goal" v-model="goal" class="filter-input rec-textarea" rows="3" placeholder="例如：在后台给某个商户开通退款权限" data-testid="record-goal" />
      <label class="rec-label" for="rec-tab">录哪个标签页</label>
      <select id="rec-tab" v-model="tabId" class="preset-select rec-tab-select" data-testid="record-tab" @focus="refreshTabs">
        <option v-for="tab in tabChoices" :key="tab.id" :value="tab.id">{{ tab.active ? "（当前）" : "" }}{{ tab.title }}</option>
      </select>
      <p class="rec-tip muted">
        点击、填写、提交和打开的页面都会记下，每步截一张可视区；从这个页面打开的新标签页一起录。密码、验证码、卡号一类的输入框只记“填了”，不记内容；请求里的 cookie、令牌换成占位。
        请求默认只有地址、状态和请求体；同时开着这个页面的 DevTools，还会记下响应体。
      </p>
      <p v-if="notice" class="basket-notice">
        <span>{{ notice }}</span>
      </p>
      <button class="button button-primary rec-start" type="button" :disabled="tabId === null" data-testid="record-start" @click="start">
        <i class="rec-dot" aria-hidden="true" />开始录制
      </button>
      <p v-if="!tabChoices.length" class="muted rec-tip">这个窗口里没有可以录制的网页。</p>
    </div>

    <!-- 录制中 / 已停止 -->
    <template v-else>
      <header class="rec-status" :class="{ 'is-recording': isRecording }">
        <i class="rec-dot" aria-hidden="true" />
        <strong>{{ isRecording ? "录制中" : "已停止" }}</strong>
        <span class="muted rec-counts" data-testid="record-counts">
          {{ elapsed }} · {{ items.length }} 步 · {{ session.requests ?? 0 }} 个请求<template v-if="session.bodies">（{{ session.bodies }} 个带响应体）</template>
        </span>
        <span class="grow" />
        <button v-if="isRecording" class="button" type="button" data-testid="record-stop" @click="rec.stop()">停止</button>
        <button v-else class="button button-ghost" type="button" data-testid="record-resume" @click="rec.resume()">接着录</button>
      </header>

      <div class="rec-goal">
        <textarea v-if="!isRecording" v-model="editedGoal" class="filter-input rec-textarea" rows="2" placeholder="要教助手做什么（上传前可以改）" @blur="rec.setGoal(editedGoal)" />
        <p v-else>{{ session.goal || "（没写要做的事）" }}</p>
      </div>

      <div v-if="isRecording" class="rec-tools">
        <button class="button" type="button" data-testid="record-mark" @click="openMark">加标记</button>
        <button class="button button-ghost" type="button" title="把当前显示的标签页也加进这次录制" @click="addCurrentTab">也录当前标签页</button>
      </div>
      <p v-if="notice" class="basket-notice">{{ notice }}</p>

      <div v-if="marking && isRecording" class="rec-mark">
        <textarea v-model="note" class="filter-input rec-textarea" rows="2" placeholder="这里看的是……（例如：这里看的是可退金额，大于 0 才能开通）" data-testid="record-mark-note" />
        <div class="rec-mark-target">
          <span v-if="pointed" class="rec-pointed">指着：{{ pointed.role ? `${pointed.role} ` : "" }}「{{ pointed.label || pointed.text || pointed.tag }}」</span>
          <span v-else class="muted">{{ pointing ? "在页面上点一下要标记的元素，Esc 取消" : "没有指元素：标记记在整个页面上" }}</span>
          <span class="grow" />
          <button class="button button-ghost" type="button" :disabled="pointing" @click="rec.point()">{{ pointed ? "换一个" : "在页面上指出" }}</button>
        </div>
        <div class="composer-actions">
          <span class="grow" />
          <button class="button button-ghost" type="button" @click="cancelMark">取消</button>
          <button class="button button-primary" type="button" :disabled="!note.trim()" data-testid="record-mark-save" @click="saveMark">加上</button>
        </div>
      </div>

      <ol class="rec-steps" data-testid="record-steps">
        <li v-for="(item, index) in items" :key="item.step.id" class="rec-step" :class="`is-${item.step.action.kind}`">
          <span class="rec-step-no">{{ index + 1 }}</span>
          <div class="rec-step-body">
            <div class="rec-step-title"><b class="rec-kind">{{ kindLabel[item.step.action.kind] ?? item.step.action.kind }}</b><span :title="stepTitle(item.step)">{{ stepTitle(item.step) }}</span></div>
            <div class="rec-step-sub muted">
              {{ host(item.step.action.url) }} · {{ time(item.step.at) }}<template v-if="item.step.action.heading"> · {{ item.step.action.heading }}</template>
            </div>
            <p v-if="confirmRemove === item.step.id" class="record-confirm">再点一次 ✕ 删掉这一步</p>
          </div>
          <a v-if="item.thumbUrl" class="rec-step-thumb" :href="item.thumbUrl" target="_blank" rel="noreferrer" title="看截图"><img :src="item.thumbUrl" alt="" /></a>
          <button
            class="button button-ghost button-icon rec-step-delete"
            :class="{ 'button-danger': confirmRemove === item.step.id }"
            type="button"
            title="删掉这一步（试错、多余的操作）"
            aria-label="删掉这一步"
            @click="remove(item.step.id)"
          >
            ✕
          </button>
        </li>
        <li v-if="!items.length" class="rec-empty muted">{{ isRecording ? "在页面上操作，步骤会出现在这里。" : "没有记下任何一步。" }}</li>
      </ol>

      <footer v-if="!isRecording" class="composer rec-upload">
        <select v-if="targets.length" v-model="target" class="preset-select rec-target" title="整理的消息发到哪里" aria-label="接着哪件事">
          <option value="">新对话</option>
          <optgroup v-if="targets.some((t) => t.kind === 'context')" label="关注（发到它的对话）">
            <option v-for="t in targets.filter((x) => x.kind === 'context')" :key="t.id" :value="`context:${t.id}`">{{ t.name }}</option>
          </optgroup>
          <optgroup v-if="targets.some((t) => t.kind === 'item')" label="事项（消息里提到它）">
            <option v-for="t in targets.filter((x) => x.kind === 'item')" :key="t.id" :value="`item:${t.id}`">{{ t.name }}</option>
          </optgroup>
        </select>
        <div v-if="uploadState && uploadState.phase !== 'done'" class="send-result" :class="`is-${uploadState.phase}`" role="status">
          <template v-if="uploadState.phase === 'sending'">正在上传{{ uploadState.organize ? "并交给助手" : "" }}…</template>
          <template v-else>上传失败：{{ uploadState.message }}</template>
        </div>
        <div class="composer-actions">
          <button class="button button-ghost" :class="{ 'button-danger': confirmDiscard }" type="button" data-testid="record-discard" @click="discard">
            {{ confirmDiscard ? "确认放弃" : "放弃" }}
          </button>
          <span class="muted send-hint">{{ uploadHint }}</span>
          <span class="grow" />
          <button class="button" type="button" :disabled="!canUpload" title="存进 omem，之后可以在对话里让助手整理" data-testid="record-save" @click="upload(false)">只保存</button>
          <button class="button button-primary" type="button" :disabled="!canUpload" title="存进 omem 并交给助手，按技能 skill-from-recording 整理" data-testid="record-organize" @click="upload(true)">
            整理成技能
          </button>
        </div>
      </footer>
    </template>
  </section>
</template>
