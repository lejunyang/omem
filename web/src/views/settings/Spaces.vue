<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { del, get, patch, post, put, type Space, type SpaceRelation } from "../../api";
import { kindLabel, loadSpaces, state, toast } from "../../store";
import { nestedSpaces } from "../../lib/spaces";
import { confirmDialog, promptDialog } from "../../lib/dialog";
import { codeIndexLabel } from "../../lib/code-index";
import CodeIndexPanel from "../../components/CodeIndexPanel.vue";
import HelpText from "../../components/HelpText.vue";
import Icon from "../../components/Icon.vue";
import MonoLine from "../../components/MonoLine.vue";
import RepoLessons from "../../components/RepoLessons.vue";
import UiCheckbox from "../../components/UiCheckbox.vue";
import UiSelect from "../../components/UiSelect.vue";

/**
 * 设置 → 知识 → 空间: the spaces on the left (business spaces with their repositories under them, then
 * standalone repositories; members' personal spaces folded), the chosen one's settings on the right.
 * ＋ opens a new space in the same place. `?space=<id>` opens one (from pages that need one of its settings).
 */
const route = useRoute();

// ---- the list ----
const filter = ref("");
const showPersonal = ref(false);
const filtering = computed(() => !!filter.value.trim());
const matches = (s: Space) => !filtering.value || `${s.name} ${s.description} ${s.rootPath ?? ""}`.toLowerCase().includes(filter.value.trim().toLowerCase());
const reposOf = (id: string) => state.spaces.filter((c) => c.parentId === id);
/** Business spaces whose repositories are shown; kept in this browser. The chosen one's group opens by itself. */
const OPEN_KEY = "omem.settings.spaces.open";
const expanded = ref(new Set<string>((() => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]; } catch { return []; } })()));
function toggle(id: string) {
  const next = new Set(expanded.value);
  if (!next.delete(id)) next.add(id);
  expanded.value = next;
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch { /* private window */ }
}
const isOpen = (id: string) => filtering.value || expanded.value.has(id);
/**
 * One row per space: business spaces, their repositories under them (folded unless opened), then repositories of no
 * business. Filtering keeps a business space when it or one of its repositories matches.
 */
const listed = computed(() => {
  const rows: { space: Space; child: boolean; repos: number; standaloneHead?: boolean }[] = [];
  let standalone = false;
  for (const { space: s, child } of nestedSpaces(state.spaces.filter((x) => x.kind !== "personal"))) {
    if (child) {
      const parent = state.spaces.find((p) => p.id === s.parentId);
      if (parent && isOpen(parent.id) && (matches(s) || matches(parent))) rows.push({ space: s, child, repos: 0 });
      continue;
    }
    const repos = reposOf(s.id);
    if (!matches(s) && !repos.some(matches)) continue;
    const head = s.kind === "repo" && !standalone;
    if (head) standalone = true;
    rows.push({ space: s, child, repos: repos.length, standaloneHead: head });
  }
  return rows;
});
const personal = computed(() => state.spaces.filter((s) => s.kind === "personal" && matches(s)));
const isRepo = (s: Space) => s.kind === "repo" && !!s.rootPath;
/** Last folder of a repo path, without the hash suffix added to cloned repos. */
const dirName = (p: string) => (p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p).replace(/-[0-9a-f]{12}$/, "");
function summary(s: Space) {
  const parts = [`${s.sources ?? 0} 份原件`];
  if (s.pages) parts.push(`${s.pages} 页`);
  const repos = reposOf(s.id).length;
  if (repos) parts.push(`${repos} 个仓库`);
  return parts.join(" · ");
}
function submoduleTip(s: { settings?: Record<string, any> }) {
  const sm = s.settings?.submodules;
  if (!sm) return "";
  const failed = (sm.failed ?? []).map((f: { path: string; error: string }) => `${f.path}：${f.error}`);
  if (failed.length) return `拉取失败：\n${failed.join("\n")}`;
  if (!sm.managed && sm.ready < sm.total) return "其余子模块需要在仓库里运行 git submodule update --init --recursive";
  return "子模块都已检出并索引";
}

// ---- a new space ----
const creating = ref(false);
const newSpace = ref({ name: "", kind: "project", rootPath: "", description: "", init: false });
const creatingSpace = ref(false);
function startCreate() {
  // The space being edited stays behind the form: 取消 goes back to it.
  creating.value = true;
  void nextTick(() => document.getElementById("new-space-name")?.focus());
}
async function createSpace() {
  if (creatingSpace.value) return;
  creatingSpace.value = true;
  const init = newSpace.value.kind === "repo" && newSpace.value.init;
  const input = { ...newSpace.value, rootPath: newSpace.value.rootPath.trim(), init: init || undefined };
  try {
    await post("/api/spaces", { ...input, rootPath: input.rootPath || undefined });
    toast(init ? "已新建仓库和空间，可以交办编码了" : input.rootPath ? "已创建，正在导入目录" : "已创建空间", "ok");
    newSpace.value = { name: "", kind: "project", rootPath: "", description: "", init: false };
    creating.value = false;
    await loadSpaces();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    creatingSpace.value = false;
  }
}

