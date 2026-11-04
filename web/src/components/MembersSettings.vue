<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { del, get, patch, post, put } from "../api";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { fmtTime, state, toast } from "../store";
import { confirmDialog } from "../lib/dialog";

/**
 * Settings → 成员 (src/auth, docs/v2/multi-user.md): whether other people can log in and with what,
 * who is waiting for approval, everyone's logins and spaces, and invite links. This machine and the
 * owner's paired devices never need to log in.
 */
type Auth = { enabled: boolean; providers: string[]; primary: string | null; signup: Record<string, "approve" | "closed" | "open">; sessionDays: number };
type Provider = { id: string; label: string; unavailable: string | null; callback: string };
type Identity = { channel: string; externalId: string; kind: "login" | "alias"; display: string; provider: string };
type User = { id: string; name: string; role: string; status: "active" | "pending"; email: string | null; avatar: string | null; loginAny: boolean; disabledAt: string | null; createdAt: string; lastSeenAt: string | null; identities: Identity[]; spaces: { space: string; name: string; role: string }[] };
type Invite = { id: string; spaces: { space: string; role: string }[]; allowAny: boolean; note: string; createdAt: string; expiresAt: string; usedBy: string | null; usedAt: string | null; revokedAt: string | null };

const auth = ref<Auth | null>(null);
const webUrl = ref("");
const providers = ref<Provider[]>([]);
const users = ref<User[] | null>(null);
const invites = ref<Invite[]>([]);
const form = ref({ spaces: [] as string[], edit: [] as string[], allowAny: false, note: "", days: "7" });
const made = ref<string | null>(null);
const adding = ref<Record<string, string>>({});

const pending = computed(() => (users.value ?? []).filter((u) => u.status === "pending" && !u.disabledAt));
const others = computed(() => (users.value ?? []).filter((u) => u.status !== "pending" || u.disabledAt));
const label = (id: string) => providers.value.find((p) => p.id === id)?.label ?? id;
const spaceOptions = computed(() => state.spaces.filter((s) => s.kind !== "personal").map((s) => ({ value: s.id, label: s.name })));
const SIGNUP = [
  { value: "approve", label: "等批准" },
  { value: "open", label: "直接进入" },
  { value: "closed", label: "只认邀请" },
];

