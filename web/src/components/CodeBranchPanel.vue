<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get, post } from "../api";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { fmtTime, relTime, toast } from "../store";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";

// A delegation's work branches (src/agents/code-branch.ts): the commits each round made, where the
// branch is checked out, and the one decision left to the owner: confirm, which pushes.
const props = defineProps<{ runId: string; title: string; busy: boolean; confirmedAt?: string | null; spaceName: (id: string) => string }>();
const emit = defineEmits<{ changed: []; synced: [id: string] }>();

type Commit = { hash: string; author: string; at: string; subject: string };
type Branch = {
  space: string; branch: string; exists: boolean; cutFrom: string | null; newBranch: boolean; commits: Commit[]; stat: string;
  root: string; mainBranch: string | null; checkedOut: string | null; inMain: boolean; workspace: string | null;
  remote: boolean; pushed: boolean; ahead: number | null; behind: number | null; pushedAt: string | null;
};
const list = ref<Branch[] | null>(null);
const loading = ref(false);
const working = ref(false);
const squash = ref(false);
const message = ref("");
const force = ref(false);
const syncFor = ref<string | null>(null);
const onto = ref("");
const mode = ref<"merge" | "rebase">("merge");
const multi = computed(() => (list.value?.length ?? 0) > 1);
const diverged = computed(() => !!list.value?.some((b) => (b.behind ?? 0) > 0));
const locked = computed(() => props.busy || working.value || !!props.confirmedAt);

