<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { del, get, patch, post, put } from "../api";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { fmtTime, state, toast } from "../store";
import { confirmDialog } from "../lib/dialog";

/**
 * Settings → 成员 (src/auth, docs/v2/multi-user.md): whether other people can log in and with what,
 * who is waiting for approval, everyone's role, logins and spaces, invite links, roles and what
 * changed. This machine and the owner's paired devices never need to log in.
 */
type Auth = { enabled: boolean; providers: string[]; primary: string | null; signup: Record<string, "approve" | "closed" | "open">; sessionDays: number };
type Provider = { id: string; label: string; unavailable: string | null; callback: string };
type Identity = { channel: string; externalId: string; kind: "login" | "alias"; display: string; provider: string };
type User = { id: string; name: string; role: string; status: "active" | "pending"; email: string | null; avatar: string | null; loginAny: boolean; disabledAt: string | null; createdAt: string; lastSeenAt: string | null; identities: Identity[]; spaces: { space: string; name: string; role: string }[] };
type Invite = { id: string; role: string; spaces: { space: string; role: string }[]; allowAny: boolean; note: string; createdAt: string; expiresAt: string; usedBy: string | null; usedAt: string | null; revokedAt: string | null };
type Role = { id: string; name: string; scope: "global" | "space"; description: string; permissions: string[]; builtin: boolean };
type Roles = { roles: Role[]; global: Record<string, string>; space: Record<string, string> };
type Audit = { id: number; at: string; actor: string; action: string; target: string; detail: Record<string, unknown> };

const auth = ref<Auth | null>(null);
const webUrl = ref("");
const providers = ref<Provider[]>([]);
const users = ref<User[] | null>(null);
const invites = ref<Invite[]>([]);
const roles = ref<Roles | null>(null);
const log = ref<Audit[]>([]);
const showLog = ref(false);
const form = ref({ role: "member", spaces: [] as { space: string; role: string }[], allowAny: false, note: "", days: "7" });
const made = ref<string | null>(null);
const adding = ref<Record<string, string>>({});
const draft = ref<{ id?: string; name: string; scope: "global" | "space"; description: string; permissions: string[] } | null>(null);

const pending = computed(() => (users.value ?? []).filter((u) => u.status === "pending" && !u.disabledAt));
const others = computed(() => (users.value ?? []).filter((u) => u.status !== "pending" || u.disabledAt));
const label = (id: string) => providers.value.find((p) => p.id === id)?.label ?? id;
const spaceOptions = computed(() => state.spaces.filter((s) => s.kind !== "personal").map((s) => ({ value: s.id, label: s.name })));
const globalRoles = computed(() => (roles.value?.roles ?? []).filter((r) => r.scope === "global" && r.id !== "owner"));
const spaceRoles = computed(() => (roles.value?.roles ?? []).filter((r) => r.scope === "space"));
const roleName = (id: string) => (id === "owner" && "主人") || roles.value?.roles.find((r) => r.id === (id === "owner" ? "manager" : id))?.name || id;
const permLabel = (p: string) => {
  const [name, all] = p.split("@");
  const text = roles.value?.global[name] ?? roles.value?.space[name] ?? name;
  return all ? `${text}（所有空间）` : text;
};
// A global role can hold its own permissions and space permissions in every space.
const permChoices = (scope: "global" | "space") =>
  scope === "space" ? Object.keys(roles.value?.space ?? {}) : [...Object.keys(roles.value?.global ?? {}), ...Object.keys(roles.value?.space ?? {}).map((p) => `${p}@*`)];
const SIGNUP = [
  { value: "approve", label: "等批准" },
  { value: "open", label: "直接进入" },
  { value: "closed", label: "只认邀请" },
];
const ACTIONS: Record<string, string> = {
  "user.approve": "批准", "user.role": "改全局角色", "user.disable": "停用", "user.enable": "启用", "user.login-any": "改登录方式", "user.sign-out": "让所有设备退出",
  "identity.unlink": "解绑身份", "space.member": "设置空间角色", "space.remove": "移出空间", "role.save": "保存角色", "role.delete": "删除角色", "invite.create": "生成邀请", "invite.revoke": "撤销邀请",
};