// ---- the chosen space ----
const editing = ref<Space | null>(null);
const guide = ref("");
/** Skills a space can mount (settings.skills): its own way of doing things, offered to runs there. */
const skillOptions = ref<{ value: string; label: string; hint?: string }[]>([]);
const spaceSkills = computed<string[]>({
  get: () => (Array.isArray(editing.value?.settings.skills) ? (editing.value!.settings.skills as string[]) : []),
  set: (v) => { if (editing.value) editing.value.settings.skills = v; },
});
type RepoSuggestion = { space: string; name: string; reasons: string[] };
const suggestions = ref<RepoSuggestion[]>([]);
const newRepo = ref("");
const addingRepo = ref(false);
type WorkspaceSlot = { path: string; state: "free" | "leased" | "invalid" | "dirty"; run?: string; branch?: string | null; reason?: string };
const SLOT_STATE: Record<WorkspaceSlot["state"], string> = { free: "空闲", leased: "借出", invalid: "不可用", dirty: "空闲（有残留，借出时清掉）" };
const slots = ref<WorkspaceSlot[]>([]);
const related = ref<SpaceRelation[]>([]);
const newRelated = ref({ space: "", note: "" });
/** What the space being edited still holds; only an empty one can be deleted. */
const spaceContentOf = ref<{ label: string; count: number }[]>([]);
let opening = 0;
async function loadSuggestions(id: string) {
  suggestions.value = await get<RepoSuggestion[]>(`/api/spaces/${id}/repo-suggestions`).catch(() => []);
}
async function openSpace(s: Space) {
  const ticket = ++opening;
  creating.value = false;
  editing.value = { ...s, settings: { ...s.settings } };
  if (s.parentId && !expanded.value.has(s.parentId)) toggle(s.parentId);
  if (s.kind === "personal") showPersonal.value = true;
  try { localStorage.setItem(LAST_KEY, s.id); } catch { /* private window */ }
  related.value = (s.related ?? []).filter((r) => !r.via);
  suggestions.value = [];
  newRepo.value = "";
  guide.value = "";
  spaceContentOf.value = [];
  if (!isRepo(s)) void loadSuggestions(s.id);
  newRelated.value = { space: "", note: "" };
  slots.value = [];
  repoBranch.value = null;
  const detail = await get<{ guide: string; content?: { label: string; count: number }[] }>(`/api/spaces/${s.id}`);
  if (ticket !== opening) return;
  guide.value = detail.guide;
  spaceContentOf.value = detail.content ?? [];
  if (s.rootPath && s.kind === "repo") void loadRepoBranches(s.id);
  if (!skillOptions.value.length) skillOptions.value = (await get<{ name: string; description: string; status: string }[]>("/api/skills").catch(() => [])).map((k) => ({ value: k.name, label: k.status === "draft" ? `${k.name}（草稿）` : k.name, hint: k.description }));
  if (s.rootPath) {
    const list = await get<WorkspaceSlot[]>(`/api/spaces/${s.id}/workspaces`).catch(() => []);
    if (ticket === opening) slots.value = list;
  }
}
async function moveRepo(repo: string, parent: string | null) {
  try {
    await post(`/api/spaces/${repo}/parent`, { parent });
    toast(parent ? `已归到 ${state.spaces.find((s) => s.id === parent)?.name ?? parent} 下` : "已移出，现在是独立仓库", "ok");
    await loadSpaces();
    if (editing.value && !isRepo(editing.value)) await loadSuggestions(editing.value.id);
    if (editing.value?.id === repo) editing.value.parentId = parent;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function addRepo() {
  const at = newRepo.value.trim();
  if (!editing.value || !at || addingRepo.value) return;
  addingRepo.value = true;
  try {
    // The name comes from the directory or the link; it can be renamed in the repository's settings.
    const name = (at.replace(/[\\/]+$/, "").replace(/\.git$/, "").split(/[\\/:]/).pop() || at).trim();
    await post("/api/spaces", { name, kind: "repo", rootPath: at, parent: editing.value.id });
    toast(`已添加 ${name}，正在导入代码`, "ok");
    newRepo.value = "";
    await loadSpaces();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    addingRepo.value = false;
  }
}
const syncRepo = async (id: string) => {
  try { await post(`/api/spaces/${id}/sync`); toast("已开始同步", "ok"); } catch (e) { toast((e as Error).message, "error"); }
};
/** Business spaces a repository can go under. */
const parentOptions = computed(() => [{ value: "", label: "不属于任何业务（独立仓库）" }, ...state.spaces.filter((s) => s.kind !== "repo" && !s.parentId && s.kind !== "worktree").map((s) => ({ value: s.id, label: s.name }))]);
const relatable = computed(() => state.spaces.filter((s) => editing.value && s.id !== editing.value.id && s.parentId !== editing.value.id && s.id !== editing.value.parentId && !related.value.some((r) => r.space === s.id)).map((s) => ({ value: s.id, label: s.name })));
async function addRelated() {
  if (!editing.value || !newRelated.value.space) return;
  try {
    related.value = (await post<SpaceRelation[]>(`/api/spaces/${editing.value.id}/related`, newRelated.value)).filter((r) => !r.via);
    newRelated.value = { space: "", note: "" };
    await loadSpaces();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function removeRelated(r: SpaceRelation) {
  if (!editing.value) return;
  related.value = (await del<SpaceRelation[]>(`/api/spaces/${editing.value.id}/related/${encodeURIComponent(r.space)}`)).filter((x) => !x.via);
  await loadSpaces();
}
async function saveSpace() {
  if (!editing.value) return;
  const s = editing.value;
  if (typeof s.settings.setupCommand === "string" && !s.settings.setupCommand.trim()) delete s.settings.setupCommand;
  // A mirror of another server's space is set up by subscribing, not here.
  const { mirror: _mirror, ...settings } = s.settings;
  await patch(`/api/spaces/${s.id}`, { name: s.name, description: s.description, settings, guide: guide.value });
  toast("空间已保存", "ok");
  await loadSpaces();
  const fresh = state.spaces.find((x) => x.id === s.id);
  if (fresh) void openSpace(fresh);
}
/** Point the space being edited at another checkout of its repository; false when it did not happen. */
async function relink(path: string): Promise<boolean> {
  const s = editing.value;
  if (!s) return false;
  try {
    type Result = { done: true; old: string; root: string } | { done: false; pending: { run: string; title: string }[] };
    let r = await post<Result>(`/api/spaces/${s.id}/relink`, { path });
    if (!r.done) {
      const list = r.pending.map((p) => `· ${p.title}`).join("\n");
      const ok = await confirmDialog(`丢弃 ${r.pending.length} 个没确认的交办？`, { message: `它们的工作区和分支在原来的仓库 ${s.rootPath} 里，换目录前要先处理：\n${list}\n\n要保留就先去运行页确认（推送），再回来换。`, okText: "丢弃并换目录", danger: true });
      if (!ok) return false;
      r = await post<Result>(`/api/spaces/${s.id}/relink`, { path, discard: true });
      if (!r.done) return false;
    }
    toast(`仓库目录改为 ${r.root}，正在重新导入`, "ok");
    s.rootPath = r.root;
    s.settings = (await get<Space>(`/api/spaces/${s.id}`)).settings;
    slots.value = await get<WorkspaceSlot[]>(`/api/spaces/${s.id}/workspaces`).catch(() => []);
    await loadSpaces();
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}
/** The branch the repository's own directory has checked out: delegations cut their work from it, and land on it when there is no origin. */
const repoBranch = ref<{ current: string; pick: string; options: { value: string; label: string }[] } | null>(null);
const switchingBranch = ref(false);
async function loadRepoBranches(id: string) {
  const b = await get<{ current: string; branches: { name: string; remote: boolean }[] }>(`/api/spaces/${id}/branches`).catch(() => null);
  if (!b || editing.value?.id !== id) return;
  const local = b.branches.filter((x) => !x.remote).map((x) => x.name);
  const remoteOnly = b.branches.filter((x) => x.remote && !local.includes(x.name.replace(/^origin\//, ""))).map((x) => x.name.replace(/^origin\//, ""));
  repoBranch.value = { current: b.current, pick: b.current, options: [...local.map((n) => ({ value: n, label: n })), ...remoteOnly.map((n) => ({ value: n, label: `${n}（只在 origin）` }))] };
}
async function switchRepoBranch() {
  const s = editing.value, b = repoBranch.value;
  if (!s || !b || b.pick === b.current || switchingBranch.value) return;
  switchingBranch.value = true;
  try {
    await put(`/api/spaces/${s.id}/branches`, { current: b.pick });
    toast(`仓库目录切到了 ${b.pick}，正在重新导入`, "ok");
    await loadRepoBranches(s.id);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    switchingBranch.value = false;
  }
}
const canDelete = computed(() => !!editing.value && editing.value.kind !== "personal" && editing.value.kind !== "worktree" && (!state.me || state.me.role === "owner"));
async function removeSpace() {
  const s = editing.value;
  if (!s) return;
  if (spaceContentOf.value.length) return toast(`${s.name} 里还有内容，不能删除：${spaceContentOf.value.map((c) => `${c.label} ${c.count}`).join("、")}`, "error");
  const ok = await confirmDialog(`删除空间「${s.name}」？`, { message: `它是空的，删掉后从空间列表里消失，成员和与其他空间的关联一起删除。${s.rootPath ? `仓库目录 ${s.rootPath} 不动。` : ""}`, okText: "删除", danger: true });
  if (!ok) return;
  try {
    await del(`/api/spaces/${s.id}`);
    toast("空间已删除", "ok");
    editing.value = null;
    await loadSpaces();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function changeRoot() {
  const s = editing.value;
  if (!s) return;
  const path = (await promptDialog("换一个仓库目录", { message: "填同一个仓库（git remote 相同）在这台机器上的另一份克隆，比如你平时开发的目录。交办从它当前的提交切出工作分支，在这里检出的分支每轮结束会自动快进。", value: s.rootPath ?? "", placeholder: "/home/me/code/app", okText: "换" }))?.trim();
  if (path && path !== s.rootPath) await relink(path);
}

/** The space opened last on this page, opened again next time. */
const LAST_KEY = "omem.settings.spaces.last";
/** The original of the space being edited, to throw away unsaved changes. */
const original = computed(() => state.spaces.find((s) => s.id === editing.value?.id) ?? null);
/** What the header says about the space: its description, then counts (or the business it belongs to). */
const parentName = computed(() => (editing.value?.parentId ? state.spaces.find((s) => s.id === editing.value!.parentId)?.name ?? "" : ""));

onMounted(() => {
  // `?space=<id>` (from a page that needs one of its settings, e.g. a preview command) first; otherwise the one
  // opened here last, the current space, or the first in the list: the right side is never empty while there are spaces.
  const query = typeof route.query.space === "string" ? route.query.space : "";
  const pick = () => {
    let last = "";
    try { last = localStorage.getItem(LAST_KEY) ?? ""; } catch { /* private window */ }
    const s = [query, last, state.space].map((id) => id && state.spaces.find((x) => x.id === id)).find(Boolean) || listed.value[0]?.space;
    if (s) void openSpace(s);
    return !!s;
  };
  if (!pick() || (query && !state.spaces.some((x) => x.id === query))) void loadSpaces().then(pick);
});
</script>

<template>
  <div class="spaces-page" data-no-toc>
    <HelpText lead>空间把不同领域的知识分开：每个空间有自己的原件、Wiki、记忆和事项。助理默认在当前空间和它的相关空间里调查，需要时才查所有空间；整理、复核这类只管一个空间的任务也能读相关空间，但只写自己的。代码仓库挂在它所属的业务空间下，检索、交办、评审和编码记录都算在业务空间里；不属于任何业务的仓库单独列出。</HelpText>
    <div class="sp-layout">
      <aside class="sp-list card" aria-label="空间">
        <div class="sp-list-head">
          <label class="sp-search"><Icon name="search" :size="13" /><input v-model="filter" placeholder="筛选空间" aria-label="筛选空间" /></label>
          <button class="btn ghost sm icon" :class="{ on: creating }" aria-label="新建空间" title="新建空间" @click="startCreate"><Icon name="plus" :size="15" /></button>
        </div>
        <div class="sp-items">
          <template v-for="{ space: s, child, repos, standaloneHead } in listed" :key="s.id">
            <div v-if="standaloneHead" class="sp-label">独立仓库</div>
            <div class="sp-row" :class="{ child, on: editing?.id === s.id }">
              <button
                v-if="!child && repos"
                type="button"
                class="sp-fold"
                :aria-expanded="isOpen(s.id)"
                :aria-label="`${isOpen(s.id) ? '收起' : '展开'} ${s.name} 的仓库`"
                :disabled="filtering"
                @click="toggle(s.id)"
              ><Icon name="right" :size="12" class="sp-chev" :class="{ open: isOpen(s.id) }" /></button>
              <span v-else-if="!child" class="sp-fold" aria-hidden="true" />
              <button
                type="button"
                class="sp-item"
                :aria-current="editing?.id === s.id ? 'true' : undefined"
                :title="[s.description, s.rootPath].filter(Boolean).join('\n') || undefined"
                @click="openSpace(s)"
              >
                <Icon v-if="s.kind === 'repo'" name="code" :size="13" class="sp-icon" />
                <span class="sp-name ellipsis">{{ s.name }}</span>
                <span v-if="s.settings?.submodules?.failed?.length" class="sp-warn" :title="submoduleTip(s)" :aria-label="`子模块 ${s.settings.submodules.failed.length} 个失败`" />
                <span v-if="!child && repos" class="sp-count" :title="`${repos} 个仓库`">{{ repos }}</span>
              </button>
            </div>
          </template>
          <p v-if="!listed.length && !personal.length" class="muted small sp-empty">没有匹配的空间。</p>
          <template v-if="personal.length">
            <button type="button" class="sp-group" :aria-expanded="showPersonal || !!filter.trim()" @click="showPersonal = !showPersonal">
              <Icon name="right" :size="12" class="sp-chev" :class="{ open: showPersonal || !!filter.trim() }" />个人空间<span class="muted"> {{ personal.length }}</span>
            </button>
            <template v-if="showPersonal || filter.trim()">
              <div v-for="s in personal" :key="s.id" class="sp-row child" :class="{ on: editing?.id === s.id }">
                <button type="button" class="sp-item" :aria-current="editing?.id === s.id ? 'true' : undefined" :title="summary(s)" @click="openSpace(s)">
                  <span class="sp-name ellipsis">{{ s.name }}</span>
                </button>
              </div>
            </template>
          </template>
        </div>
      </aside>

      <section class="sp-detail card">
        <form v-if="creating" class="sp-form" :aria-busy="creatingSpace" @submit.prevent="createSpace">
          <header class="sp-head"><h3 class="set-title">新建空间</h3><button type="button" class="btn ghost sm icon" aria-label="取消" @click="creating = false"><Icon name="x" :size="15" /></button></header>
          <div class="sp-sec">
            <div class="grid2">
              <label class="field"><span>名称</span><input id="new-space-name" v-model="newSpace.name" class="input" required :disabled="creatingSpace" placeholder="例如：项目A、英语学习、omem 仓库" /></label>
              <div class="field"><span>类型</span><UiSelect v-model="newSpace.kind" aria-label="空间类型" :disabled="creatingSpace" :options="[{ value: 'project', label: '项目' }, { value: 'repo', label: '代码仓库' }, { value: 'learning', label: '学习' }, { value: 'topic', label: '通用' }]" /></div>
            </div>
            <label class="field">
              <span>{{ newSpace.kind === 'repo' && newSpace.init ? '新仓库放在哪（可选）' : newSpace.kind === 'repo' ? '仓库目录或 Git 地址（可选）' : '关联目录（代码仓库或文档目录，可选）' }}</span>
              <input v-model="newSpace.rootPath" class="input mono" :disabled="creatingSpace" :placeholder="newSpace.kind === 'repo' && newSpace.init ? '不填：omem 数据目录的 repos/<空间 id>' : newSpace.kind === 'repo' ? 'https://example.com/team/app.git 或 /home/me/code/app' : '/home/me/code/app'" />
              <span v-if="newSpace.kind === 'repo' && newSpace.init" class="hint">填运行 omem 的机器上不存在或空的绝对路径；omem 在那里 git init 并做一次空提交。</span>
              <span v-else-if="newSpace.kind === 'repo'" class="hint">本地目录或 HTTP(S) / SSH Git 地址；Git 地址克隆到数据目录的 repos/，私有仓库用服务器已有的凭据，链接里不要填密码或令牌。</span>
              <span v-else class="hint">运行 omem 的机器上已有的绝对路径；创建后导入文本文件（遵守 .gitignore），之后可同步更新。</span>
            </label>
            <UiCheckbox v-if="newSpace.kind === 'repo'" v-model="newSpace.init" :disabled="creatingSpace">新建一个空仓库（从零开始的项目）</UiCheckbox>
            <label class="field"><span>说明</span><input v-model="newSpace.description" class="input" :disabled="creatingSpace" placeholder="这个空间收什么、给谁读" /></label>
          </div>
          <footer class="sp-foot"><span v-if="creatingSpace" class="small muted" role="status">正在创建空间，Git 仓库克隆可能需要几分钟…</span><span class="spacer" /><button type="button" class="btn ghost" @click="creating = false">取消</button><button class="btn primary" :disabled="creatingSpace || !newSpace.name.trim()">{{ creatingSpace ? '正在创建…' : '创建' }}</button></footer>
        </form>

        <div v-else-if="editing" class="sp-form">
          <header class="sp-head">
            <div class="sp-title">
              <h3 class="set-title ellipsis">{{ editing.name || "（没有名字）" }}</h3>
              <span class="badge">{{ kindLabel[editing.kind] ?? editing.kind }}</span>
            </div>
            <p v-if="original?.description" class="sp-lede">{{ original.description }}</p>
            <div class="sp-facts small muted">
              <span v-if="isRepo(editing)">{{ parentName ? `属于 ${parentName}` : "独立仓库" }}<template v-if="editing.rootPath && dirName(editing.rootPath) !== editing.name"> · <span class="mono">{{ dirName(editing.rootPath) }}</span></template></span>
              <span v-else>{{ summary(editing) }}</span>
              <span v-if="editing.settings?.submodules?.failed?.length" class="warn-text" :title="submoduleTip(editing)">子模块 {{ editing.settings.submodules.failed.length }} 个失败</span>
              <MonoLine class="sp-id" :text="editing.id" copy />
            </div>
          </header>
          <p v-if="editing.settings.mirror" class="sp-sec muted small">这是 {{ editing.settings.mirror.peer }} 的空间的只读镜像，内容由同步写入。</p>

          <div class="sp-sec">
            <div class="grid2">
              <label class="field"><span>名称</span><input v-model="editing.name" class="input" /></label>
              <label class="field"><span>说明</span><input v-model="editing.description" class="input" /></label>
            </div>
            <UiCheckbox v-if="!editing.settings.mirror" v-model="editing.settings.local" title="这个空间的内容不出这台机器：不能共享给别的 omem，在这个空间里的运行也不会用从别人的 omem 借来的 AI">仅本机：不共享、不同步，也不交给借来的 AI</UiCheckbox>
          </div>

          <div v-if="isRepo(editing)" class="sp-sec">
            <h4>所属业务空间</h4>
            <UiSelect :model-value="editing.parentId ?? ''" :options="parentOptions" aria-label="所属业务空间" @update:model-value="(v) => moveRepo(editing!.id, v || null)" />
            <span class="hint">挂到业务空间下后，在业务空间里检索、交办、评审都包括这个仓库，交办记在业务空间。</span>
          </div>
          <div v-else class="sp-sec">
            <h4>仓库</h4>
            <div v-for="r in suggestions" :key="r.space" class="suggest small">
              <span class="grow">可能也属于这里：<strong>{{ r.name }}</strong>（{{ r.reasons.join("；") }}）</span>
              <button class="btn sm" @click="moveRepo(r.space, editing!.id)">归到这里</button>
              <button class="btn ghost sm" @click="suggestions = suggestions.filter((x) => x.space !== r.space)">不是</button>
            </div>
            <div v-for="c in reposOf(editing.id)" :key="c.id" class="line-row">
              <div class="grow repo-line">
                <div class="repo-head"><span class="repo-name ellipsis">{{ c.name }}</span><span class="muted small ellipsis" :title="codeIndexLabel(c)">{{ codeIndexLabel(c) }}</span></div>
                <MonoLine :text="c.rootPath ?? ''" />
              </div>
              <button class="btn ghost sm" @click="syncRepo(c.id)">同步</button>
              <button class="btn ghost sm" @click="openSpace(c)">设置</button>
              <button class="btn ghost sm danger" @click="moveRepo(c.id, null)">移出</button>
            </div>
            <div class="row">
              <input v-model="newRepo" class="input sm mono grow" placeholder="添加仓库：本地路径或 Git 链接" aria-label="添加仓库" :disabled="addingRepo" @keydown.enter.prevent="addRepo" />
              <button class="btn sm" :disabled="!newRepo.trim() || addingRepo" @click="addRepo">添加</button>
            </div>
            <span class="hint">添加后导入代码（遵守 .gitignore）；仓库自己的检查命令、目录等在它的“设置”里。</span>
          </div>

          <div class="sp-sec">
            <h4>相关空间</h4>
            <span class="hint">别的业务：互相调用、共用约定；在其中一个工作时会一起查另一个。移除 Agent 发现的关联后，它不会再被自动加回。</span>
            <div v-for="r in related" :key="r.space" class="line-row">
              <span>{{ r.name }}</span><span v-if="r.origin === 'agent'" class="badge" :title="r.evidence || undefined">Agent 发现</span>
              <span class="muted small grow ellipsis" :title="r.note">{{ r.note || "（没有说明）" }}</span>
              <button class="btn ghost sm icon" :aria-label="`移除与 ${r.name} 的关联`" @click="removeRelated(r)"><Icon name="x" :size="14" /></button>
            </div>
            <div v-if="relatable.length" class="row wrap">
              <UiSelect v-model="newRelated.space" size="sm" width="180px" aria-label="选择空间" placeholder="选择空间" :options="relatable" />
              <input v-model="newRelated.note" class="input sm grow" style="min-width: 180px" placeholder="是什么关系，如“调用它的订单接口”" @keydown.enter.prevent="addRelated" />
              <button class="btn sm" :disabled="!newRelated.space" @click="addRelated">添加</button>
            </div>
          </div>

          <div class="sp-sec">
            <label class="field"><span>空间指南（SPACE.md，Agent 每次工作前都会读）</span><textarea v-model="guide" class="textarea mono" rows="8" /></label>
            <div class="field">
              <span>这个空间的技能</span>
              <UiSelect v-model="spaceSkills" multiple aria-label="这个空间的技能" placeholder="不挂技能" :options="skillOptions" />
              <HelpText>这里的做法写成技能（数据目录的 library/_skills，不放进仓库），挂到空间上：在这个空间里的运行、改到这个仓库的编码和评审会先看到它，别的空间不提供。比如这个仓库怎么跑测试、用例里怎么写需求点 id、怎么把结果交给 report_tests。</HelpText>
            </div>
          </div>

          <div v-if="editing.rootPath" class="sp-sec">
            <h4>代码</h4>
            <div v-if="editing.kind === 'repo'" class="field">
              <span>仓库目录（交办从这里当前的提交切出工作分支）</span>
              <div class="row"><MonoLine class="grow" :text="editing.rootPath" copy /><button class="btn sm" @click="changeRoot">换目录</button></div>
            </div>
            <div v-if="editing.kind === 'repo' && repoBranch" class="field">
              <span>检出的分支（新的交办从它切出；没有 origin 时，确认交办会合回这条分支）</span>
              <div class="row">
                <UiSelect v-model="repoBranch.pick" class="grow" aria-label="仓库目录检出的分支" :options="repoBranch.options" :disabled="switchingBranch" />
                <button class="btn sm" :disabled="switchingBranch || repoBranch.pick === repoBranch.current" @click="switchRepoBranch">{{ switchingBranch ? "切换中…" : "切换" }}</button>
              </div>
              <span class="hint">现在是 <code>{{ repoBranch.current }}</code>。目录里有没提交的改动时不切换。</span>
            </div>
            <label class="field"><span>检查命令（每轮编码后运行，结果交给评审）</span><input v-model="editing.settings.checkCommand" class="input mono" placeholder="npm test" /><span class="hint">可以用环境变量 OMEM_BASE（这次改动的起点提交），如 <code>git diff --name-only $OMEM_BASE</code> 只测改到的部分。</span></label>
            <label class="field">
              <span>准备命令（新工作区或锁文件变了时，编码前运行）</span>
              <input v-model="editing.settings.setupCommand" class="input mono" placeholder="不填按锁文件自动选（pnpm / yarn / npm / bun）；填 none 不准备" />
            </label>
            <label v-if="editing.kind === 'repo'" class="field">
              <span>预览命令（一行一个“名字: 命令”，只有一条可以不写名字）</span>
              <textarea v-model="editing.settings.previewCommands" class="textarea mono" rows="3" placeholder="主站: pnpm --dir apps/main dev & pnpm --dir apps/sub dev & wait&#10;H5: pnpm --dir wap/h5 dev" />
              <HelpText>在交办的工作区里起服务，从你的电脑打开看效果。端口不用填：omem 认出命令开的端口，按同样的端口号转到你电脑上（经 omem peer open 打开 omem 时），写死 localhost 端口的项目也能用。同一仓库同时只开一个，没人看 30 分钟后停掉。</HelpText>
            </label>
            <label v-if="editing.kind === 'repo'" class="field">
              <span>设备的外部 Agent 可以运行的命令（一行一个“名字: 命令”）</span>
              <textarea v-model="editing.settings.peerCommands" class="textarea mono" rows="3" placeholder="test: npx vitest run&#10;lint: npx eslint" />
              <span class="hint">它经 --peer 交办编码时用；检查和准备命令自动包含。</span>
            </label>
            <CodeIndexPanel :space-id="editing.id" @config="(c) => (editing!.settings.codeIndex = c)" />
            <div v-if="editing.kind === 'repo'" class="field">
              <span>交办工作区</span>
              <span class="hint">omem 按需在数据目录里建，最多 4 个，闲着的会收回给新的交办；被忽略的文件（node_modules 等）一直保留。</span>
              <ul v-if="slots.length" class="slots">
                <li v-for="s in slots" :key="s.path" class="line-row">
                  <MonoLine class="grow" :text="s.path" />
                  <code v-if="s.branch" class="small">{{ s.branch }}</code>
                  <span class="badge" :title="s.reason || undefined">{{ SLOT_STATE[s.state] }}</span>
                  <a v-if="s.run" class="small" :href="`#/runs/${s.run}`">运行</a>
                </li>
              </ul>
              <span v-else class="muted small">还没有，第一次交办时建。</span>
            </div>
            <RepoLessons v-if="editing.kind === 'repo' && (!state.me || state.me.role === 'owner')" :key="editing.id" :space="editing.id" />
          </div>

          <div class="sp-sec">
            <h4>自动整理</h4>
            <UiCheckbox :model-value="editing.settings.autoIngest !== false && (editing.kind !== 'repo' || editing.settings.autoIngest === true)" @change="(v) => (editing!.settings.autoIngest = v)">新材料保存后让助理整理（更新记忆、事项、相关页面）</UiCheckbox>
            <UiCheckbox :model-value="editing.settings.autoLint !== false" @change="(v) => (editing!.settings.autoLint = v)">原件变化后自动检查受影响的 Wiki 页面（稳定半小时后，一次最多 10 页）</UiCheckbox>
            <UiCheckbox :model-value="editing.settings.autoOrganize !== false" @change="(v) => (editing!.settings.autoOrganize = v)">自动把顶层散落、挤在一起的 Wiki 页面整理进目录</UiCheckbox>
            <UiCheckbox v-if="editing.rootPath" :model-value="editing.settings.design === 'always'" @change="(v) => (editing!.settings.design = v ? 'always' : null)">这个仓库的交办总是先写方案（不管推进工作里的“方案先行”怎么设）</UiCheckbox>
            <UiCheckbox v-if="editing.kind === 'repo'" :model-value="editing.settings.commitClaim !== false" @change="(v) => (editing!.settings.commitClaim = v)">本人直接在这个仓库提交后，问这些提交属于哪件事</UiCheckbox>
            <UiCheckbox v-if="editing.kind !== 'personal'" :model-value="!!editing.settings.larkAccess" @change="(v) => (editing!.settings.larkAccess = v)">飞书文档按各人的飞书权限显示（成员要连接飞书，飞书说他能看的才显示全文；你不受限）</UiCheckbox>
          </div>

          <footer class="sp-foot">
            <button v-if="canDelete" class="btn ghost danger" :title="spaceContentOf.length ? `还有内容，不能删除：${spaceContentOf.map((c) => `${c.label} ${c.count}`).join('、')}` : '删除这个空的空间'" :disabled="spaceContentOf.length > 0" @click="removeSpace">删除空间</button>
            <span class="spacer" />
            <button class="btn ghost" :disabled="!original" title="丢掉没保存的修改" @click="original && openSpace(original)">还原</button>
            <button class="btn primary" @click="saveSpace">保存</button>
          </footer>
        </div>

        <div v-else class="sp-none">
          <p class="muted">选一个空间看它的设置，或者新建一个。</p>
          <button class="btn sm" @click="startCreate"><Icon name="plus" :size="13" />新建空间</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.spaces-page {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.sp-layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  min-width: 0;
}
.sp-list {
  position: sticky;
  top: 12px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  max-height: calc(100vh - 140px);
  overflow: hidden;
}
.sp-list-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--line);
}
.sp-list-head .btn.on {
  background: var(--hover);
}
.sp-search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--muted);
}
.sp-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--ink);
  padding: 4px 0;
}
.sp-search input:focus {
  outline: none;
}
.sp-items {
  overflow-y: auto;
  padding: 6px;
  display: grid;
  align-content: start;
}
.sp-label {
  padding: 12px 10px 4px 30px;
  font-size: 12px;
  color: var(--muted);
}
.sp-row {
  display: flex;
  align-items: center;
  min-width: 0;
  border-radius: var(--radius-sm);
}
.sp-row:hover {
  background: var(--hover);
}
.sp-row.on {
  background: var(--accent-soft);
}
.sp-row.on .sp-name {
  color: var(--accent);
  font-weight: 600;
}
.sp-row.child {
  padding-left: 22px;
}
.sp-fold {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 30px;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
}
.sp-fold:disabled {
  cursor: default;
}
span.sp-fold {
  cursor: default;
}
.sp-item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 30px;
  border: 0;
  background: none;
  text-align: left;
  font: inherit;
  color: inherit;
  padding: 0 8px 0 2px;
  cursor: pointer;
}
.sp-row.child .sp-item {
  padding-left: 8px;
}
.sp-name {
  min-width: 0;
  font-size: 13.5px;
  color: var(--ink);
}
.sp-row.child .sp-name {
  font-size: 13px;
  color: var(--ink-2);
}
.sp-icon {
  flex: none;
  color: var(--muted);
}
.sp-count {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.sp-warn {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}
.sp-group {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 8px 10px 8px 6px;
  border: 0;
  border-top: 1px solid var(--line);
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--ink-2);
  cursor: pointer;
  text-align: left;
}
.sp-chev {
  transition: transform 0.15s ease;
}
.sp-chev.open {
  transform: rotate(90deg);
}
.sp-empty {
  padding: 8px 10px;
}
.sp-detail {
  min-width: 0;
}
.sp-form {
  display: grid;
  min-width: 0;
}
.sp-head {
  display: grid;
  gap: 4px;
  padding: 16px 18px 12px;
  min-width: 0;
}
form .sp-head {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}
.sp-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.sp-lede {
  margin: 2px 0 0;
  font-size: 14px;
  color: var(--ink-2);
  max-width: 72ch;
}
.sp-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  min-width: 0;
}
.sp-id {
  max-width: 280px;
}
.sp-sec {
  display: grid;
  gap: 8px;
  padding: 16px 18px;
  border-top: 1px solid var(--line);
  min-width: 0;
  margin: 0;
}
.sp-sec h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
}
.sp-sec .hint {
  font-size: 12px;
  color: var(--muted);
}
.sp-foot {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
  background: var(--panel);
  border-radius: 0 0 var(--radius) var(--radius);
}
.sp-none {
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 64px 24px;
  text-align: center;
}
.sp-none p {
  margin: 0;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.line-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.repo-line {
  display: grid;
  gap: 2px;
}
.repo-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.repo-name {
  flex: none;
  max-width: 60%;
}
.line-row .btn,
.line-row .badge {
  flex: none;
}
.suggest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  gap: 6px 10px;
}
.slots {
  list-style: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.warn-text {
  color: var(--warn);
}
@media (max-width: 760px) {
  .sp-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .sp-list {
    position: static;
    max-height: 36vh;
  }
  .grid2 {
    grid-template-columns: 1fr;
  }
  .sp-sec,
  .sp-head,
  .sp-foot {
    padding-left: 14px;
    padding-right: 14px;
  }
}
</style>
