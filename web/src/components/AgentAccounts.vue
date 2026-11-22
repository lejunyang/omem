<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { del, get, post } from "../api";
import { fmtTime, toast } from "../store";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { credAnchor, suppliedBy, type Credential } from "../lib/credentials";
import CredentialList from "./CredentialList.vue";
import Markdown from "./Markdown.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 我的 AI 账号 (docs/v2/agent-accounts.md): the backends a person can log in to with their own
 * account; their runs on them then use it. Each backend lists its own login and the login methods
 * plugins bring for it. Shown only where the machine can start the sandbox. Above them, the
 * credentials (components/CredentialList): a backend one of them supplies says so and is logged in
 * and out there, not here.
 */
type Policy = "owner" | "own" | "own-or-other";
type Quota = { plan: string | null; readAt: string; windows: { name: string; used: number; resetsIn?: string; perDayLeft?: number }[]; avoid?: string; error?: string };
type Method = { id: string; label: string; plugin?: string };
type Backend = {
  id: string;
  name: string;
  policy: Policy;
  login: boolean;
  token: boolean;
  methods: Method[];
  state: "none" | "logged-in" | "expired" | "logging-in";
  method?: string;
  methodLabel?: string;
  user?: string;
  checkedAt?: string;
  expiresAt?: string;
  error?: string;
  url?: string;
  code?: string;
  quota?: Quota | null;
};
type Mine = { supported: boolean; reason?: string; owner: boolean; backends: Backend[] };

const mine = ref<Mine | null>(null);
const busy = ref<string | null>(null);
/** The login method picked per backend (the one that logged them in, else the first). */
const picked = ref<Record<string, string>>({});
let timer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  try {
    mine.value = await get<Mine>("/api/me/agent-accounts");
  } catch {
    mine.value = null;
  }
  for (const b of mine.value?.backends ?? []) if (!picked.value[b.id] || !b.methods.some((m) => m.id === picked.value[b.id])) picked.value[b.id] = b.methods.find((m) => m.id === b.method)?.id ?? b.methods[0]?.id ?? "";
  clearTimeout(timer);
  // A login in progress ends on the provider's page: look again until it does.
  if (mine.value?.backends.some((b) => b.state === "logging-in")) timer = setTimeout(load, 3000);
}
onMounted(load);
onBeforeUnmount(() => clearTimeout(timer));

const STATE: Record<Backend["state"], string> = { none: "没登录", "logged-in": "已登录", expired: "登录过期", "logging-in": "登录中" };
const POLICY: Record<Policy, string> = { owner: "没登录时借用 omem 主人的", own: "没登录时这个后端用不了", "own-or-other": "没登录时换一个你登录过、或允许借用的后端" };

async function act(b: Backend, what: string, fn: () => Promise<unknown>) {
  busy.value = `${b.id}:${what}`;
  try {
    await fn();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = null;
    await load();
  }
}
const login = (b: Backend) =>
  act(b, "login", async () => {
    const method = picked.value[b.id] || "native";
    const r = await post<{ url?: string; code?: string; done?: boolean }>(`/api/me/agent-accounts/${b.id}/login`, { method });
    if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
    else if (r.done) toast(`${b.name} 已登录`, "ok");
  });
const pasteToken = (b: Backend) =>
  act(b, "token", async () => {
    const token = await promptDialog(`粘贴 ${b.name} 的令牌`, { message: "在你自己的电脑上生成一个长期令牌（Claude Code 是 claude setup-token），粘贴到这里。令牌只存在运行 omem 的这台机器的密钥库里，不进配置文件，也不会显示出来。", placeholder: "令牌", okText: "保存" });
    if (!token?.trim()) return;
    const r = await post<{ state: string }>(`/api/me/agent-accounts/${b.id}/token`, { token: token.trim() });
    toast(r.state === "logged-in" ? `${b.name} 已登录` : `令牌已保存，但 ${b.name} 说还没登录`, r.state === "logged-in" ? "ok" : "error");
  });