async function load() {
  const [s, p, u, i, r] = await Promise.all([get<{ config: { auth: Auth; webUrl?: string } }>("/api/settings"), get<Provider[]>("/api/auth/providers"), get<User[]>("/api/users"), get<Invite[]>("/api/invites"), get<Roles>("/api/access/roles")]);
  auth.value = s.config.auth;
  webUrl.value = s.config.webUrl ?? "";
  providers.value = p;
  users.value = u;
  invites.value = i;
  roles.value = r;
  if (showLog.value) log.value = await get<Audit[]>("/api/access/audit");
}
const fail = (e: unknown) => toast((e as Error).message, "error");
async function saveAuth(next: Partial<Auth>) {
  try {
    const r = await put<{ config: { auth: Auth } }>("/api/settings", { auth: { ...auth.value!, ...next } });
    auth.value = r.config.auth;
    toast("已保存", "ok");
  } catch (e) {
    fail(e);
  }
}
function toggleProvider(id: string, on: boolean) {
  const list = on ? [...new Set([...auth.value!.providers, id])] : auth.value!.providers.filter((p) => p !== id);
  void saveAuth({ providers: list, primary: auth.value!.primary && !list.includes(auth.value!.primary) ? null : auth.value!.primary });
}
async function setPrimary(id: string) {
  const primary = id || null;
  if (primary && !(await confirmDialog(`把${label(primary)}设为主要登录方？`, { message: `之后从别的机器只能用${label(primary)}登录，其他方式只用来绑定。还没绑定${label(primary)}的账号，下次登录时要先绑定。`, okText: "设为主要登录方" }))) return;
  await saveAuth({ primary, providers: primary ? [...new Set([...auth.value!.providers, primary])] : auth.value!.providers });
}

async function act(u: User, body: Record<string, unknown>, done: string) {
  try {
    await patch(`/api/users/${u.id}`, body);
    await load();
    toast(done, "ok");
  } catch (e) {
    fail(e);
  }
}
async function disable(u: User) {
  if (!(await confirmDialog(`停用 ${u.name}？`, { message: "所有登录立即失效，令牌也不能再用；机器人把他当作陌生人。数据保留，可以再启用。", okText: "停用", danger: true }))) return;
  await act(u, { disabled: true }, "已停用");
}
async function signOutAll(u: User) {
  try {
    const r = await del<{ revoked: number }>(`/api/users/${u.id}/sessions`);
    toast(`已让 ${r.revoked} 台设备退出`, "ok");
  } catch (e) {
    fail(e);
  }
}
/**
 * One account on a platform, as one chip: the id it logs in with and the ids the bots know it by
 * (Feishu gives each app its own open_id). Unbinding one alone changes nothing: the next login links it again.
 */
