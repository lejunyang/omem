<script setup lang="ts">
/**
 * A repository space's code index (docs/v2/code-index.md): read from a baseline commit or from the
 * directory, which work branches it keeps indexed next to the baseline, where the index is now, and
 * “立即同步”. Saves on its own (PUT /api/spaces/:id/code-index); `config` hands the new setting back
 * so the settings form around it does not save an older one.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { get, onServerEvent, post, put } from "../api";
import { promptDialog } from "../lib/dialog";
import type { CodeIndexState } from "../lib/code-index";
import { fmtTime, relTime, toast } from "../store";
import Icon from "./Icon.vue";
import UiSegmented from "./UiSegmented.vue";

type Config = { mode?: "baseline" | "directory"; ref?: string; branches?: string[] };
type Overlay = { space: string; branch: string; commit: string | null; committedAt: string | null; usedAt: string | null; baseRef: string | null; followed: boolean };
type View = { space: string; git: boolean; origin: boolean; mode: "baseline" | "directory"; config: Config; defaultRef: string | null; state: CodeIndexState | null; lastSync: string | null; version: string | null; overlays: Overlay[]; syncing: boolean };

const props = defineProps<{ spaceId: string }>();
const emit = defineEmits<{ config: [value: Config] }>();

const view = ref<View | null>(null);
const refInput = ref("");
const newBranch = ref("");
const busy = ref(false);
let seq = 0;

async function load() {
  const mine = ++seq;
  const v = await get<View>(`/api/spaces/${props.spaceId}/code-index`).catch(() => null);
  if (mine !== seq) return;
  view.value = v;
  refInput.value = v?.config.ref ?? "";
}
onMounted(load);
watch(() => props.spaceId, () => {
  view.value = null;
  void load();
});
// A sync finishing (or a branch index refreshed) changes the space: read the state again.
let timer: ReturnType<typeof setTimeout> | undefined;
const off = onServerEvent((e) => {
  if (e.type !== "changed" || e.entity !== "space" || e.id !== props.spaceId) return;
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 600);
});
onBeforeUnmount(() => { ++seq; off(); clearTimeout(timer); });

async function save(patch: Config) {
  busy.value = true;
  try {
    const v = await put<View>(`/api/spaces/${props.spaceId}/code-index`, patch);
    view.value = v;
    refInput.value = v.config.ref ?? "";
    emit("config", v.config);
    toast("已保存", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}

const mode = computed(() => view.value?.mode ?? "directory");
const setMode = (m: "baseline" | "directory") => void save({ mode: m });
function saveRef() {
  if (!view.value || refInput.value.trim() === (view.value.config.ref ?? "")) return;
  void save({ ref: refInput.value.trim() });
}
function addBranch() {
  const b = newBranch.value.trim();
  if (!b || !view.value) return;
  newBranch.value = "";
  void save({ branches: [...new Set([...(view.value.config.branches ?? []), b])] });
}
const removeBranch = (b: string) => view.value && void save({ branches: (view.value.config.branches ?? []).filter((x) => x !== b) });

async function syncNow() {
  busy.value = true;
  try {
    const v = await post<View & { report: { synced: boolean; reason: string; error?: string } | null }>(`/api/spaces/${props.spaceId}/code-index/refresh`);
    view.value = v;
    toast(v.report?.error ? v.report.error : v.report?.synced ? "已拉取，正在重读变了的文件" : `已拉取：${v.report?.reason ?? "没有变化"}`, v.report?.error ? "error" : "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}

async function hookToken() {
  try {
    const { token } = await post<{ token: string }>("/api/code-index/hook");
    await promptDialog("代码变更通知的令牌", {
      message: `只显示这一次，之前的令牌随之失效。仓库有推送时让代码平台调用：\nPOST ${location.origin}/api/code-index/notify\nAuthorization: Bearer <令牌>\n内容 {"repo": "<仓库地址>", "branch": "<分支>"} 或 {"space": "${props.spaceId}"}。它只能触发拉取，不能读任何内容。`,
      value: token,
      okText: "关闭",
    });
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

const short = (c?: string | null) => (c ? c.slice(0, 8) : "?");
</script>

<template>
  <div class="field code-index">
    <span>代码索引</span>
    <template v-if="view && view.git">
      <UiSegmented
        :model-value="mode"
        size="sm"
        aria-label="代码索引的来源"
        :options="[{ value: 'baseline', label: '按基线分支' }, { value: 'directory', label: '按目录现状' }]"
        @change="setMode"
      />
      <span class="hint">{{ mode === "baseline" ? "从基线分支的提交里读文件，不管目录里检出了哪个分支、有没有未提交的改动；助手默认只查基线。" : "读目录里现在的样子：检出的分支、未提交的改动都会进索引。目录停在功能分支上时，助手会把它当成仓库的代码。" }}</span>
      <label v-if="mode === 'baseline'" class="row fit">
        <span class="small muted nowrap">基线分支</span>
        <input v-model="refInput" class="input mono grow" :placeholder="view.defaultRef ? `留空用远端默认分支（${view.defaultRef}）` : '分支、标签或提交'" :disabled="busy" @blur="saveRef" @keydown.enter.prevent="saveRef" />
      </label>
      <div class="small stack tight">
        <div v-if="view.version" class="muted">现在：{{ view.version }}</div>
        <div v-else class="muted">还没同步过。</div>
        <div v-if="view.state?.subject" class="muted ellipsis" :title="view.state.subject">提交说明：{{ view.state.subject }}</div>
        <div v-if="view.state?.fetchedAt" class="muted">上次拉取远端：{{ relTime(view.state.fetchedAt) }}（{{ fmtTime(view.state.fetchedAt, true) }}）</div>
        <div v-else-if="!view.origin" class="muted">没有 origin，不拉取远端。</div>
        <div v-if="view.state?.error" class="err">上次出错（{{ relTime(view.state.errorAt) }}）：{{ view.state.error }}</div>
      </div>
      <div class="row wrap">
        <button class="btn sm" :disabled="busy || view.syncing" @click="syncNow"><Icon name="refresh" :size="14" />{{ view.syncing ? "同步中" : "立即同步" }}</button>
        <button class="btn ghost sm" @click="hookToken">变更通知令牌…</button>
      </div>
      <span class="small muted">跟的分支（和基线一起每小时刷新，问到这些分支时直接可查）</span>
      <div v-for="b in view.config.branches ?? []" :key="b" class="row branch">
        <span class="mono small grow ellipsis" :title="b">{{ b }}</span>
        <span v-if="view.state?.branchErrors?.[b]" class="small err ellipsis" :title="view.state.branchErrors[b]">没能建索引</span>
        <button class="btn ghost sm icon" :aria-label="`不再跟 ${b}`" @click="removeBranch(b)"><Icon name="x" :size="14" /></button>
      </div>
      <div class="row">
        <input v-model="newBranch" class="input mono grow" placeholder="分支名，如 feat/refund 或 release/1.2" aria-label="添加要跟的分支" :disabled="busy" @keydown.enter.prevent="addBranch" />
        <button class="btn sm" :disabled="!newBranch.trim() || busy" @click="addBranch">添加</button>
      </div>
      <div v-if="view.overlays.some((o) => !o.followed)" class="small muted stack tight">
        <span>临时的分支索引（查过或评审过的分支，不用就自动清掉）：</span>
        <span v-for="o in view.overlays.filter((x) => !x.followed)" :key="o.space" class="mono ellipsis" :title="o.branch">{{ o.branch }} @ {{ short(o.commit) }}{{ o.usedAt ? ` · ${relTime(o.usedAt)}用过` : "" }}</span>
      </div>
    </template>
    <span v-else-if="view" class="hint">这个目录不是 Git 仓库：按目录现状索引。</span>
    <span v-else class="hint">读取中…</span>
  </div>
</template>

<style scoped>
.code-index .tight {
  gap: 2px;
}
.code-index .err {
  color: var(--danger);
}
.code-index .branch {
  min-width: 0;
}
.code-index .nowrap {
  white-space: nowrap;
}
.code-index .ellipsis {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