async function load() {
  loading.value = true;
  try {
    list.value = await get<Branch[]>(`/api/runs/${props.runId}/branch`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    loading.value = false;
  }
}
watch(() => [props.runId, props.busy, props.confirmedAt], load, { immediate: true });
watch(() => props.title, (t) => { if (!message.value) message.value = t; }, { immediate: true });

async function act(body: Record<string, unknown>, done: string) {
  working.value = true;
  try {
    await post(`/api/runs/${props.runId}/branch`, body);
    toast(done, "ok");
    await load();
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    working.value = false;
  }
}
async function rename(b: Branch) {
  const name = await promptDialog("分支改名", { value: b.branch, placeholder: "如 feat/refund-shipped", okText: "改名" });
  if (name && name.trim() !== b.branch) await act({ space: b.space, action: "rename", name: name.trim() }, `已改名为 ${name.trim()}`);
}
async function checkout(b: Branch) {
  const ok = await confirmDialog(`在仓库目录检出 ${b.branch}？`, { message: `${b.root} 现在在 ${b.mainBranch ?? "游离 HEAD"} 上，要没有未提交的改动。检出后每轮的提交会自动快进到那里，可以直接在那里启动服务验证。`, okText: "检出" });
  if (ok) await act({ space: b.space, action: "checkout" }, `仓库目录已切到 ${b.branch}`);
}
async function squashNow(b: Branch) {
  const msg = await promptDialog(`把 ${b.branch} 的 ${b.commits.length} 个提交压缩成一个`, { value: message.value || props.title, okText: "压缩" });
  if (msg?.trim()) await act({ space: b.space, action: "squash", message: msg.trim() }, "已压缩成一个提交");
}
async function sync() {
  if (!onto.value.trim()) return;
  working.value = true;
  try {
    const r = await post<{ id: string }>(`/api/runs/${props.runId}/sync`, { onto: onto.value.trim(), mode: mode.value });
    toast(`已排一轮${mode.value === "merge" ? "合并" : "变基"}，冲突先交给编码 Agent`, "ok");
    syncFor.value = null;
    emit("synced", r.id);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    working.value = false;
  }
}
async function confirmRun() {
  const lines = (list.value ?? []).map((b) => `${multi.value ? `${props.spaceName(b.space)}：` : ""}${b.branch}（${b.commits.length} 个提交${squash.value && b.commits.length > 1 ? "，压缩成一个" : ""}）→ ${b.remote ? `origin/${b.branch}` : "没有 origin，只在本地"}`);
  const ok = await confirmDialog("确认并推送？", { message: `${lines.join("\n")}${force.value ? "\n\n远端有本地没有的提交，会按上次拉取的状态覆盖。" : ""}\n\n确认后归还工作区，分支保留。`, okText: "确认并推送" });
  if (!ok) return;
  working.value = true;
  try {
    const r = await post<{ pushed: { branch: string }[]; notes: string[] }>(`/api/runs/${props.runId}/apply`, { ...(squash.value && message.value.trim() ? { squash: message.value.trim() } : {}), ...(force.value ? { force: true } : {}) });
    toast(r.pushed.length ? `已推送 ${r.pushed.map((p) => p.branch).join("、")}` : r.notes.join("；") || "已确认", "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    working.value = false;
  }
}
const pushState = (b: Branch) => !b.remote ? "没有 origin" : !b.pushed ? "未推送" : b.ahead || b.behind ? `领先 ${b.ahead ?? 0} · 落后 ${b.behind ?? 0}` : "已推送";
</script>

<template>
  <section class="card pad block branch-panel" aria-label="工作分支">
    <div class="row wrap head">
      <div class="section-title">工作分支</div>
      <span v-if="confirmedAt" class="badge ok">已确认 {{ fmtTime(confirmedAt) }}</span>
      <span v-else-if="busy" class="muted small">这一轮结束后可以操作分支</span>
      <button class="btn ghost sm" :disabled="loading" @click="load">刷新</button>
    </div>
    <Skeleton v-if="loading && !list" :rows="3" variant="lines" />
    <div v-for="b in list ?? []" :key="b.space" class="repo stack">
      <div class="row wrap name">
        <strong v-if="multi">{{ spaceName(b.space) }}</strong>
        <code class="branch">{{ b.branch }}</code>
        <button v-if="!locked" class="btn ghost sm" @click="rename(b)">改名</button>
        <span class="badge" :class="{ ok: b.pushed && !b.ahead && !b.behind }">{{ pushState(b) }}</span>
        <span class="muted small">{{ b.newBranch ? `从 ${b.cutFrom ?? "提交"} 切出` : "已有分支" }} · {{ b.commits.length }} 个提交{{ b.stat ? ` · ${b.stat}` : "" }}</span>
      </div>
      <p v-if="!b.exists" class="err small">分支已经不在了。</p>
      <ol v-if="b.commits.length" class="commits">
        <li v-for="c in b.commits" :key="c.hash"><code>{{ c.hash.slice(0, 8) }}</code><span class="subject">{{ c.subject }}</span><span class="muted small">{{ relTime(c.at) }}</span></li>
      </ol>
      <p class="small where">
        <template v-if="b.inMain">仓库目录 <code>{{ b.root }}</code> 在这条分支上，每轮结束后自动快进到最新提交，可以直接在那里启动服务验证。</template>
        <template v-else-if="b.checkedOut">在 <code>{{ b.checkedOut }}</code> 检出，每轮结束后自动快进。</template>
        <template v-else>仓库目录 <code>{{ b.root }}</code> 现在在 {{ b.mainBranch ?? "游离 HEAD" }} 上。</template>
      </p>
      <div v-if="!locked" class="row wrap">
        <button v-if="!b.checkedOut" class="btn sm" @click="checkout(b)">在仓库目录检出</button>
        <button v-if="b.commits.length > 1" class="btn sm" @click="squashNow(b)">压缩成一个提交</button>
        <button class="btn sm" @click="syncFor = syncFor === b.space ? null : b.space">合并 / 变基…</button>
      </div>
      <div v-if="syncFor === b.space && !locked" class="row wrap sync">
        <UiSegmented v-model="mode" size="sm" :options="[{ value: 'merge', label: '合并进来' }, { value: 'rebase', label: '变基到' }]" aria-label="合并或变基" />
        <input v-model="onto" class="input sm mono grow" placeholder="分支，如 main、origin/main" aria-label="要合并或变基到的分支" @keydown.enter="sync" />
        <button class="btn sm primary" :disabled="!onto.trim()" @click="sync">开始</button>
      </div>
    </div>
    <div v-if="list?.length && !confirmedAt" class="confirm stack">
      <div class="row wrap">
        <UiCheckbox v-model="squash" size="sm" :disabled="locked">压缩成一个提交</UiCheckbox>
        <UiCheckbox v-if="diverged" v-model="force" size="sm" :disabled="locked" title="远端分支有本地没有的提交时：按上次拉取的状态覆盖">覆盖远端</UiCheckbox>
      </div>
      <input v-if="squash" v-model="message" class="input sm" maxlength="10000" :disabled="locked" placeholder="压缩后的提交信息" aria-label="压缩后的提交信息" />
      <div class="row">
        <button class="btn primary sm" :disabled="locked || (squash && !message.trim())" @click="confirmRun">确认并推送</button>
        <span class="muted small">推到 origin 的同名分支，归还工作区；分支保留。</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.branch-panel { display: grid; gap: 14px; min-width: 0; }
.head { align-items: center; gap: 10px; }
.head .section-title { margin: 0; flex: 1; }
.repo { gap: 8px; min-width: 0; }
.repo + .repo { border-top: 1px solid var(--line); padding-top: 12px; }
.name { align-items: center; gap: 8px; }
.branch { font-size: 14px; overflow-wrap: anywhere; }
.commits { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; max-height: 220px; overflow: auto; }
.commits li { display: flex; gap: 10px; align-items: baseline; min-width: 0; font-size: 13px; }
.commits code { flex-shrink: 0; color: var(--muted); }
.commits .subject { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.commits .small { flex-shrink: 0; }
.where { margin: 0; overflow-wrap: anywhere; color: var(--muted); }
.where code { overflow-wrap: anywhere; white-space: normal; }
.sync { align-items: center; gap: 8px; }
.sync .grow { flex: 1; min-width: 160px; }
.confirm { gap: 8px; border-top: 1px solid var(--line); padding-top: 12px; }
.err { color: var(--danger); margin: 0; }
</style>