type Account = { key: string; provider: string; display: string; ids: Identity[] };
function accounts(u: User): Account[] {
  const out = new Map<string, Account>();
  for (const i of u.identities) {
    const key = `${i.channel}:${i.display || i.externalId}`;
    const a = out.get(key) ?? { key, provider: i.provider, display: i.display || i.externalId, ids: [] };
    a.ids.push(i);
    out.set(key, a);
  }
  return [...out.values()];
}
const idsHint = (a: Account) => a.ids.map((i) => `${i.kind === "alias" ? "机器人里认人用" : "登录用"}：${i.externalId}`).join("\n");
async function unbind(u: User, a: Account) {
  const message = `他不能再用这个${a.provider}账号登录这个 omem 账号，机器人也不再认得他。之后他再用${a.provider}登录会被当成新来的人，要你重新批准。`;
  if (!(await confirmDialog(`解绑 ${u.name} 的${a.provider}账号？`, { message, okText: "解绑", danger: true }))) return;
  try {
    for (const i of a.ids) await del(`/api/users/${u.id}/identities`, { channel: i.channel, externalId: i.externalId });
    await load();
  } catch (e) {
    fail(e);
  }
}
async function setSpace(u: User, space: string, role: string | null) {
  try {
    await put(`/api/users/${u.id}/spaces`, { space, role });
    adding.value[u.id] = "";
    await load();
  } catch (e) {
    fail(e);
  }
}
async function createInvite() {
  try {
    const r = await post<{ url: string }>("/api/invites", { role: form.value.role, spaces: form.value.spaces, allowAny: form.value.allowAny, note: form.value.note, days: Number(form.value.days) });
    made.value = r.url;
    form.value = { role: "member", spaces: [], allowAny: false, note: "", days: "7" };
    invites.value = await get<Invite[]>("/api/invites");
  } catch (e) {
    fail(e);
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制", "ok");
  } catch {
    toast("复制失败，请手动选中复制", "error");
  }
}
async function revoke(i: Invite) {
  try {
    await del(`/api/invites/${i.id}`);
    invites.value = await get<Invite[]>("/api/invites");
  } catch (e) {
    fail(e);
  }
}
function editRole(r?: Role, scope: "global" | "space" = "space") {
  draft.value = r ? { id: r.builtin ? undefined : r.id, name: r.builtin ? `${r.name}（副本）` : r.name, scope: r.scope, description: r.description, permissions: r.permissions.filter((p) => p !== "*") } : { name: "", scope, description: "", permissions: scope === "space" ? ["space.read"] : [] };
  void nextTick(() => document.querySelector(".editor")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
}
async function saveRole() {
  const d = draft.value!;
  if (!d.name.trim()) return toast("给角色起个名字", "error");
  try {
    if (d.id) await put(`/api/access/roles/${d.id}`, { name: d.name, description: d.description, permissions: d.permissions });
    else await post("/api/access/roles", { name: d.name, scope: d.scope, description: d.description, permissions: d.permissions });
    draft.value = null;
    roles.value = await get<Roles>("/api/access/roles");
    toast("已保存角色", "ok");
  } catch (e) {
    fail(e);
  }
}
async function deleteRole(r: Role) {
  if (!(await confirmDialog(`删除角色“${r.name}”？`, { okText: "删除", danger: true }))) return;
  try {
    await del(`/api/access/roles/${r.id}`);
    roles.value = await get<Roles>("/api/access/roles");
  } catch (e) {
    fail(e);
  }
}
async function toggleLog() {
  showLog.value = !showLog.value;
  if (showLog.value) log.value = await get<Audit[]>("/api/access/audit").catch(() => []);
}
const userName = (id: string) => (id === "owner" ? "本人" : users.value?.find((u) => u.id === id)?.name ?? id);
const inviteStatus = (i: Invite) => (i.revokedAt ? "已撤销" : i.usedAt ? `${userName(i.usedBy ?? "")} 已使用` : Date.parse(i.expiresAt) <= Date.now() ? "已过期" : `${fmtTime(i.expiresAt, false)} 前有效`);
const isOwner = computed(() => state.me?.role === "owner");
onMounted(() => load().catch(fail));
</script>

<template>
  <div class="stack">
    <p class="muted">让别人用自己的账号登录 omem。运行 omem 的这台机器和你配对过的设备一直算作你本人，不用登录。每个人有一个全局角色，在加入的每个空间里有一个空间角色。</p>
    <Skeleton v-if="!auth" variant="text" :rows="6" />
    <template v-else>
      <div class="card pad stack">
        <UiCheckbox :model-value="auth.enabled" switch @change="(v) => saveAuth({ enabled: v })">打开多人登录</UiCheckbox>
        <p class="muted small">打开后，从别的机器打开网页会看到登录页；经同一台机器上的反向代理（带 X-Forwarded-For）进来的请求也要登录。</p>
        <p v-if="!webUrl" class="small warn-text">还没有填“网页地址”（设置 → 渠道）：登录回调、邀请链接和机器人发的登录链接都要用它。</p>
        <div v-for="p in providers" :key="p.id" class="provider stack">
          <div class="row wrap">
            <UiCheckbox :model-value="auth.providers.includes(p.id) || auth.primary === p.id" :disabled="auth.primary === p.id" @change="(v) => toggleProvider(p.id, v)">{{ p.label }}</UiCheckbox>
            <span v-if="auth.primary === p.id" class="badge accent">主要登录方</span>
            <span class="spacer" />
            <span class="small muted">新账号</span>
            <UiSegmented :model-value="auth.signup[p.id] ?? 'approve'" size="sm" :aria-label="`${p.label}新账号`" :options="SIGNUP" @change="(v) => saveAuth({ signup: { ...auth!.signup, [p.id]: v as 'approve' } })" />
          </div>
          <p v-if="p.unavailable" class="small warn-text">暂时不能用：{{ p.unavailable }}</p>
          <p class="small muted">开发者后台的重定向 URL 要加上：<span class="mono break">{{ p.callback }}</span><button class="btn ghost sm" @click="copy(p.callback)">复制</button></p>
        </div>
        <div class="field">
          <span>主要登录方</span>
          <UiSelect :model-value="auth.primary ?? ''" width="220px" aria-label="主要登录方" :options="[{ value: '', label: '不设（打开的都能登录）' }, ...providers.map((p) => ({ value: p.id, label: p.label }))]" @change="setPrimary" />
          <span class="hint">设了以后只能用它登录，其他方式只能在账号页绑定。</span>
        </div>
      </div>

      <template v-if="pending.length">
        <h2 class="section-title">等待批准</h2>
        <div class="list">
          <div v-for="u in pending" :key="u.id" class="card pad row wrap">
            <img v-if="u.avatar" :src="u.avatar" alt="" class="avatar" referrerpolicy="no-referrer" />
            <div class="stack tight">
              <strong>{{ u.name }}</strong>
              <span class="muted small">{{ u.identities.filter((i) => i.kind === "login").map((i) => i.provider).join("、") }}登录 · {{ fmtTime(u.createdAt) }}{{ u.email ? ` · ${u.email}` : "" }}</span>
            </div>
            <span class="spacer" />
            <button class="btn sm primary" @click="act(u, { approve: true }, `已批准 ${u.name}`)">批准</button>
            <button class="btn ghost sm danger" @click="disable(u)">拒绝</button>
          </div>
        </div>
      </template>

      <h2 class="section-title">成员</h2>
      <Skeleton v-if="!users" variant="text" :rows="4" />
      <div v-else class="list">
        <div v-for="u in others" :key="u.id" class="card pad stack" :class="{ dead: u.disabledAt }">
          <div class="row wrap">
            <img v-if="u.avatar" :src="u.avatar" alt="" class="avatar" referrerpolicy="no-referrer" />
            <div class="stack tight">
              <strong>{{ u.name }} <span class="muted small mono">{{ u.id }}</span></strong>
              <span class="muted small">{{ u.disabledAt ? "已停用 · " : "" }}最近登录 {{ u.lastSeenAt ? fmtTime(u.lastSeenAt) : "没有" }}</span>
            </div>
            <span class="spacer" />
            <span v-if="u.role === 'owner'" class="badge accent">主人</span>
            <UiSelect v-else-if="isOwner" :model-value="u.role" size="sm" width="130px" :aria-label="`${u.name}的全局角色`" :options="globalRoles.map((r) => ({ value: r.id, label: r.name, hint: r.builtin ? '' : '自定义' }))" @change="(v) => act(u, { role: v }, '已改角色')" />
            <span v-else class="badge">{{ roleName(u.role) }}</span>
            <template v-if="u.role !== 'owner'">
              <button v-if="!u.disabledAt" class="btn ghost sm" @click="signOutAll(u)">让所有设备退出</button>
              <button v-if="u.disabledAt" class="btn sm" @click="act(u, { disabled: false }, '已启用')">启用</button>
              <button v-else class="btn ghost sm danger" @click="disable(u)">停用</button>
            </template>
          </div>
          <div class="small chips">
            <span v-for="a in accounts(u)" :key="a.key" class="badge" :title="idsHint(a)">
              {{ a.provider }} · {{ a.display }}
              <button v-if="u.role !== 'owner'" class="x" :aria-label="`解绑 ${a.provider}账号`" title="解绑这个账号" @click="unbind(u, a)">×</button>
            </span>
            <span v-if="!u.identities.length" class="muted">没有绑定任何身份</span>
          </div>
          <template v-if="u.role !== 'owner'">
            <div class="small chips">
              <span class="muted">空间：</span>
              <span v-for="s in u.spaces" :key="s.space" class="space-chip">
                <span class="ellipsis">{{ s.name }}</span>
                <span v-if="s.space.startsWith('personal')" class="muted">{{ roleName(s.role) }}</span>
                <UiSelect v-else variant="inline" :model-value="s.role === 'owner' ? 'manager' : s.role" :aria-label="`${s.name}里的角色`" :options="spaceRoles.map((r) => ({ value: r.id, label: r.name }))" @change="(v) => setSpace(u, s.space, v)" />
                <button v-if="!s.space.startsWith('personal')" class="x" :aria-label="`移出 ${s.name}`" title="移出这个空间" @click="setSpace(u, s.space, null)">×</button>
              </span>
              <span class="space-chip add">
                <UiSelect variant="inline" :model-value="adding[u.id] ?? ''" placeholder="＋ 加入空间" aria-label="加入空间" :options="spaceOptions.filter((o) => !u.spaces.some((s) => s.space === o.value))" @change="(v) => (adding[u.id] = v)" />
                <UiSelect v-if="adding[u.id]" variant="inline" :model-value="''" placeholder="选角色" aria-label="空间角色" :options="spaceRoles.map((r) => ({ value: r.id, label: r.name }))" @change="(v) => setSpace(u, adding[u.id], v)" />
              </span>
            </div>
            <UiCheckbox v-if="auth.primary" :model-value="u.loginAny" size="sm" @change="(v) => act(u, { loginAny: v }, '已保存')">允许用{{ label(auth.primary) }}以外的方式登录（企业外的人）</UiCheckbox>
          </template>
        </div>
      </div>

      <h2 class="section-title">邀请链接</h2>
      <div class="card pad stack">
        <p class="muted small">用邀请链接登录的人直接建好账号，不用再批准，带上选的全局角色并加入下面的空间。链接只能用一次。</p>
        <div class="row wrap">
          <span class="small muted">全局角色</span>
          <UiSelect v-model="form.role" size="sm" width="120px" aria-label="邀请的全局角色" :options="globalRoles.filter((r) => isOwner || r.id === 'member').map((r) => ({ value: r.id, label: r.name }))" />
          <UiSelect :model-value="''" size="sm" width="160px" placeholder="加入空间…" aria-label="邀请加入的空间" :options="spaceOptions.filter((o) => !form.spaces.some((s) => s.space === o.value))" @change="(v) => form.spaces.push({ space: v, role: 'reader' })" />
        </div>
        <div v-if="form.spaces.length" class="small chips">
          <span v-for="s in form.spaces" :key="s.space" class="space-chip">
            <span class="ellipsis">{{ spaceOptions.find((o) => o.value === s.space)?.label ?? s.space }}</span>
            <UiSelect v-model="s.role" variant="inline" aria-label="空间角色" :options="spaceRoles.map((r) => ({ value: r.id, label: r.name }))" />
            <button class="x" aria-label="去掉" title="去掉这个空间" @click="form.spaces = form.spaces.filter((x) => x.space !== s.space)">×</button>
          </span>
        </div>
        <div class="row wrap">
          <input v-model="form.note" class="input" placeholder="备注（对方能看到，如：项目 A 的同事）" maxlength="200" />
          <UiSelect v-model="form.days" size="sm" width="110px" aria-label="有效期" :options="[{ value: '1', label: '1 天' }, { value: '7', label: '7 天' }, { value: '30', label: '30 天' }]" />
          <UiCheckbox v-if="auth.primary" v-model="form.allowAny" size="sm">允许用其他方式登录</UiCheckbox>
          <button class="btn sm primary" @click="createInvite">生成邀请链接</button>
        </div>
        <div v-if="made" class="made row wrap">
          <span class="mono small break">{{ made }}</span>
          <button class="btn sm" @click="copy(made)">复制</button>
          <span class="muted small">只显示这一次。</span>
        </div>
        <div v-for="i in invites" :key="i.id" class="row wrap small invite">
          <span>{{ i.note || "（无备注）" }}</span>
          <span class="muted">{{ roleName(i.role) }}{{ i.spaces.length ? " · " + i.spaces.map((s) => `${s.space}（${roleName(s.role)}）`).join("、") : "" }}</span>
          <span class="spacer" />
          <span class="muted">{{ inviteStatus(i) }}</span>
          <button v-if="!i.revokedAt && !i.usedAt" class="btn ghost sm danger" @click="revoke(i)">撤销</button>
        </div>
      </div>

      <h2 class="section-title">角色</h2>
      <div class="card pad stack">
        <p class="muted small">全局角色决定能不能改 Agent、规则、建空间等全库共用的事，也可以给“所有空间”的权限（别人的个人空间除外）；空间角色决定在一个空间里能读、写什么。内置角色不能改，复制一份再改。</p>
        <div v-if="draft" class="card pad stack editor">
          <strong>{{ draft.id ? "编辑角色" : `新建${draft.scope === "global" ? "全局" : "空间"}角色` }}</strong>
          <input v-model="draft.name" class="input" placeholder="名字，如：审稿人" maxlength="40" />
          <input v-model="draft.description" class="input" placeholder="一句话说明" maxlength="200" />
          <div class="perm-grid">
            <UiCheckbox v-for="p in permChoices(draft.scope)" :key="p" v-model="draft.permissions" :value="p" size="sm">{{ permLabel(p) }}</UiCheckbox>
          </div>
          <div class="row"><button class="btn sm primary" @click="saveRole">保存</button><button class="btn ghost sm" @click="draft = null">取消</button></div>
        </div>
        <div v-for="scope in ['global', 'space'] as const" :key="scope" class="stack roles">
          <div class="row"><strong>{{ scope === "global" ? "全局角色" : "空间角色" }}</strong><span class="spacer" /><button v-if="isOwner" class="btn ghost sm" @click="editRole(undefined, scope)">新建</button></div>
          <div v-for="r in (roles?.roles ?? []).filter((x) => x.scope === scope)" :key="r.id" class="role">
            <div class="row wrap">
              <strong>{{ r.name }}</strong><span class="muted small mono">{{ r.id }}</span><span v-if="!r.builtin" class="badge">自定义</span>
              <span class="spacer" />
              <template v-if="isOwner && r.id !== 'owner'">
                <button class="btn ghost sm" @click="editRole(r)">{{ r.builtin ? "复制" : "编辑" }}</button>
                <button v-if="!r.builtin" class="btn ghost sm danger" @click="deleteRole(r)">删除</button>
              </template>
            </div>
            <p class="muted small">{{ r.description }}</p>
            <p class="small perms">{{ r.id === "owner" ? "全部" : r.permissions.map(permLabel).join("、") || "（没有额外权限）" }}</p>
          </div>
        </div>
      </div>

      <div class="row"><button class="btn ghost sm" @click="toggleLog">{{ showLog ? "收起改动记录" : "看改动记录" }}</button></div>
      <div v-if="showLog" class="card pad stack small">
        <div v-for="a in log" :key="a.id" class="row wrap log">
          <span class="muted">{{ fmtTime(a.at) }}</span>
          <span>{{ userName(a.actor) }} {{ ACTIONS[a.action] ?? a.action }}</span>
          <span class="mono muted">{{ a.target }}</span>
          <span v-if="a.detail.role || a.detail.user" class="muted">{{ [a.detail.user ? userName(String(a.detail.user)) : "", a.detail.role ? roleName(String(a.detail.role)) : ""].filter(Boolean).join(" → ") }}</span>
        </div>
        <p v-if="!log.length" class="muted">还没有改动。</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.provider {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  gap: 4px;
}
.list {
  display: grid;
  gap: 8px;
}
.list .card {
  gap: 8px;
  min-width: 0;
}
.dead {
  opacity: 0.65;
}
.tight {
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex: none;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.space-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  max-width: 100%;
  padding: 0 4px 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  font-size: 12.5px;
  color: var(--ink-2);
}
.space-chip.add {
  border-style: dashed;
  padding: 0 6px;
}
.space-chip.add :deep(.ui-select.empty .value) {
  color: var(--muted);
}
.x {
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 2px;
  font: inherit;
}
.x:hover {
  color: var(--danger);
}
.break {
  overflow-wrap: anywhere;
  min-width: 0;
}
.made {
  background: var(--sunken);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  gap: 8px;
}
.invite,
.log {
  border-top: 1px solid var(--line);
  padding-top: 6px;
  gap: 8px;
}
.input {
  flex: 1;
  min-width: 180px;
}
.roles {
  gap: 6px;
}
.role {
  border-top: 1px solid var(--line);
  padding-top: 8px;
  min-width: 0;
}
.role p {
  margin: 2px 0 0;
}
.perms {
  overflow-wrap: anywhere;
}
.editor {
  background: var(--sunken);
}
.perm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 6px 12px;
}
</style>
