<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, post, type Run } from "../api";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { fmtTime, state, toast } from "../store";

/**
 * 交办编码任务 (编码 → 交办): hand a task to the coding Agent in fresh worktrees of the chosen
 * repositories (`POST /api/delegate`, with an optional sync first: src/agents/code-sync.ts), or have an
 * existing branch reviewed (`POST /api/review-branch`). Opens the new work when started.
 */
const emit = defineEmits<{ close: [] }>();
const router = useRouter();

type DelegateMode = "code" | "review";
const mode = ref<DelegateMode>("code");
const modeOptions = [
  { value: "code" as const, label: "实现" },
  { value: "review" as const, label: "评审分支" },
];
const emptyTask = () => ({ repos: [] as string[], task: "", check: "", branch: "", base: "", fromBranch: "", pull: false, onto: "", syncMode: "merge" as "merge" | "rebase", syncOnly: false });
const syncModeOptions = [{ value: "merge" as const, label: "合并" }, { value: "rebase" as const, label: "变基" }];
const task = ref(emptyTask());
const wantsSync = computed(() => task.value.pull || !!task.value.onto);
type BranchList = { current: string; base: string | null; branches: { name: string; commit: string; at: string; subject: string; remote: boolean }[] };
const branchList = ref<BranchList | null>(null);
const branchLoading = ref(false);
// Branches of the first chosen repository (repositories of one requirement usually share the branch name).
async function loadBranches(fetch = false) {
  const repo = task.value.repos[0];
  if (!repo) return void (branchList.value = null);
  branchLoading.value = true;
  try {
    branchList.value = await get<BranchList>(`/api/spaces/${encodeURIComponent(repo)}/branches${fetch ? "?fetch=1" : ""}`);
  } catch (e) {
    branchList.value = null;
    toast((e as Error).message, "error");
  } finally {
    branchLoading.value = false;
  }
}
const branchOptions = computed(() => (branchList.value?.branches ?? []).map((b) => ({ value: b.name, label: b.name, hint: `${fmtTime(b.at, false)} · ${b.subject}` })));
const baseOptions = computed(() => [{ value: "", label: `默认（${branchList.value?.base ?? "main"}）` }, ...branchOptions.value]);
const fromOptions = computed(() => [{ value: "", label: `当前检出（${branchList.value?.current ?? "HEAD"}）` }, ...branchOptions.value]);
const ontoOptions = computed(() => [{ value: "", label: "不合并别的分支" }, ...branchOptions.value]);
watch(() => task.value.repos[0], () => void loadBranches());

const repos = computed(() => state.spaces.filter((s) => s.rootPath));
const current = computed(() => state.spaces.find((s) => s.id === state.space));
// Start from the current repository, or the repositories related to the current project.
{
  const here = current.value;
  const ids = repos.value.map((r) => r.id);
  task.value.repos = here?.rootPath ? [here.id] : (here?.related ?? []).map((r) => r.space).filter((id) => ids.includes(id));
}

