<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, logout } from "../api";
import Skeleton from "../components/Skeleton.vue";
import { promptDialog } from "../lib/dialog";

/**
 * Logging in (src/auth, docs/v2/multi-user.md): the providers the owner turned on, an invite's note,
 * and the two states between logging in and using omem — waiting for approval, and an account that
 * has to bind the primary provider first. Shown without the app frame.
 */
type Provider = { id: string; label: string; unavailable: string | null };
type Session = {
  user: { id: string; name: string; status: "active" | "pending"; avatar: string | null } | null;
  via: string | null;
  restricted: boolean;
  login: { enabled: boolean; primary: Provider | null; providers: Provider[]; invite: { note?: string; allowAny?: boolean; invalid?: boolean } | null };
};

const route = useRoute();
const router = useRouter();
const s = ref<Session | null>(null);
const failed = ref("");
const error = computed(() => (typeof route.query.error === "string" ? route.query.error : ""));
const invite = computed(() => (typeof route.query.invite === "string" ? route.query.invite : ""));
const back = computed(() => (typeof route.query.return === "string" && route.query.return.startsWith("/") ? route.query.return : "/"));
// With a primary provider only it logs in; an invite that allows others shows them all.
const shown = computed(() => {
  const l = s.value?.login;
  if (!l) return [];
  return l.primary && !l.invite?.allowAny ? [l.primary] : l.providers;
});

function start(p: Provider, purpose: "login" | "bind" = "login") {
  const q = new URLSearchParams({ purpose });
  if (invite.value && purpose === "login") q.set("invite", invite.value);
  if (back.value !== "/") q.set("return", back.value);
  location.href = `/api/auth/${p.id}/start?${q}`;
}
async function useToken() {
  const t = (await promptDialog("使用访问令牌", { message: "在运行 omem 的机器上执行 omem user token <用户>，把令牌粘贴到这里。", placeholder: "令牌", okText: "保存" }))?.trim();
  if (!t) return;
  try {
    localStorage.setItem("omem-token", t);
  } catch {}
  location.hash = `#${back.value}`;
  location.reload();
}
onMounted(async () => {
  try {
    s.value = await get<Session>(`/api/auth/session${invite.value ? `?invite=${encodeURIComponent(invite.value)}` : ""}`);
    // Already in (and allowed): nothing to do here.
    if (s.value.user?.status === "active" && !s.value.restricted && !error.value) await router.replace(back.value);
  } catch (e) {
    failed.value = (e as Error).message;
  }
});
</script>

<template>
  <div class="login">
    <div class="card pad box stack">
      <div class="row brand">
        <span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32" width="26" height="26"><rect width="32" height="32" rx="8" fill="currentColor" /><circle cx="16" cy="16" r="7" fill="none" stroke="var(--bg)" stroke-width="3" /></svg></span>
        <strong>omem</strong>
      </div>
      <div v-if="error" class="err small">{{ error }}</div>
      <div v-if="failed" class="err small">连不上 omem：{{ failed }}</div>
      <Skeleton v-else-if="!s" variant="text" :rows="3" />

      <template v-else-if="s.user && s.user.status === 'pending'">
        <h2>等待批准</h2>
        <p class="muted">{{ s.user.name }}，你的账号已经建好，等 omem 的主人批准后就能使用。批准后机器人会私聊通知你，刷新这个页面即可。</p>
        <div class="row"><button class="btn" @click="logout">退出登录</button></div>
      </template>

      <template v-else-if="s.user && s.restricted">
        <h2>先绑定{{ s.login.primary?.label }}</h2>
        <p class="muted">这里现在要用{{ s.login.primary?.label }}登录。你的账号还没有绑定{{ s.login.primary?.label }}，绑定之后就恢复正常，以后直接用{{ s.login.primary?.label }}登录。</p>
        <div class="row wrap">
          <button v-if="s.login.primary" class="btn primary" :disabled="!!s.login.primary.unavailable" @click="start(s.login.primary, 'bind')">绑定{{ s.login.primary.label }}</button>
          <button class="btn ghost" @click="logout">退出登录</button>
        </div>
      </template>

      <template v-else-if="s.user && s.user.status === 'active'">
        <p class="muted">已经以 {{ s.user.name }} 登录。</p>
        <div class="row wrap">
          <router-link class="btn primary" :to="back">进入 omem</router-link>
          <button v-if="s.via !== 'local'" class="btn ghost" @click="logout">换一个账号</button>
        </div>
      </template>

      <template v-else-if="!s.login.enabled">
        <h2>需要访问令牌</h2>
        <p class="muted">这台 omem 没有打开多人登录。从其他设备打开需要令牌：在运行 omem 的机器上执行 <span class="mono">omem user token owner</span>。想用飞书登录，先在这台机器或配对过的设备（<span class="mono">omem peer open</span>）上打开 设置 → 成员 → 打开多人登录。</p>
        <div class="row"><button class="btn primary" @click="useToken">输入令牌</button></div>
      </template>

      <template v-else>
        <h2>登录</h2>
        <p v-if="s.login.invite?.invalid" class="warn-text small">这个邀请链接无效、已用过或已过期，仍可以登录，但新账号要等批准。</p>
        <p v-else-if="s.login.invite" class="muted">你收到了邀请{{ s.login.invite.note ? `：${s.login.invite.note}` : "" }}。登录后直接可以使用，不用再等批准。</p>
        <p v-else class="muted">第一次登录会建一个账号，等 omem 的主人批准后使用。</p>
        <div class="providers">
          <button v-for="p in shown" :key="p.id" class="btn primary" :disabled="!!p.unavailable" :title="p.unavailable ?? ''" @click="start(p)">用{{ p.label }}登录</button>
        </div>
        <p v-for="p in shown.filter((x) => x.unavailable)" :key="p.id" class="small warn-text">{{ p.label }}：{{ p.unavailable }}</p>
        <p v-if="!shown.length" class="muted small">还没有可用的登录方式。</p>
        <button class="btn ghost sm token" @click="useToken">使用访问令牌</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: var(--bg);
}
.box {
  width: min(400px, 100%);
  gap: 14px;
}
.brand {
  gap: 10px;
  font-size: 18px;
}
.logo {
  display: flex;
  color: var(--ink);
}
h2 {
  margin: 0;
  font-family: var(--serif);
  font-weight: 600;
}
.providers {
  display: grid;
  gap: 8px;
}
.providers .btn {
  justify-content: center;
}
.token {
  justify-self: start;
}
.err {
  color: var(--danger);
  overflow-wrap: anywhere;
}
</style>