const check = (b: Backend) => act(b, "check", () => post(`/api/me/agent-accounts/${b.id}/check`));
const readQuota = (b: Backend) => act(b, "quota", () => post(`/api/me/agent-accounts/${b.id}/quota`));
/** The server's answer when a credential supplies the backend after all (409): shown under it as it came. */
const conflict = ref<Record<string, string>>({});
const logout = async (b: Backend) => {
  const after = b.policy === "own" ? "用不了这个后端，直到你重新登录" : b.policy === "own-or-other" ? "换别的后端" : "借用 omem 主人的登录";
  if (!(await confirmDialog(`退出 ${b.name}`, { message: `退出后删除你在这台机器上的 ${b.name} 登录和它的文件（会话记录、设置）。之后你的运行${after}。`, okText: "退出并删除", danger: true }))) return;
  busy.value = `${b.id}:logout`;
  try {
    await del(`/api/me/agent-accounts/${b.id}`);
    delete conflict.value[b.id];
  } catch (e) {
    if ((e as { status?: number }).status === 409) conflict.value = { ...conflict.value, [b.id]: (e as Error).message };
    else toast((e as Error).message, "error");
  } finally {
    busy.value = null;
    await Promise.all([load(), credList.value?.reload()]);
  }
};
const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("已复制", "ok"), () => {});
const canLogin = (b: Backend) => b.methods.length > 0;

// ---- the credentials above (components/CredentialList) ------------------------------------------
const creds = ref<Credential[]>([]);
const credList = ref<InstanceType<typeof CredentialList> | null>(null);
const names = computed(() => Object.fromEntries((mine.value?.backends ?? []).map((b) => [b.id, b.name])));
/** The credential that logs this backend in and out (lib/credentials.ts `suppliedBy`). */
const source = (b: Backend) => suppliedBy(b, creds.value);
/** To the credential's row above, focused, so the keyboard lands there too. */
function reveal(kind: string) {
  void nextTick(() => {
    const el = document.getElementById(credAnchor(kind));
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1600);
  });
}
</script>

