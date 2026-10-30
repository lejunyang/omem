<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { del, get, patch, post } from "../api";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";
import { fmtTime, toast } from "../store";
import { confirmDialog, promptDialog } from "../lib/dialog";

/**
 * Settings → 设备 (src/core/peers.ts): other machines running omem. Pairing both ways, which
 * devices hold a token of this one, and which of a device's ACP agents to use here
 * (src/core/peer-acp.ts: the agent runs there, its tools stay here).
 */
type Peer = { id: string; url: string; urls: string[]; via: string | null; addedAt: string };
type Paired = { id: string; label: string; createdAt: string; lastUsedAt: string | null };
type UsedAgent = { id: string; name: string; peer: string; agent: string };
type View = { node: string; urls: string[]; peers: Peer[]; paired: Paired[]; agents: UsedAgent[] };
type Status = { online: boolean; ms?: number; version?: string | null; error?: string; agents: { id: string; name: string }[] };

const view = ref<View | null>(null);
const status = reactive<Record<string, Status | "loading">>({});
const inviteForm = ref({ label: "", url: "" });
const code = ref("");
const addForm = ref({ code: "", via: "", url: "" });
const adding = ref(false);
const viaOptions = computed(() => [{ value: "", label: "直接连接" }, ...(view.value?.peers ?? []).filter((p) => !p.via).map((p) => ({ value: p.id, label: `经 ${p.id} 转发` }))]);

const fail = (e: unknown) => toast((e as Error).message, "error");
async function load() {
  view.value = await get<View>("/api/peers");
  for (const p of view.value.peers) if (!status[p.id]) void check(p.id);
}
async function check(id: string) {
  status[id] = "loading";
  status[id] = await get<Status>(`/api/peers/${encodeURIComponent(id)}/status`).catch((e: Error) => ({ online: false, error: e.message, agents: [] }));
}
const st = (id: string) => (typeof status[id] === "object" ? (status[id] as Status) : null);
const used = (peer: string, agent: string) => !!view.value?.agents.some((a) => a.peer === peer && a.agent === agent);

