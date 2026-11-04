<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { del, get, logout } from "../api";
import Skeleton from "../components/Skeleton.vue";
import { fmtTime, toast } from "../store";
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
const notice = computed(() => (typeof route.query.error === "string" ? { kind: "err", text: route.query.error } : typeof route.query.bound === "string" ? { kind: "ok", text: "已绑定" } : null));
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
onMounted(() => load().catch((e) => toast((e as Error).message, "error")));
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
</style>
