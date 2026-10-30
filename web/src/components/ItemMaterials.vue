<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { del, get, post, type Source } from "../api";
import Icon from "./Icon.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { promptDialog } from "../lib/dialog";
import { openCitation, relTime, state, statusLabel, toast } from "../store";

/**
 * What an item is about (src/items/materials.ts): documents and chats, repositories with a branch,
 * spaces to compare against, conversations, and the delegations and reviews done for it. Reviews
 * and delegations started for the item read these; here they can be opened, added and removed.
 */
export type Material = {
  id: number;
  kind: "source" | "conversation" | "repo" | "space" | "run" | "req";
  ref: string;
  label: string;
  title: string;
  meta: { space?: string; branch?: string; base?: string; note?: string };
  readable: boolean;
  changed: boolean;
  missing: boolean;
  status: string | null;
  run?: { kind: string; status: string; verdict: string | null; summary: string | null; branchReview: boolean; createdAt: string };
};
const props = defineProps<{ itemId: string; materials: Material[] }>();
const emit = defineEmits<{ changed: [] }>();

const GROUPS: { kinds: Material["kind"][]; title: string }[] = [
  { kinds: ["req"], title: "需求点" },
  { kinds: ["run"], title: "评审与交办" },
  { kinds: ["source"], title: "文档与群聊" },
  { kinds: ["repo", "space"], title: "代码" },
  { kinds: ["conversation"], title: "会话" },
];
const groups = computed(() => GROUPS.map((g) => ({ ...g, list: props.materials.filter((m) => g.kinds.includes(m.kind)) })).filter((g) => g.list.length));
const VERDICT: Record<string, { text: string; cls: string }> = { approved: { text: "评审通过", cls: "ok" }, "changes-requested": { text: "要求修改", cls: "warn" }, "awaiting-plan": { text: "等你确认计划", cls: "accent" }, "awaiting-peer": { text: "等外部 Agent 评审", cls: "accent" }, "awaiting-peer-code": { text: "等外部 Agent 编码", cls: "accent" } };
const runBadge = (m: Material) => (m.run?.verdict && VERDICT[m.run.verdict]) || { text: statusLabel[m.run?.status ?? ""] ?? m.run?.status ?? "", cls: m.run?.status === "failed" ? "danger" : "" };
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

