<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, logout } from "../api";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import { promptDialog } from "../lib/dialog";

/**
 * Logging in (src/auth, docs/v2/multi-user.md): the providers the owner turned on, an invite's note,
 * and the two states between logging in and using omem — waiting for approval, and an account that
 * has to bind the primary provider first. Shown without the app frame.
 */
type Provider = { id: string; label: string; unavailable: string | null; features?: { id: string; label: string; description: string }[] };
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
// A link the assistant sent (src/auth/connect-wait.ts): `?provider=lark&features=docs,doc-write&scopes=…` ticks what is missing.
const qList = (k: string) => (typeof route.query[k] === "string" ? (route.query[k] as string).split(",").map((x) => x.trim()).filter(Boolean) : []);
const askedProvider = computed(() => (typeof route.query.provider === "string" ? route.query.provider : ""));
const askedFeatures = computed(() => qList("features"));
const askedScopes = computed(() => qList("scopes"));
const asking = computed(() => !!askedProvider.value && (askedFeatures.value.length > 0 || askedScopes.value.length > 0));
// With a primary provider only it logs in; an invite that allows others shows them all.
const shown = computed(() => {
  const l = s.value?.login;
  if (!l) return [];
  return l.primary && !l.invite?.allowAny ? [l.primary] : l.providers;
});

/**
 * Features to turn on in the same authorization as logging in (none by default: logging in asks only
 * who you are). A new account still waits for approval before omem uses any of them.
 */
const picked = ref<Record<string, string[]>>({});
/**
 * Feishu only: what of the ticked messages / documents omem saves into the person's space on its own
 * (src/auth/login.ts captureChoice). Reading them when asked needs only the feature; saving is separate.
 * Documents they open are saved unless unticked (as before the choice existed); chats are not.
 */
