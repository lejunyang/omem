<script setup lang="ts">
import HelpText from "./HelpText.vue";
import { computed, nextTick, onMounted, ref } from "vue";
import { del, get, patch, post, put } from "../api";
import type { Provider } from "./ProviderApps.vue";
import Icon from "./Icon.vue";
import MonoLine from "./MonoLine.vue";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { fmtTime, relTime, state, toast } from "../store";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { hasCap } from "../lib/caps";
import MemberCaps, { type Capability, type MemberCapsData } from "./MemberCaps.vue";

/**
 * Settings → 成员 (src/auth, docs/v2/multi-user.md): whether other people can log in and with what,
 * who is waiting for approval, everyone's role, logins and spaces, invite links, roles and what
 * changed. This machine and the owner's paired devices never need to log in.
 */
type Auth = { enabled: boolean; providers: string[]; primary: string | null; signup: Record<string, "approve" | "closed" | "open">; sessionDays: number; connectors: string[] };
type Identity = { channel: string; externalId: string; kind: "login" | "alias"; display: string; provider: string };
type User = { id: string; name: string; role: string; status: "active" | "pending"; email: string | null; avatar: string | null; loginAny: boolean; disabledAt: string | null; createdAt: string; lastSeenAt: string | null; identities: Identity[]; spaces: { space: string; name: string; role: string }[] };
type Invite = { id: string; role: string; spaces: { space: string; role: string }[]; allowAny: boolean; note: string; createdAt: string; expiresAt: string; usedBy: string | null; usedAt: string | null; revokedAt: string | null };
type Role = { id: string; name: string; scope: "global" | "space"; description: string; permissions: string[]; builtin: boolean };
type Roles = { roles: Role[]; global: Record<string, string>; space: Record<string, string> };
type Audit = { id: number; at: string; actor: string; action: string; target: string; detail: Record<string, unknown> };

/** The login settings: the owner's (and whoever may change settings); someone who only manages members gets none. */
const auth = ref<Auth | null>(null);
const loaded = ref(false);
const webUrl = ref("");
const providers = ref<Provider[]>([]);
const users = ref<User[] | null>(null);
const invites = ref<Invite[]>([]);
const roles = ref<Roles | null>(null);
const log = ref<Audit[]>([]);
const showLog = ref(false);
const form = ref({ role: "member", spaces: [] as { space: string; role: string }[], allowAny: false, note: "", days: "7" });
const made = ref<string | null>(null);
/** An account made ahead of time by email (docs/v2/remote-clients.md §7.1). */
const ahead = ref({ name: "", email: "", role: "member", spaces: [] as { space: string; role: string }[], loginAny: false });
const adding = ref<Record<string, string>>({});
const draft = ref<{ id?: string; name: string; scope: "global" | "space"; description: string; permissions: string[] } | null>(null);

const pending = computed(() => (users.value ?? []).filter((u) => u.status === "pending" && !u.disabledAt));
const others = computed(() => (users.value ?? []).filter((u) => u.status !== "pending" || u.disabledAt));
const label = (id: string) => providers.value.find((p) => p.id === id)?.label ?? id;
// Login choices: platforms that say who someone is, once set up (or already chosen); the rest are under 平台应用.
const logins = computed(() => providers.value.filter((p) => p.identity && (p.id === "lark" || !p.unavailable || auth.value?.providers.includes(p.id) || auth.value?.primary === p.id)));
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
  "user.create": "按邮箱添加成员", "user.email": "改邮箱", "token.cli": "允许命令行", "token.revoke": "撤销令牌",
  "identity.unlink": "解绑身份", "space.member": "设置空间角色", "space.remove": "移出空间", "role.save": "保存角色", "role.delete": "删除角色", "invite.create": "生成邀请", "invite.revoke": "撤销邀请",
};

async function load() {
  // The configuration is asked for only by someone who may read it.
  const settings = !state.me || state.me.role === "owner" || state.me.perms.includes("settings.manage") ? get<{ config: { auth: Auth; webUrl?: string } }>("/api/settings").catch(() => null) : Promise.resolve(null);
  const [s, p, u, i, r] = await Promise.all([settings, get<Provider[]>("/api/auth/providers"), get<User[]>("/api/users"), get<Invite[]>("/api/invites"), get<Roles>("/api/access/roles")]);
  auth.value = s?.config.auth ?? null;
  webUrl.value = s?.config.webUrl ?? "";
  loaded.value = true;
  providers.value = p;
  users.value = u;
  invites.value = i;
  roles.value = r;
  void loadCaps(u);
  if (showLog.value) log.value = await get<Audit[]>("/api/access/audit");
}

