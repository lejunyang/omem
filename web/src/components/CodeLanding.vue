<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get, post, type Run } from "../api";
import { toast } from "../store";
import CodeBranchPanel from "./CodeBranchPanel.vue";
import CodeGitPanel from "./CodeGitPanel.vue";

/**
 * Where a delegation's finished round lands, shared by the run page and the requirements page:
 * a sync stopped on conflicts (the same decision as the Feishu card), a work branch's commits and
 * confirming (pushing) it, and for an older delegation applied as a patch, where the change landed
 * and committing / pushing it there.
 */
export type ApplyTarget = { space: string; path: string; branch: string | null };
const props = defineProps<{ run: Run; branchWork: boolean; spaceName: (id: string) => string }>();
const emit = defineEmits<{ changed: []; synced: [id: string] }>();

const out = computed(() => (props.run.output ?? {}) as { verdict?: string; reviewAskId?: unknown; appliedAt?: string; discardedAt?: string; appliedTo?: ApplyTarget[] });
const busy = computed(() => ["queued", "running"].includes(props.run.status));

const syncAsk = ref<{ id: string; status: string; question: string } | null>(null);
watch(() => [props.run.id, out.value.verdict, out.value.reviewAskId] as const, async ([, verdict, askId]) => {
  syncAsk.value = null;
  if (verdict !== "sync-conflict" || typeof askId !== "string") return;
  try {
    const a = await get<{ id: string; status: string; question: string }>(`/api/asks/${askId}`);
    syncAsk.value = a.status === "pending" ? a : null;
  } catch { /* gone */ }
}, { immediate: true });
async function answerSync(choice: number) {
  if (!syncAsk.value) return;
  try {
    await post(`/api/asks/${syncAsk.value.id}/answer`, { choice });
    toast(choice === 0 ? "已安排继续同步" : "已放弃这次同步", "ok");
    syncAsk.value = null;
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function copyApplyPath(path: string) {
  try { await navigator.clipboard.writeText(path); toast("已复制接收目录", "ok"); }
  catch { toast("复制失败，请选中目录文字复制", "error"); }
}
</script>

<template>
  <template v-if="run.kind === 'code'">
    <section v-if="syncAsk" class="card pad block sync-stop" role="alert">
      <div class="section-title">Git 同步停在冲突上</div>
      <p class="pre small">{{ syncAsk.question }}</p>
      <div class="row wrap"><button class="btn primary sm" @click="answerSync(0)">已解决，继续</button><button class="btn sm" @click="answerSync(1)">放弃这次同步</button></div>
    </section>
    <!-- A work branch: its commits, where it is checked out, and confirming (pushing) it. -->
    <CodeBranchPanel v-if="branchWork && !out.discardedAt" :run-id="run.id" :title="run.title" :busy="busy" :confirmed-at="out.appliedAt ?? null" :space-name="spaceName" @changed="emit('changed')" @synced="(id) => emit('synced', id)" />
    <!-- After apply (an older delegation): where the change landed, and committing / pushing it there. -->
    <section v-if="out.appliedTo?.length && !branchWork" class="card pad block apply-targets">
      <div class="section-title">接收位置与提交</div>
      <div v-for="t in out.appliedTo" :key="t.space" class="target">
        <div class="row wrap small">
          <strong>{{ spaceName(t.space) }}</strong>
          <span class="badge">{{ t.branch ?? "指定版本" }}</span>
          <code class="grow">{{ t.path }}</code>
          <button class="btn ghost sm" @click="copyApplyPath(t.path)">复制目录</button>
        </div>
        <CodeGitPanel :key="`${run.id}:${t.space}`" :run-id="run.id" :space="t.space" />
      </div>
    </section>
  </template>
</template>

<style scoped>
.apply-targets { display: grid; gap: 12px; }
.sync-stop { border-color: var(--warn); display: grid; gap: 8px; }
.sync-stop p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.apply-targets .section-title { margin: 0; }
.apply-targets .target { display: grid; gap: 10px; min-width: 0; }
.apply-targets code { overflow-wrap: anywhere; white-space: normal; min-width: 0; }
.apply-targets .grow { flex: 1; }
</style>