const CAPTURES: { id: string; feature: string; label: string; hint: string }[] = [
  { id: "docs", feature: "docs", label: "读过的文档存进 omem", hint: "你最近打开的飞书文档，之后能检索；可以在账号页排除个人文档库或某些文档" },
  { id: "group", feature: "messages", label: "群聊记录存进 omem", hint: "你最近活跃的群，已经在共享空间里的群不再存一份" },
  { id: "p2p", feature: "messages-p2p", label: "单聊记录存进 omem", hint: "你和别人的私聊，只存进你自己的空间" },
];
const capture = ref<string[]>(["docs"]);
const capturesFor = (p: Provider) => (p.id === "lark" ? CAPTURES.filter((c) => picked.value[p.id]?.includes(c.feature)) : []);
function setCapture(q: URLSearchParams, p: Provider) {
  const shown = capturesFor(p);
  if (shown.length) q.set("capture", shown.filter((c) => capture.value.includes(c.id)).map((c) => c.id).join(","));
}
function start(p: Provider, purpose: "login" | "bind" = "login") {
  const q = new URLSearchParams({ purpose });
  if (invite.value && purpose === "login") q.set("invite", invite.value);
  if (purpose === "login" && picked.value[p.id]?.length) q.set("features", picked.value[p.id].join(","));
  if (purpose === "login") setCapture(q, p);
  if (purpose === "login" && p.id === askedProvider.value && askedScopes.value.length) q.set("scopes", askedScopes.value.join(","));
  if (back.value !== "/") q.set("return", back.value);
  else if (purpose === "login" && asking.value) q.set("return", "/login?granted=1");
  location.href = `/api/auth/${p.id}/start?${q}`;
}
/** Already logged in, the link asks for more: the same incremental authorization as the account page. */
function connect(p: Provider) {
  const q = new URLSearchParams({ purpose: "connect" });
  if (picked.value[p.id]?.length) q.set("features", picked.value[p.id].join(","));
  setCapture(q, p);
  if (askedScopes.value.length) q.set("scopes", askedScopes.value.join(","));
  q.set("return", "/login?granted=1");
  location.href = `/api/auth/${p.id}/start?${q}`;
}
const granted = computed(() => route.query.granted === "1");
const askedProviderOf = (sess: Session) => [...sess.login.providers, ...(sess.login.primary ? [sess.login.primary] : [])].find((p) => p.id === askedProvider.value) ?? null;
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
    for (const p of [...s.value.login.providers, ...(s.value.login.primary ? [s.value.login.primary] : [])]) {
      const known = new Set((p.features ?? []).map((f) => f.id));
      picked.value[p.id] ??= p.id === askedProvider.value ? askedFeatures.value.filter((f) => known.has(f)) : [];
    }
    // Already in (and allowed): nothing to do here, unless a link asks for an authorization or reports one.
    if (s.value.user?.status === "active" && !s.value.restricted && !error.value && !asking.value && !granted.value) await router.replace(back.value);
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

      <template v-else-if="s.user && s.user.status === 'active' && granted">
        <h2>已授权</h2>
        <p class="muted">新授权的功能已经生效。助手刚才因为没有授权没做成的事会自动接着做，回到飞书看结果就行。</p>
        <div class="row"><router-link class="btn primary" to="/">进入 omem</router-link></div>
      </template>

      <template v-else-if="s.user && s.user.status === 'active' && asking && askedProviderOf(s)">
        <h2>给 omem 授权{{ askedProviderOf(s)!.label }}</h2>
        <p class="muted">{{ s.user.name }}，助手刚才要以你的身份用{{ askedProviderOf(s)!.label }}，缺少下面勾选的功能。在{{ askedProviderOf(s)!.label }}里确认后，它会接着做刚才的事。</p>
        <div class="stack tight features">
          <UiCheckbox v-for="f in askedProviderOf(s)!.features ?? []" :key="f.id" v-model="picked[askedProvider]" :value="f.id" size="sm">
            <span class="feat"><span>{{ f.label }}</span><span class="muted small">{{ f.description }}</span></span>
          </UiCheckbox>
        </div>
        <div v-if="capturesFor(askedProviderOf(s)!).length" class="stack tight features save">
            <span class="muted small">授权只让助手在你让它看时读。下面勾上的才会定时存进你的个人空间：</span>
            <UiCheckbox v-for="c in capturesFor(askedProviderOf(s)!)" :key="c.id" v-model="capture" :value="c.id" size="sm">
              <span class="feat"><span>{{ c.label }}</span><span class="muted small">{{ c.hint }}</span></span>
            </UiCheckbox>
        </div>
        <p v-if="askedScopes.length" class="muted small">另外要补的权限：<span class="mono">{{ askedScopes.join("、") }}</span></p>
        <div class="row wrap">
          <button class="btn primary" :disabled="!!askedProviderOf(s)!.unavailable || (!picked[askedProvider]?.length && !askedScopes.length)" @click="connect(askedProviderOf(s)!)">去{{ askedProviderOf(s)!.label }}授权</button>
          <router-link class="btn ghost" to="/">先不用</router-link>
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
        <section v-for="p in shown.filter((x) => x.features?.length && !x.unavailable)" :key="`f-${p.id}`" class="pick stack tight">
          <strong class="small">登录时一并授权{{ p.label }}的功能（可选）</strong>
          <p class="muted small">不勾就只让 omem 知道你是谁。勾上的在{{ p.label }}授权页一起确认，之后也能在账号页打开或关掉。</p>
          <div class="stack tight features">
            <UiCheckbox v-for="f in p.features" :key="f.id" v-model="picked[p.id]" :value="f.id" size="sm">
              <span class="feat"><span>{{ f.label }}</span><span class="muted small">{{ f.description }}</span></span>
            </UiCheckbox>
          </div>
          <div v-if="capturesFor(p).length" class="stack tight features save">
            <span class="muted small">授权只让助手在你让它看时读。下面勾上的才会定时存进你的个人空间：</span>
            <UiCheckbox v-for="c in capturesFor(p)" :key="c.id" v-model="capture" :value="c.id" size="sm">
              <span class="feat"><span>{{ c.label }}</span><span class="muted small">{{ c.hint }}</span></span>
            </UiCheckbox>
          </div>
        </section>
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
.pick {
  text-align: left;
}
.pick > p {
  margin: 0 0 4px;
}
.features {
  gap: 10px;
}
.save {
  border-top: 1px solid var(--line);
  padding-top: 8px;
}
/* The name on one line, what it does on the next: a long description never wraps under the name. */
.feat {
  display: grid;
  gap: 2px;
}
/* The box beside the name, not halfway down the description. */
.features :deep(.ui-check) {
  align-items: flex-start;
}
.features :deep(.ui-check .box) {
  margin-top: 3px;
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