// ---- 能做什么 (components/MemberCaps.vue, src/auth/capabilities.ts) ----------------------------------
// An older server has no capabilities: then neither the entry nor the line on each row shows.
const mayManage = computed(() => hasCap("settings.members"));
const catalog = ref<Capability[] | null>(null);
/** How many capabilities each member has set apart from the preset, for the line on the row. */
const overrideCount = ref<Record<string, number>>({});
const capsFor = ref<User | null>(null);
async function loadCaps(list: User[]) {
  if (!mayManage.value) return;
  if (!catalog.value) catalog.value = await get<Capability[]>("/api/capabilities").catch(() => null);
  if (!catalog.value) return;
  const people = list.filter((x) => x.role !== "owner" && x.status !== "pending");
  const counts = await Promise.all(people.map((x) => get<MemberCapsData>(`/api/members/${encodeURIComponent(x.id)}/capabilities`).then((d) => d.overrides.length).catch(() => null)));
  overrideCount.value = Object.fromEntries(people.flatMap((x, n) => (counts[n] === null ? [] : [[x.id, counts[n]!]])));
}
async function capsSaved(u: User, d: MemberCapsData) {
  overrideCount.value = { ...overrideCount.value, [u.id]: d.overrides.length };
  // The preset is the global role: the row and the role list follow it.
  if (d.preset !== u.role) users.value = await get<User[]>("/api/users").catch(() => users.value);
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
async function addAhead() {
  try {
    const u = await post<{ name: string }>("/api/users", { name: ahead.value.name.trim(), email: ahead.value.email.trim(), role: ahead.value.role, spaces: ahead.value.spaces, loginAny: ahead.value.loginAny });
    toast(`已添加 ${u.name}：用这个邮箱来时就对应到这个账号`, "ok");
    ahead.value = { name: "", email: "", role: "member", spaces: [], loginAny: false };
    await load();
  } catch (e) {
    fail(e);
  }
}
async function editEmail(u: User) {
  const v = await promptDialog(`${u.name} 的邮箱`, { message: "用这个邮箱来的人（飞书本企业账号、鉴权插件认出的身份）会对应到这个账号。留空清除。", value: u.email ?? "", placeholder: "name@example.com", okText: "保存" });
  if (v === null) return;
  await act(u, { email: v.trim() || null }, "已保存邮箱");
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
// What is folded: one person at a time, the invite and add-by-email forms, the roles table.
const openUser = ref<string | null>(null);
const showInvite = ref(false);
const showAhead = ref(false);
const showRoles = ref(false);
const liveInvites = computed(() => invites.value.filter((i) => !i.revokedAt && !i.usedAt && Date.parse(i.expiresAt) > Date.now()).length);
const initial = (name: string) => [...(name.trim() || "?")][0].toUpperCase();
onMounted(() => load().catch(fail));
</script>

<template>
  <div class="stack">
    <HelpText lead>让别人用自己的账号登录 omem。运行 omem 的这台机器和你配对过的设备一直算作你本人，不用登录。每个人有一个全局角色，在加入的每个空间里有一个空间角色。</HelpText>
    <Skeleton v-if="!loaded" variant="text" :rows="6" />
    <template v-else>
      <SetCard :title="auth ? '登录与邀请' : '邀请'">
        <template v-if="!auth" #help>用邀请链接或按邮箱把人加进来。能用哪些方式登录由主人在这里设置。</template>
        <template v-else #help>打开后，从别的机器打开网页会看到登录页；经同一台机器上的反向代理（带 X-Forwarded-For）进来的请求也要登录。GitHub、Google、钉钉、微信等能确认身份的平台，在采集 → 其他平台里填好应用信息后出现在这里。</template>
        <template v-if="auth">
        <SetRow label="打开多人登录">
          <template v-if="!webUrl" #hint><span class="warn-text">还没有填网页地址（设备页）：登录回调、邀请链接和机器人发的登录链接都要用它</span></template>
          <UiCheckbox :model-value="auth.enabled" switch aria-label="打开多人登录" @change="(v) => saveAuth({ enabled: v })" />
        </SetRow>
        <SetRow v-for="p in logins" :key="p.id" :off="!(auth.providers.includes(p.id) || auth.primary === p.id)">
          <template #label>
            <UiCheckbox :model-value="auth.providers.includes(p.id) || auth.primary === p.id" :disabled="auth.primary === p.id" @change="(v) => toggleProvider(p.id, v)">用{{ p.label }}登录</UiCheckbox>
            <span v-if="auth.primary === p.id" class="badge accent primary-badge">主要登录方</span>
          </template>
          <template v-if="p.unavailable || p.callback" #hint>
            <span v-if="p.unavailable" class="warn-text">暂时不能用：{{ p.unavailable }}</span>
            <span v-else class="cb"><span>开发者后台的重定向 URL 要加上</span><MonoLine :text="p.callback!" copy /></span>
          </template>
          <span class="small muted">新账号</span>
          <UiSegmented :model-value="auth.signup[p.id] ?? 'approve'" size="sm" :aria-label="`${p.label}新账号`" :options="SIGNUP" @change="(v) => saveAuth({ signup: { ...auth!.signup, [p.id]: v as 'approve' } })" />
        </SetRow>
        <SetRow label="主要登录方" hint="设了以后只能用它登录，其他方式只能在账号页绑定">
          <UiSelect :model-value="auth.primary ?? ''" size="sm" width="200px" aria-label="主要登录方" :options="[{ value: '', label: '不设（打开的都能登录）' }, ...logins.map((p) => ({ value: p.id, label: p.label }))]" @change="setPrimary" />
        </SetRow>
        </template>
        <SetRow label="邀请链接" :hint="liveInvites ? `${liveInvites} 个还有效；用它登录的人直接建好账号，链接只能用一次` : '用它登录的人直接建好账号，不用再批准；链接只能用一次'">
          <button class="btn ghost sm" :aria-expanded="showInvite" @click="showInvite = !showInvite">{{ showInvite ? "收起" : "生成或查看" }}</button>
        </SetRow>
        <div v-if="showInvite" class="set-pad">
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
            <input v-model="form.note" class="input sm grow-in" placeholder="备注（对方能看到，如：项目 A 的同事）" maxlength="200" aria-label="邀请备注" />
            <UiSelect v-model="form.days" size="sm" width="96px" aria-label="有效期" :options="[{ value: '1', label: '1 天' }, { value: '7', label: '7 天' }, { value: '30', label: '30 天' }]" />
            <UiCheckbox v-if="auth?.primary" v-model="form.allowAny" size="sm">允许用其他方式登录</UiCheckbox>
            <button class="btn sm primary" @click="createInvite">生成邀请链接</button>
          </div>
          <div v-if="made" class="made"><MonoLine :text="made" copy /><span class="muted small">只显示这一次。</span></div>
          <div v-for="i in invites" :key="i.id" class="line small">
            <span class="ellipsis grow" :title="i.note">{{ i.note || "（无备注）" }}</span>
            <span class="muted ellipsis">{{ roleName(i.role) }}{{ i.spaces.length ? ` · ${i.spaces.length} 个空间` : "" }}</span>
            <span class="muted nowrap">{{ inviteStatus(i) }}</span>
            <button v-if="!i.revokedAt && !i.usedAt" class="btn ghost sm danger" @click="revoke(i)">撤销</button>
          </div>
        </div>
        <SetRow label="按邮箱添加成员" hint="先建好账号、分好空间；谁用这个邮箱来就直接对应到这个账号">
          <button class="btn ghost sm" :aria-expanded="showAhead" @click="showAhead = !showAhead">{{ showAhead ? "收起" : "添加" }}</button>
        </SetRow>
        <div v-if="showAhead" class="set-pad">
          <div class="row wrap">
            <input v-model="ahead.name" class="input sm grow-in" placeholder="名字" maxlength="60" aria-label="名字" />
            <input v-model="ahead.email" class="input sm grow-in" type="email" placeholder="邮箱" maxlength="200" aria-label="邮箱" />
          </div>
          <div class="row wrap">
            <span class="small muted">全局角色</span>
            <UiSelect v-model="ahead.role" size="sm" width="120px" aria-label="全局角色" :options="globalRoles.filter((r) => isOwner || r.id === 'member').map((r) => ({ value: r.id, label: r.name }))" />
            <UiSelect :model-value="''" size="sm" width="160px" placeholder="加入空间…" aria-label="加入的空间" :options="spaceOptions.filter((o) => !ahead.spaces.some((s) => s.space === o.value))" @change="(v) => ahead.spaces.push({ space: v, role: 'reader' })" />
          </div>
          <div v-if="ahead.spaces.length" class="small chips">
            <span v-for="s in ahead.spaces" :key="s.space" class="space-chip">
              <span class="ellipsis">{{ spaceOptions.find((o) => o.value === s.space)?.label ?? s.space }}</span>
              <UiSelect v-model="s.role" variant="inline" aria-label="空间角色" :options="spaceRoles.map((r) => ({ value: r.id, label: r.name }))" />
              <button class="x" aria-label="去掉" title="去掉这个空间" @click="ahead.spaces = ahead.spaces.filter((x) => x.space !== s.space)">×</button>
            </span>
          </div>
          <div class="row wrap">
            <UiCheckbox v-if="auth?.primary" v-model="ahead.loginAny" size="sm">允许用{{ label(auth.primary) }}以外的方式登录网页</UiCheckbox>
            <span class="spacer" />
            <button class="btn sm primary" :disabled="!ahead.name.trim() || !ahead.email.trim()" @click="addAhead">添加</button>
          </div>
        </div>
      </SetCard>

      <SetCard v-if="pending.length" title="等待批准">
        <template #aside><span class="badge warn">{{ pending.length }}</span></template>
        <div v-for="u in pending" :key="u.id" class="person-row">
          <span class="avatar" aria-hidden="true"><img v-if="u.avatar" :src="u.avatar" alt="" referrerpolicy="no-referrer" /><template v-else>{{ initial(u.name) }}</template></span>
          <span class="p-name ellipsis">{{ u.name }}</span>
          <span class="p-meta ellipsis">{{ u.identities.filter((i) => i.kind === "login").map((i) => i.provider).join("、") }}登录 · {{ fmtTime(u.createdAt) }}{{ u.email ? ` · ${u.email}` : "" }}</span>
          <span class="p-ops">
            <button class="btn sm primary" @click="act(u, { approve: true }, `已批准 ${u.name}`)">批准</button>
            <button class="btn ghost sm danger" @click="disable(u)">拒绝</button>
          </span>
        </div>
      </SetCard>

      <SetCard title="成员">
        <template #aside><span class="muted small">{{ others.length }} 人</span></template>
        <Skeleton v-if="!users" variant="list" :rows="4" />
        <div v-for="u in others" v-else :key="u.id" class="person" :class="{ dead: u.disabledAt, open: openUser === u.id }">
          <div class="person-head">
            <button type="button" class="person-row as-btn" :aria-expanded="openUser === u.id" @click="openUser = openUser === u.id ? null : u.id">
              <span class="avatar" aria-hidden="true"><img v-if="u.avatar" :src="u.avatar" alt="" referrerpolicy="no-referrer" /><template v-else>{{ initial(u.name) }}</template></span>
              <span class="p-name ellipsis">{{ u.name }}</span>
              <span class="p-role ellipsis">{{ u.disabledAt ? "已停用" : roleName(u.role) }}<span v-if="!u.disabledAt && overrideCount[u.id]" class="p-own" :title="`${overrideCount[u.id]} 项能力和预设不一样`"> · 另设 {{ overrideCount[u.id] }} 项</span></span>
              <span class="p-meta">{{ u.role === "owner" ? "全部空间" : `${u.spaces.length} 个空间` }}</span>
              <span class="p-meta p-seen" :title="u.lastSeenAt ? fmtTime(u.lastSeenAt) : ''">{{ u.lastSeenAt ? relTime(u.lastSeenAt) : "没登录过" }}</span>
              <Icon name="down" :size="14" class="p-chev" />
            </button>
            <button v-if="catalog && u.role !== 'owner' && !u.disabledAt" type="button" class="btn ghost sm p-caps" :aria-label="`${u.name}能做什么`" @click="capsFor = u">能做什么</button>
            <span v-else-if="catalog" class="p-caps-gap" aria-hidden="true" />
          </div>
          <div v-if="openUser === u.id" class="p-body">
            <div class="p-line small">
              <span class="p-k">编号</span><code class="muted">{{ u.id }}</code>
            </div>
            <div class="p-line small">
              <span class="p-k">邮箱</span>
              <button v-if="u.role !== 'owner'" class="link-btn" :title="`改 ${u.name} 的邮箱`" @click="editEmail(u)">{{ u.email || "没有邮箱，点这里填" }}</button>
              <span v-else>{{ u.email || "—" }}</span>
            </div>
            <div v-if="u.role !== 'owner' && catalog && !u.disabledAt" class="p-line small">
              <span class="p-k">全局角色</span>
              <span>{{ roleName(u.role) }} · <button type="button" class="link-btn" @click="capsFor = u">在“能做什么”里改</button></span>
            </div>
            <div v-else-if="u.role !== 'owner' && isOwner" class="p-line small">
              <span class="p-k">全局角色</span>
              <UiSelect :model-value="u.role" size="sm" width="130px" :aria-label="`${u.name}的全局角色`" :options="globalRoles.map((r) => ({ value: r.id, label: r.name, hint: r.builtin ? '' : '自定义' }))" @change="(v) => act(u, { role: v }, '已改角色')" />
            </div>
            <div class="p-line small">
              <span class="p-k">登录身份</span>
              <span class="chips">
                <span v-for="a in accounts(u)" :key="a.key" class="badge" :title="idsHint(a)">
                  {{ a.provider }} · {{ a.display }}
                  <button v-if="u.role !== 'owner'" class="x" :aria-label="`解绑 ${a.provider}账号`" title="解绑这个账号" @click="unbind(u, a)">×</button>
                </span>
                <span v-if="!u.identities.length" class="muted">没有绑定任何身份</span>
              </span>
            </div>
            <div v-if="u.role !== 'owner'" class="p-line small">
              <span class="p-k">空间</span>
              <span class="chips">
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
              </span>
            </div>
            <UiCheckbox v-if="u.role !== 'owner' && auth?.primary" :model-value="u.loginAny" size="sm" @change="(v) => act(u, { loginAny: v }, '已保存')">允许用{{ label(auth.primary) }}以外的方式登录（企业外的人）</UiCheckbox>
            <div v-if="u.role !== 'owner'" class="row wrap">
              <span class="spacer" />
              <button v-if="!u.disabledAt" class="btn ghost sm" @click="signOutAll(u)">让所有设备退出</button>
              <button v-if="u.disabledAt" class="btn sm" @click="act(u, { disabled: false }, '已启用')">启用</button>
              <button v-else class="btn ghost sm danger" @click="disable(u)">停用</button>
            </div>
          </div>
        </div>
      </SetCard>

      <MemberCaps v-if="capsFor && catalog && roles" :user="capsFor" :catalog="catalog" :roles="roles.roles" :owner="isOwner" @close="capsFor = null" @saved="(d) => capsSaved(capsFor!, d)" />

      <slot name="after-members" />

      <SetCard title="角色">
        <template #help>全局角色决定能不能改 Agent、规则、建空间等全库共用的事，也可以给“所有空间”的权限（别人的个人空间除外）；空间角色决定在一个空间里能读、写什么。内置角色不能改，复制一份再改。</template>
        <SetRow label="角色对照" :hint="`${(roles?.roles ?? []).filter((r) => r.scope === 'global').length} 个全局角色、${(roles?.roles ?? []).filter((r) => r.scope === 'space').length} 个空间角色，各自有哪些权限`">
          <button class="btn ghost sm" :aria-expanded="showRoles" @click="showRoles = !showRoles">{{ showRoles ? "收起" : "展开" }}</button>
        </SetRow>
        <template v-if="showRoles">
          <div v-if="draft" class="set-pad editor">
            <strong>{{ draft.id ? "编辑角色" : `新建${draft.scope === "global" ? "全局" : "空间"}角色` }}</strong>
            <input v-model="draft.name" class="input sm" placeholder="名字，如：审稿人" maxlength="40" aria-label="角色名字" />
            <input v-model="draft.description" class="input sm" placeholder="一句话说明" maxlength="200" aria-label="角色说明" />
            <div class="perm-grid">
              <UiCheckbox v-for="p in permChoices(draft.scope)" :key="p" v-model="draft.permissions" :value="p" size="sm">{{ permLabel(p) }}</UiCheckbox>
            </div>
            <div class="row"><button class="btn sm primary" @click="saveRole">保存</button><button class="btn ghost sm" @click="draft = null">取消</button></div>
          </div>
          <div v-for="scope in ['global', 'space'] as const" :key="scope" class="set-pad roles">
            <div class="row"><span class="small muted">{{ scope === "global" ? "全局角色" : "空间角色" }}</span><span class="spacer" /><button v-if="isOwner" class="btn ghost sm" @click="editRole(undefined, scope)">新建</button></div>
            <div v-for="r in (roles?.roles ?? []).filter((x) => x.scope === scope)" :key="r.id" class="role">
              <div class="role-name">
                <span>{{ r.name }}</span><span v-if="!r.builtin" class="badge">自定义</span>
                <span class="spacer" />
                <template v-if="isOwner && r.id !== 'owner'">
                  <button class="btn ghost sm" @click="editRole(r)">{{ r.builtin ? "复制" : "编辑" }}</button>
                  <button v-if="!r.builtin" class="btn ghost sm danger" @click="deleteRole(r)">删除</button>
                </template>
              </div>
              <p v-if="r.description" class="muted small">{{ r.description }}</p>
              <p class="small perms">{{ r.id === "owner" ? "全部" : r.permissions.map(permLabel).join("、") || "（没有额外权限）" }}</p>
            </div>
          </div>
        </template>
        <SetRow label="改动记录" hint="谁改了角色、成员、身份、邀请和分享">
          <button class="btn ghost sm" :aria-expanded="showLog" @click="toggleLog">{{ showLog ? "收起" : "查看" }}</button>
        </SetRow>
        <div v-if="showLog" class="set-pad small">
          <div v-for="a in log" :key="a.id" class="line">
            <span class="muted nowrap">{{ fmtTime(a.at) }}</span>
            <span>{{ userName(a.actor) }} {{ ACTIONS[a.action] ?? a.action }}</span>
            <code class="muted ellipsis">{{ a.target }}</code>
            <span v-if="a.detail.role || a.detail.user" class="muted">{{ [a.detail.user ? userName(String(a.detail.user)) : "", a.detail.role ? roleName(String(a.detail.role)) : ""].filter(Boolean).join(" → ") }}</span>
          </div>
          <p v-if="!log.length" class="muted">还没有改动。</p>
        </div>
      </SetCard>
    </template>
  </div>
</template>

<style scoped>
.warn-text {
  color: var(--warn);
}
.primary-badge {
  margin-left: 8px;
}
.cb {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}
.grow-in {
  flex: 1 1 180px;
  min-width: 0;
}
.grow {
  flex: 1;
  min-width: 0;
}
.nowrap {
  white-space: nowrap;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.badge {
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
.made {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  background: var(--sunken);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.line .btn {
  flex: none;
}
/* One person per row: initial, name, role, spaces, last seen; the rest opens under it. */
.person {
  border-top: 1px solid var(--line);
}
.person.dead .person-row {
  opacity: 0.6;
}
.person-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1.2fr) minmax(0, 0.8fr) minmax(0, 0.7fr) minmax(0, 0.8fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 18px;
  min-width: 0;
  border-top: 1px solid var(--line);
}
.person > .person-row,
.person-head > .person-row {
  border-top: 0;
}
.person-head {
  display: flex;
  align-items: center;
  min-width: 0;
}
.person-head > .person-row {
  flex: 1;
  min-width: 0;
}
.person-head:hover {
  background: var(--hover);
}
.person-head > .as-btn:hover {
  background: none;
}
/* The owner's row keeps the same room, so the columns line up. */
.p-caps,
.p-caps-gap {
  flex: none;
  width: 80px;
  margin-right: 14px;
  justify-content: center;
}
.p-own {
  color: var(--accent);
}
.as-btn {
  width: 100%;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.as-btn:hover {
  background: var(--hover);
}
.avatar {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--sunken);
  color: var(--ink-2);
  font-size: 13px;
  font-weight: 600;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.p-name {
  font-size: 14px;
  color: var(--ink);
}
.p-role {
  font-size: 13px;
  color: var(--ink-2);
}
.p-meta {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.p-ops {
  display: flex;
  gap: 4px;
  grid-column: span 3;
  justify-content: flex-end;
}
.p-chev {
  color: var(--muted);
  transition: transform 0.15s ease;
}
.person.open .p-chev {
  transform: rotate(180deg);
}
.p-body {
  display: grid;
  gap: 10px;
  padding: 4px 18px 16px 58px;
  min-width: 0;
}
.p-line {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.p-line > .p-k {
  color: var(--muted);
}
.p-line > :not(.p-k) {
  justify-self: start;
  min-width: 0;
  max-width: 100%;
}
.link-btn {
  all: unset;
  cursor: pointer;
  color: inherit;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}
.link-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.roles {
  gap: 0;
}
.role {
  padding: 8px 0;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.role-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.role p {
  margin: 2px 0 0;
}
.perms {
  color: var(--ink-2);
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
@media (max-width: 640px) {
  .person-row {
    grid-template-columns: 28px minmax(0, 1fr) auto auto;
    padding: 8px 14px;
  }
  .person-row .p-meta {
    display: none;
  }
  .p-ops {
    grid-column: 1 / -1;
  }
  .p-body {
    padding: 4px 14px 16px;
  }
  .p-line {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}
</style>
