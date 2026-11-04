<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { del, get, post, put } from "../api";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { fmtTime, state, toast } from "../store";
import { confirmDialog } from "../lib/dialog";

/**
 * Settings → 设备, sharing with other people's omem servers (src/core/federation.ts): what this one
 * shares (a service account per server, its spaces and what of them), and the other servers' spaces
 * this one follows — searched live, or mirrored here read-only on a schedule.
 */
type Share = { space: string; name: string; mode: "query" | "sync"; kinds: string[] };
type Account = { id: string; name: string; createdAt: string; disabled: boolean; lastUsedAt: string | null; shares: Share[] };
type Sub = { id: string; peer: string; remoteSpace: string; remoteName: string; localSpace: string; mode: "query" | "sync"; lastSeq: number; syncedAt: string | null; error: string | null };

const KINDS = [
  { value: "wiki", label: "Wiki" },
  { value: "memory", label: "记忆" },
  { value: "doc", label: "文档" },
  { value: "chat", label: "聊天" },
  { value: "web", label: "网页" },
  { value: "note", label: "笔记" },
  { value: "code", label: "代码" },
];
const MODES = [
  { value: "query", label: "只检索" },
  { value: "sync", label: "可同步" },
];
const accounts = ref<Account[]>([]);
const subs = ref<Sub[]>([]);
const peers = ref<{ id: string }[]>([]);
const form = ref({ label: "", url: "", shares: [] as { space: string; mode: "query" | "sync"; kinds: string[] }[] });
const code = ref("");
const subForm = ref({ peer: "", space: "", sync: false });
const offers = ref<Share[] | null>(null);
const spaceOptions = computed(() => state.spaces.filter((s) => s.kind !== "personal" && !(s.settings as { mirror?: unknown })?.mirror).map((s) => ({ value: s.id, label: s.name })));
const fail = (e: unknown) => toast((e as Error).message, "error");

async function load() {
  const [a, s, p] = await Promise.all([get<Account[]>("/api/peer/shares"), get<Sub[]>("/api/peer/subscriptions"), get<{ peers: { id: string }[] }>("/api/peers")]);
  accounts.value = a;
  subs.value = s;
  peers.value = p.peers;
}
async function makeShare() {
  if (!form.value.label.trim() || !form.value.shares.length) return toast("填对方的名字，至少选一个空间", "error");
  try {
    const r = await post<{ code: string }>("/api/peer/shares", { label: form.value.label.trim(), url: form.value.url.trim() || undefined, shares: form.value.shares });
    code.value = r.code;
    form.value = { label: "", url: "", shares: [] };
    await load();
  } catch (e) {
    fail(e);
  }
}
async function saveShares(a: Account, shares: Share[]) {
  try {
    await put(`/api/peer/shares/${a.id}`, { shares: shares.map((s) => ({ space: s.space, mode: s.mode, kinds: s.kinds })) });
    await load();
  } catch (e) {
    fail(e);
  }
}
async function revoke(a: Account) {
  if (!(await confirmDialog(`不再和 ${a.name} 共享？`, { message: "它的令牌立刻失效，检索和同步都停下。它已经同步过去的内容留在它那里。", okText: "停止共享", danger: true }))) return;
  try {
    await del(`/api/peer/shares/${a.id}`);
    await load();
  } catch (e) {
    fail(e);
  }
}
async function pickPeer(peer: string) {
  subForm.value = { peer, space: "", sync: false };
  offers.value = null;
  if (!peer) return;
  try {
    offers.value = (await get<{ shares: Share[] }>(`/api/peer/offers/${encodeURIComponent(peer)}`)).shares;
  } catch (e) {
    offers.value = [];
    fail(e);
  }
}
async function subscribe() {
  try {
    await post("/api/peer/subscriptions", { peer: subForm.value.peer, remoteSpace: subForm.value.space, mode: subForm.value.sync ? "sync" : "query" });
    subForm.value = { peer: "", space: "", sync: false };
    offers.value = null;
    await load();
    toast("已关注", "ok");
  } catch (e) {
    fail(e);
  }
}
async function syncNow(s: Sub) {
  try {
    const r = await post<{ applied: number }>(`/api/peer/subscriptions/${s.id}/sync`);
    toast(`同步了 ${r.applied} 项`, "ok");
    await load();
  } catch (e) {
    fail(e);
  }
}
async function unsubscribe(s: Sub) {
  if (!(await confirmDialog(`不再关注 ${s.peer} 的 ${s.remoteName}？`, { message: "已经同步到本机的内容留着（不再更新）。", okText: "取消关注", danger: true }))) return;
  try {
    await del(`/api/peer/subscriptions/${s.id}`);
    await load();
  } catch (e) {
    fail(e);
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制", "ok");
  } catch {
    toast("浏览器不让复制，请手动选中", "error");
  }
}
const chosen = computed(() => offers.value?.find((o) => o.space === subForm.value.space) ?? null);
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? (k === "source" ? "全部原件" : k);
onMounted(() => load().catch(fail));
</script>

