<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get, post } from "../api";
import { confirmDialog } from "../lib/dialog";
import { fmtTime } from "../store";
import Skeleton from "./Skeleton.vue";
import VirtualList from "./VirtualList.vue";
import DiffFile from "./DiffFile.vue";

const props = defineProps<{ runId: string; space: string }>();
type Action = "commit" | "commit_push" | "push";
type Operation = { id: string; at: string; action: Action; head: string; committed: string | null; pushed: boolean; ok: boolean; error?: string };
type GitStatus = {
  branch: string; head: string; state: string; remote: string | null; pushUnavailable: string | null;
  staged: number; unstaged: number; ahead: number | null; behind: number | null;
  files: { path: string; index: string; worktree: string }[];
  stagedDiff: string; diffTruncated: boolean; blockedReason: string | null; operations: Operation[];
};
const status = ref<GitStatus | null>(null);
const loading = ref(false);
const busy = ref(false);
const message = ref("");
const error = ref("");
const result = ref<Operation | null>(null);
const diffFiles = computed(() => (status.value?.stagedDiff ?? "").split(/^diff --git /m).filter(Boolean).map(chunk => {
  const lines = chunk.split("\n").slice(1);
  return { name: chunk.split("\n")[0], lines, text: lines.some(line => line.startsWith("@@ ")) };
}));
let generation = 0;
async function refresh() {
  const request = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const data = await get<GitStatus>(`/api/runs/${props.runId}/git?space=${encodeURIComponent(props.space)}`);
    if (request === generation) status.value = data;
  } catch (e) {
    if (request === generation) { status.value = null; error.value = (e as Error).message; }
  } finally { if (request === generation) loading.value = false; }
}
watch(() => [props.runId, props.space], () => { status.value = null; message.value = ""; result.value = null; void refresh(); }, { immediate: true });
const labels: Record<Action, string> = { commit: "提交", commit_push: "提交并推送", push: "仅推送已有提交" };
async function act(action: Action) {
  if (!status.value || busy.value) return;
  const runId = props.runId, space = props.space, snapshot = status.value, commitMessage = message.value.trim();
  busy.value = true;
  try {
    const text = `${space} · ${snapshot.branch}\n${action === "push" ? `推送当前提交 ${snapshot.head.slice(0, 10)}` : `提交 ${snapshot.staged} 个已暂存文件\n提交信息：${commitMessage}`}${action !== "commit" ? `\n推送到 origin/${snapshot.branch}，包含该分支尚未推送的提交。` : ""}${snapshot.unstaged ? `\n${snapshot.unstaged} 个未暂存文件的修改不包含在本次提交中。` : ""}`;
    if (!(await confirmDialog(`${labels[action]}？`, { message: text, okText: labels[action] }))) return;
    result.value = null;
    const response = await post<Operation>(`/api/runs/${runId}/git`, { space, action, message: commitMessage, expected_state: snapshot.state });
    if (runId !== props.runId || space !== props.space) return;
    result.value = response;
    if (response.committed) message.value = "";
    await refresh();
  } catch (e) { if (runId === props.runId && space === props.space) error.value = (e as Error).message; }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="git-panel stack" aria-label="提交与推送">
    <div class="row wrap">
      <strong>提交与推送</strong>
      <button class="btn ghost sm" :disabled="busy || loading" @click="refresh">刷新状态</button>
    </div>
    <Skeleton v-if="loading && !status" :rows="3" variant="lines" />
    <p v-if="error" class="git-error" role="alert">{{ error }}</p>
    <p v-if="result" :class="{ 'git-error': !result.ok }" role="status">
      <template v-if="result.committed">本地提交 {{ result.committed.slice(0, 10) }} 已完成。 </template>
      <template v-if="result.pushed">已推送到 origin/{{ status?.branch }}。</template>
      <template v-else-if="result.ok">尚未推送。</template>
      <template v-if="result.error">{{ result.error }}</template>
    </p>
    <template v-if="status">
      <p class="muted">当前提交 <code>{{ status.head.slice(0, 10) }}</code> · 已暂存 {{ status.staged }} 个文件 · 未暂存 {{ status.unstaged }} 个文件</p>
      <p v-if="status.ahead !== null" class="muted">相对本地远端记录：领先 {{ status.ahead }}、落后 {{ status.behind }} 个提交。未自动拉取远端。</p>
      <p v-if="status.blockedReason" class="git-error">{{ status.blockedReason }}</p>
      <details v-if="status.files.length">
        <summary>查看文件与已暂存差异</summary>
        <p class="muted">文件前两列分别表示暂存区与工作区状态；提交仅包含已暂存内容。</p>
        <div class="git-files">
          <VirtualList :items="status.files" :item-key="item => item.path" :estimate="32">
            <template #default="{ item }"><div class="git-file"><code>{{ item.index }}{{ item.worktree }}</code><span>{{ item.path }}</span></div></template>
          </VirtualList>
        </div>
        <div v-if="diffFiles.length" class="git-diff">
          <VirtualList :items="diffFiles" :item-key="item => item.name" :estimate="150">
            <template #default="{ item }">
              <p class="git-filename">{{ item.name }}</p>
              <DiffFile v-if="item.text" :key="`${status.state}:${item.name}`" :run-id="runId" :space="space" :lines="item.lines" :expandable="false" />
              <p v-else class="muted">文件属性、重命名或二进制变化，请在接收目录检查。</p>
            </template>
          </VirtualList>
        </div>
        <p v-if="status.diffTruncated" class="muted">差异较长，仅显示前 24,000 字符；完整内容可在接收目录用 git diff --cached 查看。</p>
      </details>
      <label class="field"><span>提交信息</span><textarea v-model="message" class="textarea" rows="3" maxlength="10000" :disabled="busy" placeholder="说明这次改动做了什么" /></label>
      <p class="muted">仅提交暂存区。你后来未暂存的修改会保留；需要一起提交时，请先在接收目录暂存，再刷新检查。</p>
      <div class="row wrap">
        <button class="btn primary sm" :disabled="busy || loading || !!status.blockedReason || !status.staged || !message.trim()" @click="act('commit')">提交</button>
        <button class="btn sm" :disabled="busy || loading || !!status.blockedReason || !status.staged || !message.trim() || !status.remote" @click="act('commit_push')">提交并推送</button>
        <button class="btn sm" :disabled="busy || loading || !!status.blockedReason || !status.remote" @click="act('push')">仅推送已有提交</button>
        <span v-if="busy" role="status" class="muted">正在处理…</span>
      </div>
      <p v-if="status.pushUnavailable" class="muted">{{ status.pushUnavailable }}</p>
      <details v-if="status.operations.length">
        <summary>最近操作</summary>
        <div v-for="op in [...status.operations].reverse()" :key="op.id" class="git-operation">
          {{ fmtTime(op.at) }} · {{ labels[op.action] }} · {{ op.ok ? '成功' : '未完成' }}
          <span v-if="op.committed"> · 提交 {{ op.committed.slice(0, 10) }}</span>
          <span v-if="op.pushed"> · 已推送</span>
          <p v-if="op.error" class="git-error">{{ op.error }}</p>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.git-panel { min-width: 0; border-top: 1px solid var(--line); padding-top: 12px; }
.git-panel p, .git-operation { overflow-wrap: anywhere; }
.git-panel textarea { width: 100%; box-sizing: border-box; }
.git-error { color: var(--danger); }
.git-files { max-height: 240px; overflow: auto; margin-block: 8px; }
.git-file { display: flex; align-items: baseline; gap: 10px; padding: 3px 0; }
.git-file code { white-space: pre; flex-shrink: 0; }
.git-file span { overflow-wrap: anywhere; min-width: 0; }
.git-diff { max-height: 320px; overflow: auto; font-size: 12px; }
.git-filename { margin-block: 8px; overflow-wrap: anywhere; }
.git-operation { margin-top: 8px; }
</style>