async function load() {
  const [s, p, u, i] = await Promise.all([get<{ config: { auth: Auth; webUrl?: string } }>("/api/settings"), get<Provider[]>("/api/auth/providers"), get<User[]>("/api/users"), get<Invite[]>("/api/invites")]);
  auth.value = s.config.auth;
  webUrl.value = s.config.webUrl ?? "";
  providers.value = p;
  users.value = u;
  invites.value = i;
}
async function saveAuth(next: Partial<Auth>) {
  try {
    const r = await put<{ config: { auth: Auth } }>("/api/settings", { auth: { ...auth.value!, ...next } });
    auth.value = r.config.auth;
    toast("已保存", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
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
    toast((e as Error).message, "error");
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
    toast((e as Error).message, "error");
  }
}
async function unbind(u: User, i: Identity) {
  if (!(await confirmDialog(`解绑 ${u.name} 的${i.provider}身份？`, { message: i.kind === "alias" ? "这是渠道里的身份：解绑后机器人不再认得这个人。" : "之后不能再用它登录这个账号。", okText: "解绑", danger: true }))) return;
  try {
    await del(`/api/users/${u.id}/identities`, { channel: i.channel, externalId: i.externalId });
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function setSpace(u: User, space: string, role: "reader" | "editor" | null) {
  try {
    await put(`/api/users/${u.id}/spaces`, { space, role });
    adding.value[u.id] = "";
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function createInvite() {
  try {
    const spaces = form.value.spaces.map((s) => ({ space: s, role: form.value.edit.includes(s) ? "editor" : "reader" }));
    const r = await post<{ url: string }>("/api/invites", { spaces, allowAny: form.value.allowAny, note: form.value.note, days: Number(form.value.days) });
    made.value = r.url;
    form.value = { spaces: [], edit: [], allowAny: false, note: "", days: "7" };
    invites.value = await get<Invite[]>("/api/invites");
  } catch (e) {
    toast((e as Error).message, "error");
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
    toast((e as Error).message, "error");
  }
}
const inviteStatus = (i: Invite) => (i.revokedAt ? "已撤销" : i.usedAt ? `${i.usedBy} 已使用` : Date.parse(i.expiresAt) <= Date.now() ? "已过期" : `${fmtTime(i.expiresAt, false)} 前有效`);
const ROLE: Record<string, string> = { reader: "只读", editor: "可写", owner: "管理" };
onMounted(() => load().catch((e) => toast((e as Error).message, "error")));
</script>

<template>
  <div class="stack">
    <p class="muted">让别人用自己的账号登录 omem。运行 omem 的这台机器和你配对过的设备一直算作你本人，不用登录。成员能问答、管理自己的事项，只能读你开放给他的空间。</p>
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
              <span class="muted small">{{ u.role === "owner" ? "omem 的主人" : "成员" }}{{ u.disabledAt ? " · 已停用" : "" }} · 最近登录 {{ u.lastSeenAt ? fmtTime(u.lastSeenAt) : "没有" }}</span>
            </div>
            <span class="spacer" />
            <template v-if="u.role !== 'owner'">
              <button v-if="!u.disabledAt" class="btn ghost sm" @click="signOutAll(u)">让所有设备退出</button>
              <button v-if="u.disabledAt" class="btn sm" @click="act(u, { disabled: false }, '已启用')">启用</button>
              <button v-else class="btn ghost sm danger" @click="disable(u)">停用</button>
            </template>
          </div>
          <div class="small chips">
            <span v-for="i in u.identities" :key="i.channel + i.externalId" class="badge" :title="i.externalId">
              {{ i.provider }}{{ i.kind === "alias" ? "（渠道）" : "" }} {{ i.display || i.externalId }}
              <button class="x" :aria-label="`解绑 ${i.provider}`" @click="unbind(u, i)">×</button>
            </span>
            <span v-if="!u.identities.length" class="muted">没有绑定任何身份</span>
          </div>
          <template v-if="u.role !== 'owner'">
            <div class="small chips">
              <span class="muted">空间：</span>
              <span v-for="s in u.spaces" :key="s.space" class="badge">{{ s.name }} · {{ ROLE[s.role] ?? s.role }}<button v-if="!s.space.startsWith('personal')" class="x" :aria-label="`移出 ${s.name}`" @click="setSpace(u, s.space, null)">×</button></span>
              <UiSelect :model-value="adding[u.id] ?? ''" size="sm" width="160px" placeholder="加入空间…" aria-label="加入空间" :options="spaceOptions.filter((o) => !u.spaces.some((s) => s.space === o.value))" @change="(v) => (adding[u.id] = v)" />
              <template v-if="adding[u.id]">
                <button class="btn sm" @click="setSpace(u, adding[u.id], 'reader')">只读</button>
                <button class="btn sm" @click="setSpace(u, adding[u.id], 'editor')">可写</button>
              </template>
            </div>
            <UiCheckbox v-if="auth.primary" :model-value="u.loginAny" size="sm" @change="(v) => act(u, { loginAny: v }, '已保存')">允许用{{ label(auth.primary) }}以外的方式登录（企业外的人）</UiCheckbox>
          </template>
        </div>
      </div>

      <h2 class="section-title">邀请链接</h2>
      <div class="card pad stack">
        <p class="muted small">用邀请链接登录的人直接建好账号，不用再批准，并加入下面选的空间。链接只能用一次。</p>
        <div class="row wrap">
          <UiSelect :model-value="''" size="sm" width="200px" placeholder="加入空间…" aria-label="邀请加入的空间" :options="spaceOptions.filter((o) => !form.spaces.includes(o.value))" @change="(v) => form.spaces.push(v)" />
          <span v-for="s in form.spaces" :key="s" class="badge">
            {{ spaceOptions.find((o) => o.value === s)?.label ?? s }}
            <UiCheckbox v-model="form.edit" :value="s" size="sm">可写</UiCheckbox>
            <button class="x" aria-label="去掉" @click="form.spaces = form.spaces.filter((x) => x !== s)">×</button>
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
          <span class="muted">{{ i.spaces.map((s) => `${s.space}${s.role === "editor" ? "（可写）" : ""}`).join("、") || "不加入空间" }}</span>
          <span class="spacer" />
          <span class="muted">{{ inviteStatus(i) }}</span>
          <button v-if="!i.revokedAt && !i.usedAt" class="btn ghost sm danger" @click="revoke(i)">撤销</button>
        </div>
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
.invite {
  border-top: 1px solid var(--line);
  padding-top: 6px;
  gap: 8px;
}
.input {
  flex: 1;
  min-width: 180px;
}
</style>