async function makeInvite() {
  try {
    const r = await post<{ code: string }>("/api/peer/invite", { label: inviteForm.value.label.trim() || undefined, url: inviteForm.value.url.trim() || undefined });
    code.value = r.code;
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
async function add() {
  adding.value = true;
  try {
    const r = await post<View & { id: string; online: boolean; error: string | null }>("/api/peer/add", { code: addForm.value.code.trim(), via: addForm.value.via || undefined, url: addForm.value.url.trim() || undefined });
    view.value = r;
    addForm.value = { code: "", via: "", url: "" };
    toast(r.online ? `已添加 ${r.id}，连接正常` : `已添加 ${r.id}，但现在连不上：${r.error}`, r.online ? "ok" : "error");
    void check(r.id);
  } catch (e) {
    fail(e);
  } finally {
    adding.value = false;
  }
}
async function changeUrl(p: Peer) {
  const url = await promptDialog(`${p.id} 的新地址`, { message: "它换了地址、已知的都连不上时用。改成直接连接。", value: p.url, placeholder: "http://192.168.1.20:4317" });
  if (!url) return;
  try {
    view.value = await patch<View>(`/api/peers/${encodeURIComponent(p.id)}`, { url: url.trim() });
    void check(p.id);
  } catch (e) {
    fail(e);
  }
}
async function remove(p: Peer) {
  const n = view.value?.agents.filter((a) => a.peer === p.id).length ?? 0;
  if (!(await confirmDialog(`移除设备 ${p.id}？`, { message: `本机删掉它的地址和令牌${p.via ? "" : "，并请它撤销给本机的令牌（它在线时）"}${n ? `；本机用它的 ${n} 个 Agent 一并删除，用到它们的角色改回默认` : ""}。之后要用得重新配对。`, okText: "移除", danger: true }))) return;
  try {
    const r = await del<View & { revoked: boolean }>(`/api/peers/${encodeURIComponent(p.id)}`);
    view.value = r;
    delete status[p.id];
    toast(r.revoked || p.via ? "已移除" : "已移除；对方没有确认撤销令牌，在那台机器的“设备”页撤销", r.revoked || p.via ? "ok" : "error");
  } catch (e) {
    fail(e);
  }
}
async function toggleAgent(peer: string, agent: { id: string; name: string }, use: boolean) {
  try {
    view.value = await post<View>("/api/peer/agents", { peer, agent: agent.id, name: agent.name, use });
    toast(use ? `已加入 Agent 列表：设置 → Agent 和 Agent 页可以选它` : "已从 Agent 列表移除", "ok");
  } catch (e) {
    fail(e);
  }
}
async function revoke(t: Paired) {
  if (!(await confirmDialog(`撤销配对令牌 ${t.label}？`, { message: "拿着它的设备立刻不能再访问本机：看网页、拉数据、远程命令、用本机的 Agent 都会失败。要恢复得重新配对。", okText: "撤销", danger: true }))) return;
  try {
    view.value = await del<View>(`/api/peer/paired/${t.id}`);
    toast("已撤销", "ok");
  } catch (e) {
    fail(e);
  }
}
onMounted(() => load().catch(fail));
</script>

<template>
  <div class="stack">
    <p class="muted">设备是其他运行 omem 的机器：配对后可以看它的网页、拉它的数据、执行检查命令，也可以把它的 Agent 当成本机的来用（Agent 在它那里运行，用它的登录和额度；读写的始终是本机的库）。</p>
    <Skeleton v-if="!view" variant="text" :rows="5" />
    <template v-else>
      <div class="card pad stack">
        <div class="section-title">本机</div>
        <div class="small">名字 <span class="mono">{{ view.node }}</span><span class="muted"> · 地址 </span><span class="mono addr">{{ view.urls.join("  ") || "只监听本机，其他设备连不上" }}</span></div>
        <div class="row wrap">
          <input v-model="inviteForm.label" class="input" placeholder="对方的名字（撤销时认它）" aria-label="对方的名字" style="width: 220px" />
          <input v-model="inviteForm.url" class="input grow" placeholder="对方访问本机的地址（可选，默认用上面的全部）" aria-label="对方访问本机的地址" />
          <button class="btn sm" @click="makeInvite">生成配对码</button>
        </div>
        <div v-if="code" class="stack code-box">
          <div class="row"><span class="small grow">在另一台机器的“设备”页粘贴，或运行 <span class="mono">omem peer add &lt;配对码&gt;</span></span><button class="btn ghost sm" @click="copy(code)">复制</button></div>
          <div class="mono small code">{{ code }}</div>
          <div class="muted small">配对码里有本人权限的令牌：只交给自己的设备，别发到群里。用不上了在下面“持有本机令牌的设备”里撤销。</div>
        </div>
      </div>

      <div class="card pad stack">
        <div class="section-title">添加设备</div>
        <textarea v-model="addForm.code" class="textarea mono" rows="2" placeholder="对方生成的配对码（omem1. 开头）" aria-label="配对码" />
        <div class="row wrap">
          <UiSelect v-model="addForm.via" size="sm" width="180px" aria-label="怎么连" :options="viaOptions" />
          <input v-if="!addForm.via" v-model="addForm.url" class="input grow" placeholder="用这个地址（可选，默认试配对码里的全部）" aria-label="对方的地址" />
          <span v-else class="muted small grow">本机连不到它时，由 {{ addForm.via }} 转发（{{ addForm.via }} 要先和它配对，名字相同）</span>
          <button class="btn sm primary" :disabled="adding || !addForm.code.trim()" @click="add">{{ adding ? "连接中…" : "添加" }}</button>
        </div>
      </div>

      <div class="row"><strong class="grow">已添加的设备</strong><button v-if="view.peers.length" class="btn ghost sm" @click="view.peers.forEach((p) => check(p.id))">全部检查</button></div>
      <div v-if="!view.peers.length" class="card pad muted">还没有。在另一台机器的“设备”页生成配对码，粘贴到上面。</div>
      <div v-for="p in view.peers" :key="p.id" class="card pad stack peer">
        <div class="row wrap head">
          <strong class="mono">{{ p.id }}</strong>
          <span class="muted small addr">{{ p.via ? `经 ${p.via}` : p.url }}<template v-if="!p.via && p.urls.length > 1">（备用 {{ p.urls.length - 1 }} 个地址）</template></span>
          <span class="spacer" />
          <span v-if="status[p.id] === 'loading'" class="badge">检查中</span>
          <span v-else-if="st(p.id)?.online" class="badge ok">在线 · {{ st(p.id)!.ms }} ms</span>
          <span v-else-if="st(p.id)" class="badge danger">连不上</span>
          <button class="btn ghost sm" @click="check(p.id)">检查</button>
          <button v-if="!p.via" class="btn ghost sm" @click="changeUrl(p)">改地址</button>
          <button class="btn ghost sm danger" @click="remove(p)">移除</button>
        </div>
        <div class="muted small meta">
          <span>{{ fmtTime(p.addedAt) }} 添加</span>
          <span v-if="st(p.id)?.version" class="addr">版本 {{ st(p.id)!.version }}</span>
          <span v-if="st(p.id) && !st(p.id)!.online" class="addr">{{ st(p.id)!.error }}</span>
        </div>
        <div v-if="st(p.id)?.agents.length" class="stack agents">
          <div class="small">它的 Agent：打开的会出现在本机的 Agent 列表里，可以分给角色、档案和规则</div>
          <UiCheckbox v-for="a in st(p.id)!.agents" :key="a.id" :model-value="used(p.id, a.id)" switch size="sm" @change="(v) => toggleAgent(p.id, a, v)">{{ a.name }}</UiCheckbox>
          <div class="muted small">它在那台机器的空目录里运行，看不到本机的文件：适合问答、调查、整理和写作，不要用来交办编码。那台机器（和中间转发的机器）要更新到支持远程 Agent 的版本。</div>
        </div>
        <template v-for="a in view.agents.filter((x) => x.peer === p.id && !st(p.id)?.agents.some((y) => y.id === x.agent))" :key="a.id">
          <UiCheckbox :model-value="true" switch size="sm" @change="() => toggleAgent(p.id, { id: a.agent, name: a.name }, false)">{{ a.name }}<span class="muted">（现在没看到它）</span></UiCheckbox>
        </template>
      </div>

      <div class="row"><strong class="grow">持有本机令牌的设备</strong></div>
      <div v-if="!view.paired.length" class="card pad muted">没有。生成的配对码被添加后，对方就拿着一个令牌。</div>
      <div v-for="t in view.paired" :key="t.id" class="card pad row wrap">
        <span class="mono">{{ t.label }}</span>
        <span class="muted small">{{ fmtTime(t.createdAt) }} 生成 · {{ t.lastUsedAt ? `最近使用 ${fmtTime(t.lastUsedAt)}` : "还没用过" }}</span>
        <span class="spacer" />
        <button class="btn ghost sm danger" @click="revoke(t)">撤销</button>
      </div>
      <p class="muted small">设备之间用 HTTP 直连，令牌有本人的全部权限、不会过期：只在自己的局域网或 VPN 里配对；不再用的设备在这里撤销。</p>
    </template>
  </div>
</template>

<style scoped>
.head,
.meta {
  gap: 4px 12px;
  min-width: 0;
}
.meta {
  display: flex;
  flex-wrap: wrap;
}
.addr,
.code {
  overflow-wrap: anywhere;
  min-width: 0;
}
.code-box {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.code {
  user-select: all;
}
.agents {
  gap: 6px;
}
</style>