const busy = ref(false);
async function delegate() {
  busy.value = true;
  try {
    // A task started from a project belongs to the project; otherwise to its first repository.
    const space = current.value?.kind === "project" ? current.value.id : task.value.repos[0];
    const t = task.value;
    const r = mode.value === "review"
      ? await post<Run>("/api/review-branch", { space, repos: t.repos, branch: t.branch, base: t.base || undefined, task: t.task.trim() || undefined })
      : await post<Run>("/api/delegate", {
          space, repos: t.repos, checkCommand: t.check || undefined, fromBranch: t.fromBranch || undefined,
          task: t.task.trim() || (t.syncOnly ? `同步${t.pull ? "：拉取最新代码" : ""}${t.onto ? `，${t.syncMode === "merge" ? "合并" : "变基到"} ${t.onto}` : ""}` : t.task),
          ...(wantsSync.value ? { sync: { pull: t.pull || undefined, onto: t.onto || undefined, mode: t.syncMode }, syncOnly: t.syncOnly } : {}),
        });
    emit("close");
    void router.push(`/code/${r.id}`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
const ready = computed(() => !!task.value.repos.length && (mode.value === "review" ? !!task.value.branch : !!task.value.task.trim() || (wantsSync.value && task.value.syncOnly)));

// Esc closes it and the focus goes back to what opened it.
const box = ref<HTMLElement>();
let returnTo: HTMLElement | null = null;
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.defaultPrevented) emit("close");
}
onMounted(() => {
  returnTo = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKey);
  void nextTick(() => box.value?.focus());
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  returnTo?.focus?.();
});
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @mousedown.self="emit('close')">
      <div ref="box" class="modal stack" role="dialog" aria-modal="true" aria-label="交办编码任务" tabindex="-1">
        <div class="row"><strong>交办编码任务</strong><span class="spacer" /><UiSegmented v-model="mode" size="sm" aria-label="交办方式" :options="modeOptions" /><button class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" /></button></div>
        <p v-if="mode === 'code'" class="muted small">每个仓库各开一个独立的 Git worktree，由编码 Agent 一起实现，分别运行检查命令，再由评审 Agent 审查。确认后所有仓库一起应用。</p>
        <p v-else class="muted small">把已有的分支检出到独立工作区，取它从基线分叉以来的全部改动，按评审档位交给各评审项审查。只出评审意见，不改代码。</p>
        <div v-if="!repos.length" class="muted">还没有关联代码目录的空间，请先在设置里新建代码仓库空间。</div>
        <template v-else>
          <div class="field">
            <span>{{ mode === "review" ? "分支所在的仓库（可多选，分支名相同）" : "仓库（可多选，一起改）" }}</span>
            <div class="repo-picks">
              <UiCheckbox v-for="r in repos" :key="r.id" v-model="task.repos" :value="r.id" size="sm">{{ r.name }}</UiCheckbox>
            </div>
          </div>
          <div v-if="task.repos.length" class="branch-row">
            <template v-if="mode === 'review'">
              <div class="field grow"><span>要评审的分支</span><UiSelect v-model="task.branch" :options="branchOptions" :placeholder="branchLoading ? '读取分支…' : '选择分支'" :search-at="1" aria-label="要评审的分支" /></div>
              <div class="field grow"><span>对照的基线</span><UiSelect v-model="task.base" :options="baseOptions" :search-at="1" aria-label="基线分支" /></div>
            </template>
            <div v-else class="field grow"><span>从哪里开始改</span><UiSelect v-model="task.fromBranch" :options="fromOptions" :search-at="1" aria-label="起点分支" /></div>
            <button class="btn ghost sm" :disabled="branchLoading" title="从 origin 拉取全部分支" @click="loadBranches(true)"><Icon name="refresh" :size="13" />拉取</button>
          </div>
          <!-- Git work before coding (src/agents/code-sync.ts): conflicts go to the coding Agent, then to the owner. -->
          <div v-if="mode === 'code' && task.repos.length" class="field sync">
            <span>编码前先同步（可选）</span>
            <div class="row wrap">
              <UiCheckbox v-model="task.pull" size="sm">拉取目标分支在 origin 上的新提交</UiCheckbox>
            </div>
            <div class="row wrap">
              <UiSelect v-model="task.onto" :options="ontoOptions" :search-at="1" width="220px" size="sm" aria-label="再合并或变基到的分支" />
              <UiSegmented v-if="task.onto" v-model="task.syncMode" size="sm" :options="syncModeOptions" aria-label="合并还是变基" />
              <UiCheckbox v-if="wantsSync" v-model="task.syncOnly" size="sm">只同步，不再编码</UiCheckbox>
            </div>
            <span v-if="wantsSync" class="hint">冲突先交给编码 Agent 解决，拿不准的会问你，解决不了的停下来给你；同步的提交在应用时快进到目标分支，之后可以在“接收位置与提交”里推送（变基过的要强制推送）。</span>
          </div>
          <label class="field"><span>{{ mode === "review" ? "需求说明和评审要求（可选）" : "任务" }}</span><textarea v-model="task.task" class="textarea" rows="6" :placeholder="mode === 'review' ? '需求要解决什么、验收标准、相关文档或讨论、特别关心的点' : '目标、背景、验收标准、相关讨论'" /></label>
          <label v-if="mode === 'code'" class="field"><span>检查命令（可选，默认用空间设置）</span><input v-model="task.check" class="input mono" placeholder="pnpm test" /></label>
          <div class="row"><span class="spacer" /><button class="btn primary" :disabled="!ready || busy" @click="delegate">{{ mode === "review" ? "开始评审" : "交办" }}</button></div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sync .row { gap: 10px; align-items: center; }
.branch-row {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.branch-row .grow {
  flex: 1 1 200px;
  min-width: 0;
}
.repo-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  max-height: 160px;
  overflow: auto;
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 55;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 10vh;
}
.modal {
  width: min(620px, calc(100vw - 24px));
  max-height: 86vh;
  overflow-y: auto;
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 18px;
  outline: none;
}
</style>
