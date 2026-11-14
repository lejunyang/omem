<script setup lang="ts">
import HelpText from "./HelpText.vue";
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
type Grant = { kind: "agent" | "ai" | "card"; name: string; daily: number | null };
type Account = { id: string; name: string; createdAt: string; disabled: boolean; lastUsedAt: string | null; shares: Share[]; grants?: Grant[] };
/** What a paired node says about itself (src/core/mesh.ts): its assistants, the Agents it lets this one ask, the spaces it shares. */
type Card = { peer: string; at: string; error?: string; card: { assistants?: { name: string; owner: string; description: string }[]; agents?: { name: string; description: string; daily: number | null }[]; spaces?: { id: string; name: string; description: string; mode: string }[]; ai?: { id: string }[] } | null };
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
const cards = ref<Card[]>([]);
const refreshing = ref(false);
async function loadCards(refresh = false) {
  refreshing.value = refresh;
  try {
    cards.value = (await get<{ cards: Card[] }>(`/api/peer/cards${refresh ? "?refresh=1" : ""}`)).cards;
  } catch (e) {
    if (refresh) fail(e);
  } finally {
    refreshing.value = false;
  }
}
// Which of this node's Agents another server may ask, and how often a day.
const agentNames = ref<{ value: string; label: string; hint?: string }[]>([{ value: "assistant", label: "助理（只读，按共享的空间回答）" }]);
const askable = (a: Account) => (a.grants ?? []).filter((g) => g.kind === "agent").map((g) => g.name);
const askDaily = (a: Account) => (a.grants ?? []).find((g) => g.kind === "agent")?.daily ?? null;
const showsAssistants = (a: Account) => (a.grants ?? []).some((g) => g.kind === "card" && g.name === "assistants");
async function saveGrants(a: Account, next: { agents?: string[]; daily?: number | null; assistants?: boolean }) {
  const agents = next.agents ?? askable(a);
  const daily = next.daily === undefined ? askDaily(a) : next.daily;
  const grants: Grant[] = [
    ...agents.map((name) => ({ kind: "agent" as const, name, daily })),
    ...((next.assistants ?? showsAssistants(a)) ? [{ kind: "card" as const, name: "assistants", daily: null }] : []),
    ...(a.grants ?? []).filter((g) => g.kind === "ai"),
  ];
  try {
    await put(`/api/peer/grants/${encodeURIComponent(a.id)}`, { grants });
    toast("已保存", "ok");
    await load();
  } catch (e) {
    fail(e);
  }
}

async function load() {
  const [a, s, p] = await Promise.all([get<Account[]>("/api/peer/shares"), get<Sub[]>("/api/peer/subscriptions"), get<{ peers: { id: string }[] }>("/api/peers")]);
  accounts.value = a;
  subs.value = s;
  peers.value = p.peers;
  void loadCards();
  void get<{ name: string; description?: string }[]>("/api/agents").then((list) => (agentNames.value = [agentNames.value[0], ...list.map((x) => ({ value: x.name, label: x.name, hint: x.description }))])).catch(() => {});
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
    <template v-if="cards.length">
      <div class="row"><h2 class="section-title grow">网络里的 omem</h2><button class="btn ghost sm" :disabled="refreshing" @click="loadCards(true)">{{ refreshing ? "在问…" : "重新问一遍" }}</button></div>
      <HelpText>配对的每台 omem 每十分钟告诉这台一次它有什么：可以请教的 Agent、那里的助手、共享给这台的空间。你的助手靠这些知道该去问谁；在对话里说“问问 某台 的 某个 Agent”也行。对方给什么由对方的授权决定。</HelpText>
      <div v-for="c in cards" :key="c.peer" class="card pad stack">
        <div class="row wrap"><strong>{{ c.peer }}</strong><span class="badge" :class="c.error ? 'warn' : 'ok'">{{ c.error ? "连不上" : "在线" }}</span><span class="muted small">{{ c.error ? `上次看到 ${fmtTime(c.at)}` : fmtTime(c.at) }}</span></div>
        <p v-if="!c.card" class="muted small">还没拿到过它的名片{{ c.error ? `：${c.error}` : "" }}</p>
        <template v-else>
          <div v-if="c.card.agents?.length" class="small"><span class="muted">可以请教：</span><span v-for="g in c.card.agents" :key="g.name" class="badge accent" :title="g.description">{{ g.name }}@{{ c.peer }}<template v-if="g.daily"> · 每天 {{ g.daily }} 次</template></span></div>
          <div v-if="c.card.assistants?.length" class="small"><span class="muted">那里的助手：</span>{{ c.card.assistants.map((x) => `${x.name}（${x.owner}的${x.description ? `，${x.description}` : ""}）`).join("、") }}</div>
          <div v-if="c.card.spaces?.length" class="small"><span class="muted">共享的空间：</span>{{ c.card.spaces.slice(0, 20).map((x) => x.name).join("、") }}<template v-if="c.card.spaces.length > 20"> 等 {{ c.card.spaces.length }} 个</template></div>
          <p v-if="!c.card.agents?.length && !c.card.assistants?.length && !c.card.spaces?.length" class="muted small">它没有向这台开放什么。</p>
        </template>
      </div>
    </template>

    <h2 class="section-title">和别人的 omem 共享</h2>
    <HelpText>给别人的 omem 服务开放几个空间：对方只能检索、读这些空间里你选的内容，或者把它们同步过去。它用自己的服务账号，看不到别的空间和你的个人空间；随时可以停止。</HelpText>

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
      <template v-if="!a.disabled">
        <div class="row wrap small grant">
          <span title="对方的助手可以用 ask_agent 向这里的 Agent 提问：它在这台上运行、用这台的 AI，只读共享给对方的空间（空间里的全部内容，不按上面的内容类型过滤），回答里带引用">可以请教的 Agent</span>
          <UiSelect multiple :model-value="askable(a)" size="sm" width="240px" placeholder="不开放" aria-label="可以请教的 Agent" :options="agentNames" @change="(v) => saveGrants(a, { agents: v as string[] })" />
          <label v-if="askable(a).length" class="row muted">每个每天最多<input class="input sm num" type="number" inputmode="numeric" min="1" :value="askDaily(a) ?? ''" placeholder="不限" aria-label="每个 Agent 每天最多被请教几次" @change="saveGrants(a, { daily: Number(($event.target as HTMLInputElement).value) > 0 ? Math.round(Number(($event.target as HTMLInputElement).value)) : null })" />次</label>
        </div>
        <UiCheckbox :model-value="showsAssistants(a)" size="sm" @change="(v) => saveGrants(a, { assistants: v })">让对方看到这台上有哪些助手（名字、是谁的、做什么）</UiCheckbox>
      </template>
    </div>

    <h2 class="section-title">关注别人共享的空间</h2>
    <HelpText>先把对方给的配对码加到上面的设备里。关注后，检索和助手能查到这些空间（助手引用时先把原件取到本机）；“同步”的空间每半小时同步到本机一个只读空间。</HelpText>
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
.grant {
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}
.num {
  width: 72px;
  margin: 0 6px;
}
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