<template>
  <CredentialList ref="credList" :backend-names="names" @loaded="(l) => (creds = l)" @changed="load" />
  <template v-if="mine?.supported">
    <h2 class="section-title">我的 AI 账号</h2>
    <p v-if="mine.owner" class="muted small">你用运行 omem 的这台机器上已有的登录，不用在这里登录。成员没登录时借不借用你的，在 <router-link to="/settings?card=agent-accounts">设置 → 成员 → 成员的 AI 账号</router-link> 里按后端设。</p>
    <template v-else>
      <p class="muted small">在这里登录以后，你发起的运行就用你自己的账号，额度和使用记录算在你名下。这台机器上所有人的 Agent 都以同一个系统用户运行，靠沙箱把各人的账号目录隔开：你的运行看不到别人的目录，也看不到 omem 主人的登录。点“登录”后，链接和验证码也会由机器人发到你的飞书私聊。</p>
      <div class="list">
        <div v-for="b in mine.backends" :key="b.id" class="card pad stack acct">
          <div class="row wrap head">
            <strong>{{ b.name }}</strong>
            <span class="badge" :class="{ accent: b.state === 'logged-in', danger: b.state === 'expired', warn: b.state === 'logging-in' }">{{ STATE[b.state] }}</span>
            <span v-if="b.user" class="muted small ellipsis" :title="b.user">{{ b.user }}</span>
            <span v-if="source(b)" class="badge">由 {{ source(b)!.name }} 供给</span>
            <span class="spacer" />
            <template v-if="source(b)">
              <button v-if="b.state !== 'none'" class="btn ghost sm" :disabled="!!busy" @click="check(b)">{{ busy === `${b.id}:check` ? "检查中…" : "检查" }}</button>
              <button class="btn ghost sm" @click="reveal(source(b)!.kind)">去凭据里管理</button>
            </template>
            <template v-else-if="b.state !== 'logging-in'">
              <UiSelect v-if="b.methods.length > 1" :model-value="picked[b.id] ?? ''" size="sm" width="180px" :aria-label="`${b.name} 的登录方式`" :options="b.methods.map((m) => ({ value: m.id, label: m.label }))" @change="(v) => (picked[b.id] = v)" />
              <button v-if="canLogin(b)" class="btn sm" :class="{ primary: b.state !== 'logged-in' }" :disabled="!!busy" @click="login(b)">{{ busy === `${b.id}:login` ? "正在启动…" : b.state === "logged-in" ? "重新登录" : "登录" }}</button>
              <button v-if="b.token" class="btn sm" :class="{ primary: !canLogin(b) && b.state !== 'logged-in' }" :disabled="!!busy" @click="pasteToken(b)">粘贴令牌</button>
              <button v-if="b.state !== 'none'" class="btn ghost sm" :disabled="!!busy" @click="check(b)">{{ busy === `${b.id}:check` ? "检查中…" : "检查" }}</button>
              <button v-if="b.state !== 'none'" class="btn ghost sm danger" :disabled="!!busy" @click="logout(b)">退出</button>
            </template>
            <button v-else class="btn ghost sm danger" :disabled="!!busy" @click="logout(b)">取消</button>
          </div>
          <div v-if="b.state === 'logging-in' && b.url" class="stack tight login">
            <span class="small">在打开的页面里完成登录{{ b.code ? "，验证码是" : "" }}<strong v-if="b.code" class="mono code">{{ b.code }}</strong>。完成后这里会自动变成“已登录”。</span>
            <span class="row wrap tight-row">
              <a :href="b.url" target="_blank" rel="noopener noreferrer" class="mono small ellipsis link" :title="b.url">{{ b.url }}</a>
              <button class="btn ghost sm" @click="copy(b.url!)">复制链接</button>
              <button v-if="b.code" class="btn ghost sm" @click="copy(b.code!)">复制验证码</button>
            </span>
          </div>
          <div v-if="b.state === 'logged-in' && b.quota" class="row wrap quota small">
            <span class="muted">额度{{ b.quota.plan ? `（${b.quota.plan}）` : "" }}</span>
            <span v-for="w in b.quota.windows" :key="w.name" class="badge" :class="{ warn: w.used >= 80 }">{{ w.name }} 已用 {{ w.used }}%{{ w.resetsIn ? ` · ${w.resetsIn}后重置` : "" }}</span>
            <span v-if="!b.quota.windows.length && b.quota.error" class="muted ellipsis" :title="b.quota.error">读不到：{{ b.quota.error }}</span>
            <span class="spacer" />
            <button class="btn ghost sm" :disabled="!!busy" @click="readQuota(b)">{{ busy === `${b.id}:quota` ? "读取中…" : "重新读取" }}</button>
          </div>
          <span class="muted small">{{ POLICY[b.policy] }}{{ b.methodLabel && b.state !== "none" && !source(b) ? ` · 用${b.methodLabel}登录` : "" }}{{ b.expiresAt && b.state === "logged-in" ? ` · ${fmtTime(b.expiresAt)} 到期，到期前自动续` : "" }}{{ b.checkedAt ? ` · 上次检查 ${fmtTime(b.checkedAt)}` : "" }}</span>
          <span v-if="b.error && b.state !== 'logging-in'" class="small warn-text err">{{ b.error }}</span>
          <div v-if="conflict[b.id]" class="conflict" role="alert">
            <Markdown :source="conflict[b.id]" compact breaks :linkify="false" />
            <button class="btn ghost sm" @click="delete conflict[b.id]">知道了</button>
          </div>
        </div>
      </div>
    </template>
  </template>
</template>

<style scoped>
.list {
  display: grid;
  gap: 8px;
}
.acct {
  gap: 6px;
  min-width: 0;
}
.head {
  gap: 8px;
  min-width: 0;
}
.tight {
  gap: 4px;
}
.tight-row {
  gap: 6px;
  min-width: 0;
}
.login {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--warn-soft);
  min-width: 0;
}
.code {
  margin-left: 6px;
  letter-spacing: 0.08em;
}
.link {
  max-width: 100%;
  min-width: 0;
  flex: 1 1 200px;
}
.quota {
  gap: 6px;
  min-width: 0;
}
.err {
  overflow-wrap: anywhere;
}
.conflict {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
