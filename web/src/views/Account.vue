<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { del, get, logout, patch, post, put } from "../api";
import UiSelect from "../components/UiSelect.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import Skeleton from "../components/Skeleton.vue";
import { fmtTime, state, toast } from "../store";
import { confirmDialog } from "../lib/dialog";

/**
 * One's own account (src/auth): who I am, the providers I can log in with (binding another one),
 * where I am logged in (signing a device out). Everyone has this page; the owner manages the others
 * in 设置 → 成员.
 */
type Identity = { channel: string; externalId: string; kind: "login" | "alias"; display: string; appId: string | null; provider: string; createdAt: string; verifiedAt: string | null };
type Session = { id: string; via: string; restricted: boolean; createdAt: string; lastSeenAt: string; ip: string; userAgent: string; current: boolean };
type Provider = { id: string; label: string; unavailable: string | null; primary: boolean };
type Account = {
  user: { id: string; name: string; role: string; status: string; email: string | null; avatar: string | null; loginAny: boolean };
  via: "local" | "token" | "session";
  restricted: boolean;
  identities: Identity[];
  sessions: Session[];
  providers: Provider[];
  ownerSeesPersonal: boolean;
};

const route = useRoute();
const acc = ref<Account | null>(null);
// Spaces this person manages (space.manage): their members, by user id. The owner does this in 设置 → 成员.
type Member = { id: string; name: string; spaceRole: string };
const managed = computed(() => (state.me && state.me.role !== "owner" ? state.spaces.filter((s) => s.kind !== "personal" && (state.me!.manages ?? []).includes(s.id)) : []));
const members = ref<Record<string, Member[]>>({});
const spaceRoles = ref<{ id: string; name: string }[]>([]);
const addForm = ref<Record<string, { user: string; role: string }>>({});
async function loadManaged() {
  if (!managed.value.length) return;
  const r = await get<{ roles: { id: string; name: string; scope: string }[] }>("/api/access/roles");
  spaceRoles.value = r.roles.filter((x) => x.scope === "space");
  for (const s of managed.value) {
    members.value[s.id] = await get<Member[]>(`/api/spaces/${s.id}/members`);
    addForm.value[s.id] ??= { user: "", role: "reader" };
  }
}
/** A space's Feishu documents shown in full only to those Feishu lets read them (src/auth/visibility.ts). */
async function setLarkAccess(space: string, on: boolean) {
  try {
    await patch(`/api/spaces/${space}`, { settings: { larkAccess: on } });
    const s = state.spaces.find((x) => x.id === space);
    if (s) s.settings = { ...s.settings, larkAccess: on };
    toast(on ? "已打开：飞书文档要各人在飞书里有权限才能看全文" : "已关闭：空间成员都能看", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
// Who I am arrives with the frame (App.vue): load once it is known.
watch(() => managed.value.map((s) => s.id).join(), () => void loadManaged().catch((e) => toast((e as Error).message, "error")));
async function setMember(space: string, user: string, role: string | null) {
  try {
    await put(`/api/spaces/${space}/members/${encodeURIComponent(user)}`, { role });
    members.value[space] = await get<Member[]>(`/api/spaces/${space}/members`);
    if (addForm.value[space]) addForm.value[space].user = "";
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const notice = computed(() =>
  typeof route.query.error === "string" ? { kind: "err", text: route.query.error } : typeof route.query.connected === "string" ? { kind: "ok", text: "已连接，新授权的权限已生效" } : typeof route.query.bound === "string" ? { kind: "ok", text: "已绑定" } : null,
);
// Connected platforms (src/auth/connections.ts): features turned on one at a time (an incremental authorization each).
type Feature = { id: string; label: string; description: string; on?: boolean; paused?: boolean };
type Conn = { id: string; provider: string; label: string; accountName: string; status: "active" | "expired" | "error"; scopes: string[]; features: Feature[]; background: boolean; lastError: string | null; updatedAt: string };
type KeyField = { key: string; label: string; secret: boolean; optional: boolean; hint: string };
type Available = { id: string; label: string; unavailable: string | null; group: string; docs: string; identity: boolean; credentials: KeyField[] | null; features: Feature[] };
type Connections = { connections: Conn[]; available: Available[]; may: boolean };
const conns = ref<Connections | null>(null);
const picked = ref<Record<string, string[]>>({});
// A call ran into a missing scope (a link from a notification): ask for just that one.
const askScopes = computed(() => (route.query.connect === "lark" && typeof route.query.scopes === "string" ? route.query.scopes : ""));
// The owner reads and writes Feishu through lark-cli's own login (设置 → 渠道), not a connection here.
const connQuery = ref("");
const offeredProviders = computed(() => (conns.value?.available ?? []).filter((p) => !(state.me?.role === "owner" && p.id === "lark")));
// Connected ones first; a search box once there are more than a few.
const shownProviders = computed(() => {
  const q = connQuery.value.trim().toLowerCase();
  return offeredProviders.value
    .filter((p) => !q || p.label.toLowerCase().includes(q) || p.id.includes(q) || p.group.includes(q))
    .sort((a, b) => Number(!!connOf(b.id)) - Number(!!connOf(a.id)));
});
const keyDraft = ref<Record<string, Record<string, string>>>({});
async function connectKey(p: Available) {
  try {
    conns.value = { ...conns.value!, ...(await post<{ connections: Conn[] }>(`/api/auth/connections/${p.id}/credentials`, { values: keyDraft.value[p.id] ?? {} })) };
    keyDraft.value[p.id] = {};
    toast(`已连接${p.label}`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const connOf = (provider: string) => conns.value?.connections.find((c) => c.provider === provider) ?? null;
// Things kept in sync from connected platforms (src/plugins/platforms.ts): set up by asking an agent, listed and removed here.
type Watch = { id: string; provider: string; kind: string; target: string; title: string; spaceId: string; lastRunAt: string | null; lastError: string | null };
const watches = ref<Watch[]>([]);
const watchesOf = (provider: string) => watches.value.filter((w) => w.provider === provider);
async function syncWatch(w: Watch) {
  try {
    watches.value = (await post<{ watches: Watch[] }>(`/api/auth/watches/${w.id}/sync`)).watches;
    toast("已同步", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function dropWatch(w: Watch) {
  if (!(await confirmDialog(`不再同步“${w.title || w.target}”？`, { message: "已经存下的原件保留。", okText: "不再同步" }))) return;
  watches.value = (await del<{ watches: Watch[] }>(`/api/auth/watches/${w.id}`)).watches;
}
async function loadConnections() {
  conns.value = await get<Connections>("/api/auth/connections");
  watches.value = (await get<{ watches: Watch[] }>("/api/auth/watches").catch(() => ({ watches: [] }))).watches;
  // A platform with one thing to turn on has it chosen already.
  for (const a of conns.value.available) {
    picked.value[a.id] ??= a.features.length === 1 ? [a.features[0].id] : [];
    keyDraft.value[a.id] ??= {};
  }
}
/** Turn a granted feature off in omem or back on; Feishu keeps the grant either way. */
async function useFeature(provider: string, f: Feature, on: boolean) {
  try {
    conns.value = { ...conns.value!, ...(await put<{ connections: Conn[] }>(`/api/auth/connections/${provider}/features/${f.id}`, { on })) };
    toast(on ? `omem 会用「${f.label}」` : `omem 不再用「${f.label}」；飞书那边的授权还在`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
function connect(provider: string, features: string[], scopes = "") {
  const q = new URLSearchParams({ purpose: "connect" });
  if (features.length) q.set("features", features.join(","));
  if (scopes) q.set("scopes", scopes);
  location.href = `/api/auth/${provider}/start?${q}`;
}
async function disconnectProvider(c: Conn) {
  if (!(await confirmDialog(`断开${c.label}连接？`, { message: "omem 不再以你的身份读写，已经保存的内容保留。之后要用再连接。", okText: "断开", danger: true }))) return;
  try {
    await del(`/api/auth/connections/${c.provider}`);
    await loadConnections();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const VIA: Record<string, string> = { lark: "飞书", link: "机器人登录链接", invite: "邀请", local: "本机", token: "令牌" };
const viaLabel = (v: string) => VIA[v] ?? acc.value?.providers.find((p) => p.id === v)?.label ?? v;
const logins = computed(() => (acc.value?.identities ?? []).filter((i) => i.kind === "login"));
const aliases = computed(() => (acc.value?.identities ?? []).filter((i) => i.kind === "alias"));
const bound = (p: Provider) => logins.value.some((i) => i.provider === p.label);
const device = (ua: string) => {
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  const app = /Lark|Feishu/.test(ua) ? "飞书" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [app, os].filter(Boolean).join(" · ") || "浏览器";
};

async function load() {
  acc.value = await get<Account>("/api/auth/account");
}
function bind(p: Provider) {
  location.href = `/api/auth/${p.id}/start?purpose=bind`;
}
async function unbind(i: Identity) {
  if (!(await confirmDialog(`解绑${i.provider}账号？`, { message: `${i.display || i.externalId} 之后不能再用来登录这个账号。`, okText: "解绑", danger: true }))) return;
  try {
    await del("/api/auth/identities", { channel: i.channel, externalId: i.externalId });
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function signOut(s: Session) {
  if (s.current) return logout();
  try {
    await del(`/api/auth/sessions/${s.id}`);
    await load();
    toast("已让那台设备退出", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
onMounted(() => Promise.all([load(), loadManaged(), loadConnections()]).catch((e) => toast((e as Error).message, "error")));
</script>

<template>
  <div class="page stack" style="max-width: 760px">
    <div class="page-head"><div><h1>账号</h1><p>登录方式和登录过的设备。</p></div></div>
    <div v-if="notice" class="card pad small" :class="notice.kind === 'err' ? 'err' : 'ok'">{{ notice.text }}</div>
    <Skeleton v-if="!acc" variant="text" :rows="6" />
    <template v-else>
      <div class="card pad row who">
        <img v-if="acc.user.avatar" :src="acc.user.avatar" alt="" class="avatar" referrerpolicy="no-referrer" />
        <div class="stack tight">
          <strong>{{ acc.user.name }}</strong>
          <span class="muted small">{{ acc.user.id }}{{ acc.user.email ? ` · ${acc.user.email}` : "" }} · {{ acc.user.role === "owner" ? "omem 的主人" : "成员" }}</span>
          <span class="muted small">这次是{{ viaLabel(acc.via) }}{{ acc.via === "session" ? "登录" : "访问" }}</span>
        </div>
        <span class="spacer" />
        <button v-if="acc.via === 'session' || acc.via === 'token'" class="btn sm" @click="logout">退出登录</button>
      </div>
      <p v-if="acc.ownerSeesPersonal" class="muted small">omem 的主人能看到所有空间，包括你的个人空间。</p>

      <h2 class="section-title">登录方式</h2>
      <div class="list">
        <div v-for="p in acc.providers" :key="p.id" class="card pad row wrap">
          <strong>{{ p.label }}</strong>
          <span v-if="p.primary" class="badge accent">主要登录方</span>
          <span class="spacer" />
          <template v-if="bound(p)">
            <span v-for="i in logins.filter((x) => x.provider === p.label)" :key="i.externalId" class="row tight-row">
              <span class="muted small">{{ i.display || i.externalId }}</span>
              <button v-if="!p.primary || acc.user.role === 'owner'" class="btn ghost sm danger" @click="unbind(i)">解绑</button>
            </span>
          </template>
          <button v-else class="btn sm" :disabled="!!p.unavailable" :title="p.unavailable ?? ''" @click="bind(p)">绑定</button>
        </div>
        <p v-if="!acc.providers.length" class="muted small">还没有打开任何登录方式。</p>
      </div>
      <p v-if="aliases.length" class="muted small">渠道里的身份（机器人靠它认出你）：{{ aliases.map((a) => `${a.provider} ${a.externalId}`).join("、") }}</p>

      <h2 class="section-title">已连接的应用</h2>
      <div v-if="askScopes" class="card pad stack warn-box">
        <strong>需要补一项飞书权限</strong>
        <p class="small">助手刚才以你的身份用飞书时缺少权限：<span class="mono">{{ askScopes }}</span>。授权后再让助手试一次。</p>
        <div class="row"><button class="btn sm primary" @click="connect('lark', [], askScopes)">去飞书授权</button></div>
      </div>
      <p class="muted small">连接后，助手和后台采集以你的身份读你在这个平台上能看到的内容；写入（文档、表格）不在你自己的文件里时先问你。令牌只存在运行 omem 的这台机器上。</p>
      <div v-if="conns && !conns.may" class="card pad muted small">你的角色不能连接第三方平台，需要的话请 omem 的主人调整。</div>
      <p v-if="state.me?.role === 'owner'" class="muted small">你本人用 lark-cli 的登录读写飞书（设置 → 渠道），不用在这里连接。可以连接的其他平台在 设置 → 成员 → 平台应用 里开放。</p>
      <input v-if="offeredProviders.length > 6" v-model="connQuery" class="input" type="search" placeholder="搜平台" aria-label="搜可以连接的平台" />
      <div v-for="p in shownProviders" :key="p.id" class="card pad stack">
        <div class="row wrap">
          <strong>{{ p.label }}</strong>
          <template v-if="connOf(p.id)">
            <span class="muted small">{{ connOf(p.id)!.accountName }}</span>
            <span v-if="connOf(p.id)!.status !== 'active'" class="badge danger">需要重新授权</span>
            <span v-else-if="!connOf(p.id)!.background" class="badge warn">只在你在线时可用</span>
          </template>
          <span class="spacer" />
          <button v-if="connOf(p.id) && connOf(p.id)!.status !== 'active' && !p.credentials" class="btn sm primary" @click="connect(p.id, connOf(p.id)!.features.filter((f) => f.on).map((f) => f.id))">重新授权</button>
          <button v-if="connOf(p.id)" class="btn ghost sm danger" @click="disconnectProvider(connOf(p.id)!)">断开</button>
        </div>
        <p v-if="p.unavailable" class="small warn-text">暂时不能用：{{ p.unavailable }}</p>
        <template v-if="p.credentials">
          <p v-if="!connOf(p.id)" class="muted small">在{{ p.label }}里生成一个 key 填在这里，omem 先用它试一次再保存。<a v-if="p.docs" :href="p.docs" target="_blank" rel="noopener noreferrer">怎么生成</a></p>
          <template v-if="!connOf(p.id) || connOf(p.id)!.status !== 'active'">
            <label v-for="f in p.credentials" :key="f.key" class="field">
              <span>{{ f.label }}<span v-if="f.optional" class="muted">（可不填）</span></span>
              <input v-model="keyDraft[p.id][f.key]" class="input" :type="f.secret ? 'password' : 'text'" autocomplete="off" />
              <span v-if="f.hint" class="hint">{{ f.hint }}</span>
            </label>
            <div class="row"><button class="btn sm primary" :disabled="!conns?.may || !!p.unavailable" @click="connectKey(p)">连接{{ p.label }}</button></div>
          </template>
        </template>
        <div v-else class="features">
          <div v-for="f in connOf(p.id)?.features ?? p.features" :key="f.id" class="row wrap feature">
            <div class="stack tight">
              <span>{{ f.label }}</span>
              <span class="muted small">{{ f.description }}</span>
            </div>
            <span class="spacer" />
            <template v-if="f.on && f.id !== 'offline'">
              <span v-if="f.paused" class="badge">已在 omem 里关掉</span>
              <UiCheckbox :model-value="!f.paused" switch size="sm" :aria-label="`omem 使用${f.label}`" @change="(v) => useFeature(p.id, f, v)" />
            </template>
            <span v-else-if="f.on" class="badge accent">已打开</span>
            <button v-else-if="connOf(p.id)" class="btn sm" :disabled="!conns?.may || !!p.unavailable" @click="connect(p.id, [f.id])">打开</button>
            <UiCheckbox v-else v-model="picked[p.id]" :value="f.id" size="sm" :aria-label="f.label" />
          </div>
        </div>
        <p v-if="connOf(p.id) && !p.credentials" class="muted small">关掉的功能 omem 不再使用，{{ p.label }}那边的授权还在；要连授权一起撤销，在{{ p.label }}里取消对这个应用的授权。</p>
        <div v-if="!connOf(p.id) && !p.credentials" class="row"><button class="btn sm primary" :disabled="!conns?.may || !!p.unavailable || !(picked[p.id] ?? []).length" @click="connect(p.id, picked[p.id] ?? [])">连接{{ p.label }}</button></div>
        <p v-if="connOf(p.id)?.lastError" class="small warn-text">{{ connOf(p.id)!.lastError }}</p>
        <div v-if="watchesOf(p.id).length" class="stack tight">
          <span class="small muted">定时同步（在“平台采集”里让助手盯着某个文件、页面或仓库）：</span>
          <div v-for="w in watchesOf(p.id)" :key="w.id" class="row wrap feature">
            <div class="stack tight">
              <span>{{ w.title || w.target }}</span>
              <span class="muted small">{{ w.kind }} {{ w.target }} → 空间 {{ w.spaceId }} · {{ w.lastRunAt ? `上次 ${fmtTime(w.lastRunAt)}` : "还没同步" }}</span>
              <span v-if="w.lastError" class="small warn-text">{{ w.lastError }}</span>
            </div>
            <span class="spacer" />
            <button class="btn ghost sm" @click="syncWatch(w)">立即同步</button>
            <button class="btn ghost sm danger" @click="dropWatch(w)">不再同步</button>
          </div>
        </div>
      </div>
      <p v-if="conns && !shownProviders.length && state.me?.role !== 'owner'" class="muted small">omem 还没有可以连接的平台。</p>

      <h2 class="section-title">登录的设备</h2>
      <div v-if="!acc.sessions.length" class="card pad muted small">{{ acc.via === "local" ? "你在运行 omem 的这台机器上，不用登录。" : "没有登录的设备。" }}</div>
      <div v-else class="list">
        <div v-for="s in acc.sessions" :key="s.id" class="card pad row wrap">
          <div class="stack tight">
            <strong>{{ device(s.userAgent) }}<span v-if="s.current" class="badge">这台</span></strong>
            <span class="muted small">{{ viaLabel(s.via) }}登录 · {{ fmtTime(s.createdAt) }} · 最近 {{ fmtTime(s.lastSeenAt) }}{{ s.ip ? ` · ${s.ip}` : "" }}</span>
          </div>
          <span class="spacer" />
          <button class="btn ghost sm" @click="signOut(s)">{{ s.current ? "退出登录" : "让它退出" }}</button>
        </div>
      </div>
      <template v-if="managed.length">
        <h2 class="section-title">我管理的空间</h2>
        <div v-for="sp in managed" :key="sp.id" class="card pad stack">
          <div class="row wrap">
            <strong>{{ sp.name }}</strong>
            <span class="spacer" />
            <UiCheckbox :model-value="!!sp.settings?.larkAccess" size="sm" @change="(v) => setLarkAccess(sp.id, v)">飞书文档按各人的飞书权限显示</UiCheckbox>
          </div>
          <div v-for="m in members[sp.id] ?? []" :key="m.id" class="row wrap member">
            <span>{{ m.name }} <span class="muted small mono">{{ m.id }}</span></span>
            <span class="spacer" />
            <span v-if="m.id === acc.user.id" class="badge">{{ spaceRoles.find((r) => r.id === m.spaceRole)?.name ?? m.spaceRole }}（你）</span>
            <template v-else>
              <UiSelect :model-value="m.spaceRole" size="sm" width="110px" :aria-label="`${m.name}的角色`" :options="spaceRoles.map((r) => ({ value: r.id, label: r.name }))" @change="(v) => setMember(sp.id, m.id, v)" />
              <button class="btn ghost sm danger" @click="setMember(sp.id, m.id, null)">移出</button>
            </template>
          </div>
          <div v-if="addForm[sp.id]" class="row wrap">
            <input v-model="addForm[sp.id].user" class="input" placeholder="对方的用户 id（他的账号页能看到）" />
            <UiSelect v-model="addForm[sp.id].role" size="sm" width="110px" aria-label="空间角色" :options="spaceRoles.map((r) => ({ value: r.id, label: r.name }))" />
            <button class="btn sm" :disabled="!addForm[sp.id].user.trim()" @click="setMember(sp.id, addForm[sp.id].user.trim(), addForm[sp.id].role)">加入</button>
          </div>
        </div>
      </template>
      <p v-if="acc.user.role === 'owner'" class="muted small">管理其他人：<router-link to="/settings?tab=members">设置 → 成员</router-link></p>
    </template>
  </div>
</template>

<style scoped>
.who {
  gap: 14px;
  min-width: 0;
}
.who .stack {
  min-width: 0;
  overflow-wrap: anywhere;
}
.avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  flex: none;
}
.tight {
  gap: 2px;
}
.tight-row {
  gap: 6px;
  min-width: 0;
}
.list {
  display: grid;
  gap: 8px;
}
.list .card {
  gap: 8px;
  min-width: 0;
}
.err {
  color: var(--danger);
}
.ok {
  color: var(--ok);
}
.badge {
  margin-left: 6px;
}
.features {
  display: grid;
  gap: 6px;
}
.feature {
  border-top: 1px solid var(--line);
  padding-top: 6px;
  gap: 8px;
  min-width: 0;
}
.member {
  border-top: 1px solid var(--line);
  padding-top: 6px;
  gap: 8px;
  min-width: 0;
}
.input {
  flex: 1;
  min-width: 180px;
}
</style>