async function remove(m: Material) {
  try {
    await del(`/api/items/${props.itemId}/materials/${m.id}`);
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ---- adding --------------------------------------------------------------------------------
const adding = ref(false);
type AddKind = "source" | "req" | "repo" | "space" | "run";
const kind = ref<AddKind>("source");
const kindOptions = [{ value: "source" as const, label: "原件" }, { value: "req" as const, label: "需求点" }, { value: "repo" as const, label: "仓库分支" }, { value: "space" as const, label: "空间" }, { value: "run" as const, label: "运行" }];
// The req-splitter role reads the materials and writes the requirement tree (src/agents/req-split.ts).
const splitting = ref(false);
async function split() {
  const note = await promptDialog("拆需求点", { message: "AI 读这个事项的材料，把需求点和测试点写进业务空间的需求树，写完在需求页确认。可以补充要求（拆到多细、重点、哪些先不拆）。", placeholder: "可以不填", okText: "开始拆" });
  if (note === null) return;
  splitting.value = true;
  try {
    const r = await post<{ id: string }>(`/api/items/${props.itemId}/split-requirements`, { note: note.trim() || undefined });
    toast(`已开始拆需求点（运行 ${r.id}），完成后这里会出现需求点`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    splitting.value = false;
  }
}
const query = ref("");
const found = ref<Source[]>([]);
const reqHits = ref<{ id: string; spaceId: string; title: string }[]>([]);
let reqTimer: ReturnType<typeof setTimeout> | undefined;
watch([query, kind], ([v, k]) => {
  if (k !== "req") return;
  clearTimeout(reqTimer);
  if (!v.trim()) return void (reqHits.value = []);
  reqTimer = setTimeout(async () => {
    reqHits.value = (await get<{ hits: typeof reqHits.value }>(`/api/search?q=${encodeURIComponent(v.trim())}&space=*&types=requirement&limit=10`).catch(() => ({ hits: [] }))).hits;
  }, 250);
});
let timer: ReturnType<typeof setTimeout> | undefined;
watch(query, (q) => {
  clearTimeout(timer);
  if (kind.value !== "source" || q.trim().length < 2) return void (found.value = []);
  timer = setTimeout(async () => {
    found.value = (await get<{ sources: Source[] }>(`/api/sources?q=${encodeURIComponent(q.trim())}&limit=8`).catch(() => ({ sources: [] }))).sources;
  }, 250);
});
const repoOptions = computed(() => state.spaces.filter((s) => s.rootPath).map((s) => ({ value: s.id, label: s.name })));
const spaceOptions = computed(() => state.spaces.map((s) => ({ value: s.id, label: s.name })));
const repo = ref("");
const branch = ref("");
const branches = ref<{ value: string; label: string }[]>([]);
watch(repo, async (id) => {
  branch.value = "";
  branches.value = id ? (await get<{ branches: { name: string }[] }>(`/api/spaces/${encodeURIComponent(id)}/branches`).catch(() => ({ branches: [] }))).branches.map((b) => ({ value: b.name, label: b.name })) : [];
});
const space = ref("");
const runId = ref("");
const note = ref("");
async function add(ref: string, extra: { branch?: string } = {}) {
  try {
    await post(`/api/items/${props.itemId}/materials`, { materials: [{ kind: kind.value, ref, ...extra, note: note.value.trim() || undefined }] });
    query.value = "";
    found.value = [];
    note.value = "";
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
function addCurrent() {
  if (kind.value === "repo" && repo.value) void add(repo.value, { branch: branch.value || undefined });
  else if (kind.value === "space" && space.value) void add(space.value);
  else if (kind.value === "run" && runId.value.trim()) void add(runId.value.trim());
  else if (kind.value === "source" && /^(src:)?s\w{8,}/.test(query.value.trim())) void add(query.value.trim());
}
</script>

<template>
  <div class="materials">
    <div class="section-title row">材料<span class="spacer" /><button class="btn ghost sm" :disabled="splitting" title="AI 读这些材料，拆成需求树里的需求点和测试点" @click="split"><Icon name="target" :size="13" />拆需求点</button><button class="btn ghost sm" :aria-expanded="adding" @click="adding = !adding"><Icon name="plus" :size="13" />{{ adding ? "收起" : "添加" }}</button></div>
    <p v-if="!materials.length && !adding" class="muted small">把这件事的需求和技术文档、群聊、仓库和分支挂在这里；为它发起的评审和交办会读到这些材料，也会列在这里。也可以直接对助理说“把这几份文档和分支挂到这个事项上”。</p>

    <div v-if="adding" class="add card pad">
      <UiSegmented v-model="kind" size="sm" :options="kindOptions" aria-label="材料类型" />
      <template v-if="kind === 'source'">
        <input v-model="query" class="input sm" placeholder="按标题搜索原件，或粘贴 src:… 引用" aria-label="搜索原件" @keydown.enter="addCurrent" />
        <button v-for="s in found" :key="s.id" class="hit" @click="add(s.id)">
          <span class="ellipsis">{{ s.title }}</span><span class="muted small">{{ spaceName(s.spaceId) }} · {{ s.kind }}</span>
        </button>
      </template>
      <template v-else-if="kind === 'req'">
        <input v-model="query" class="input sm" placeholder="搜索需求点（连同它下面的全部一起挂上）" aria-label="搜索需求点" />
        <button v-for="h in reqHits" :key="h.id" class="hit" @click="add(h.id)">
          <span class="ellipsis">{{ h.title }}</span><span class="muted small">{{ spaceName(h.spaceId) }}</span>
        </button>
      </template>
      <div v-else-if="kind === 'repo'" class="row wrap">
        <UiSelect v-model="repo" size="sm" width="180px" :options="repoOptions" placeholder="代码仓库" aria-label="代码仓库" />
        <UiSelect v-model="branch" size="sm" width="220px" :options="branches" :search-at="1" placeholder="分支（可选）" aria-label="分支" />
      </div>
      <UiSelect v-else-if="kind === 'space'" v-model="space" size="sm" :options="spaceOptions" :search-at="8" placeholder="要对照或一起读的空间" aria-label="空间" />
      <input v-else v-model="runId" class="input sm mono" placeholder="运行 id，如 r0m…" aria-label="运行 id" @keydown.enter="addCurrent" />
      <input v-model="note" class="input sm" placeholder="说明（可选），如：只作参考，实际接口在前端 BFF" aria-label="说明" />
      <div v-if="kind !== 'req' && (kind !== 'source' || /^(src:)?s\w{8,}/.test(query.trim()))" class="row"><span class="spacer" /><button class="btn sm primary" @click="addCurrent">加上</button></div>
    </div>

    <div v-for="g in groups" :key="g.title" class="group">
      <div class="muted small gt">{{ g.title }}</div>
      <div v-for="m in g.list" :key="m.id" class="m">
        <div class="mrow">
          <router-link v-if="m.kind === 'run'" :to="`/runs/${m.ref}`" class="t ellipsis" :title="m.title">{{ m.title }}</router-link>
          <router-link v-else-if="m.kind === 'req'" :to="`/reqs/${m.ref}`" class="t ellipsis" :title="m.title">{{ m.title }}</router-link>
          <a v-else-if="m.kind === 'source' && m.readable && !m.missing" href="#" class="t ellipsis" :title="m.title" @click.prevent="openCitation({ kind: 'source', id: m.ref }, true)">{{ m.title }}</a>
          <router-link v-else-if="m.kind === 'conversation'" :to="`/ask/${m.ref}`" class="t ellipsis">{{ m.title }}</router-link>
          <span v-else class="t ellipsis" :title="m.title">{{ m.kind === "repo" ? `${spaceName(m.meta.space ?? m.ref)} · ${m.meta.branch ?? "当前检出"}` : m.title }}</span>
          <span v-if="m.run" class="badge" :class="runBadge(m).cls">{{ runBadge(m).text }}</span>
          <span v-if="m.missing" class="badge danger">已删除</span>
          <span v-else-if="!m.readable" class="badge">无权查看</span>
          <span v-else-if="m.changed" class="badge warn" title="加进来之后原件有更新，依据它的结论可能过期">有更新</span>
          <button class="btn ghost sm icon rm" :aria-label="`移除 ${m.title}`" title="移除" @click="remove(m)"><Icon name="x" :size="12" /></button>
        </div>
        <div v-if="m.run?.summary" class="muted small clamp">{{ m.run.summary }}</div>
        <div v-if="m.meta.note || m.run" class="muted small">{{ m.run ? `${m.run.branchReview ? "分支评审" : m.run.kind === "code" ? "交办编码" : m.run.kind} · ${relTime(m.run.createdAt)}` : "" }}{{ m.run && m.meta.note ? " · " : "" }}{{ m.meta.note }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.materials { display: grid; gap: 8px; }
.add { display: grid; gap: 8px; }
.hit { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; border: 0; background: none; padding: 4px 6px; border-radius: 6px; font: inherit; color: var(--ink); cursor: pointer; text-align: left; min-width: 0; }
.hit:hover { background: var(--hover); }
.group { display: grid; gap: 4px; }
.gt { margin-top: 4px; }
.m { display: grid; gap: 2px; padding: 4px 0; }
.mrow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.t { flex: 1; min-width: 0; }
.rm { opacity: 0; }
.m:hover .rm, .rm:focus-visible { opacity: 1; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
@media (hover: none) { .rm { opacity: 1; } }
</style>