<template>
  <div class="stack">
    <h2 class="section-title">和别人的 omem 共享</h2>
    <p class="muted small">给别人的 omem 服务开放几个空间：对方只能检索、读这些空间里你选的内容，或者把它们同步过去。它用自己的服务账号，看不到别的空间和你的个人空间；随时可以停止。</p>

    <div class="card pad stack">
      <div class="section-title">新的共享</div>
      <div class="row wrap">
        <input v-model="form.label" class="input" placeholder="对方的名字（如：项目 A 的服务器）" aria-label="对方的名字" style="width: 240px" />
        <input v-model="form.url" class="input grow" placeholder="对方访问本机的地址（可选）" aria-label="对方访问本机的地址" />
      </div>
      <UiSelect :model-value="''" size="sm" width="200px" placeholder="加一个空间…" aria-label="共享的空间" :options="spaceOptions.filter((o) => !form.shares.some((s) => s.space === o.value))" @change="(v) => form.shares.push({ space: v, mode: 'query', kinds: ['wiki', 'memory', 'doc'] })" />
      <div v-for="s in form.shares" :key="s.space" class="share-row stack">
        <div class="row wrap">
          <strong>{{ spaceOptions.find((o) => o.value === s.space)?.label ?? s.space }}</strong>
          <UiSegmented v-model="s.mode" size="sm" aria-label="模式" :options="MODES" />
          <span class="spacer" />
          <button class="btn ghost sm" @click="form.shares = form.shares.filter((x) => x.space !== s.space)">去掉</button>
        </div>
        <div class="row wrap kinds"><UiCheckbox v-for="k in KINDS" :key="k.value" v-model="s.kinds" :value="k.value" size="sm">{{ k.label }}</UiCheckbox></div>
      </div>
      <div class="row"><button class="btn sm primary" @click="makeShare">生成配对码</button></div>
      <div v-if="code" class="stack code-box">
        <div class="row"><span class="small grow">在对方的“设备”页粘贴，再关注这些空间</span><button class="btn ghost sm" @click="copy(code)">复制</button></div>
        <div class="mono small code">{{ code }}</div>
      </div>
    </div>

    <div v-for="a in accounts" :key="a.id" class="card pad stack" :class="{ dead: a.disabled }">
      <div class="row wrap">
        <strong>{{ a.name }}</strong>
        <span class="muted small mono">{{ a.id }}</span>
        <span class="muted small">{{ a.disabled ? "已停止" : a.lastUsedAt ? `最近访问 ${fmtTime(a.lastUsedAt)}` : "还没访问过" }}</span>
        <span class="spacer" />
        <button v-if="!a.disabled" class="btn ghost sm danger" @click="revoke(a)">停止共享</button>
      </div>
      <div v-for="s in a.shares" :key="s.space" class="row wrap small">
        <span>{{ s.name }}</span>
        <span class="badge">{{ s.mode === "sync" ? "可同步" : "只检索" }}</span>
        <span class="muted">{{ s.kinds.map(kindLabel).join("、") }}</span>
        <span class="spacer" />
        <button v-if="!a.disabled" class="btn ghost sm" @click="saveShares(a, a.shares.filter((x) => x.space !== s.space))">不共享这个空间</button>
      </div>
    </div>

    <h2 class="section-title">关注别人共享的空间</h2>
    <p class="muted small">先把对方给的配对码加到上面的设备里。关注后，检索和助手能查到这些空间（助手引用时先把原件取到本机）；“同步”的空间每半小时同步到本机一个只读空间。</p>
    <div class="card pad stack">
      <div class="row wrap">
        <UiSelect :model-value="subForm.peer" size="sm" width="180px" placeholder="选设备…" aria-label="设备" :options="peers.map((p) => ({ value: p.id, label: p.id }))" @change="pickPeer" />
        <UiSelect v-if="offers?.length" v-model="subForm.space" size="sm" width="200px" placeholder="选它共享的空间…" aria-label="对方的空间" :options="offers.map((o) => ({ value: o.space, label: o.name, hint: o.mode === 'sync' ? '可同步' : '只检索' }))" />
        <span v-else-if="offers" class="muted small">它没有向这里共享空间</span>
        <UiCheckbox v-if="chosen?.mode === 'sync'" v-model="subForm.sync" size="sm">同步到本机</UiCheckbox>
        <button class="btn sm primary" :disabled="!subForm.space" @click="subscribe">关注</button>
      </div>
    </div>
    <div v-for="s in subs" :key="s.id" class="card pad row wrap">
      <div class="stack tight">
        <strong>{{ s.remoteName }} <span class="muted small">· {{ s.peer }}</span></strong>
        <span class="muted small">{{ s.mode === "sync" ? `同步到 ${s.localSpace}` : "只检索" }}{{ s.syncedAt ? ` · 同步于 ${fmtTime(s.syncedAt)}` : "" }}</span>
        <span v-if="s.error" class="small warn-text">{{ s.error }}</span>
      </div>
      <span class="spacer" />
      <button v-if="s.mode === 'sync'" class="btn ghost sm" @click="syncNow(s)">立即同步</button>
      <button class="btn ghost sm danger" @click="unsubscribe(s)">取消关注</button>
    </div>
  </div>
</template>

<style scoped>
.share-row {
  border-top: 1px solid var(--line);
  padding-top: 8px;
  gap: 6px;
}
.kinds {
  gap: 6px 14px;
}
.code-box {
  background: var(--sunken);
  border-radius: var(--radius-sm);
  padding: 10px;
  gap: 6px;
}
.code {
  overflow-wrap: anywhere;
}
.dead {
  opacity: 0.65;
}
.tight {
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
