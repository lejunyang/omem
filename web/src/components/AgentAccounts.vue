<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { del, get, post } from "../api";
import { fmtTime, toast } from "../store";
import { confirmDialog, promptDialog } from "../lib/dialog";

/**
 * 我的 AI 账号 (docs/v2/agent-accounts.md): the backends a person can log in to with their own
 * account; their runs on them then use it. Shown only where the machine can start the sandbox.
 */
type Backend = { id: string; name: string; policy: "owner" | "own"; login: boolean; token: boolean; state: "none" | "logged-in" | "expired" | "logging-in"; user?: string; checkedAt?: string; error?: string; url?: string; code?: string };
type Mine = { supported: boolean; reason?: string; owner: boolean; backends: Backend[] };

const mine = ref<Mine | null>(null);
const busy = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  try {
    mine.value = await get<Mine>("/api/me/agent-accounts");
  } catch {
    mine.value = null;
  }
  clearTimeout(timer);
  // A login in progress ends on the provider's page: look again until it does.
  if (mine.value?.backends.some((b) => b.state === "logging-in")) timer = setTimeout(load, 3000);
}
onMounted(load);
onBeforeUnmount(() => clearTimeout(timer));

const STATE: Record<Backend["state"], string> = { none: "没登录", "logged-in": "已登录", expired: "登录过期", "logging-in": "登录中" };
const policyText = (b: Backend) => (b.policy === "own" ? "没登录时这个后端用不了" : "没登录时借用 omem 主人的");

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
    const r = await post<{ url: string; code?: string }>(`/api/me/agent-accounts/${b.id}/login`);
    window.open(r.url, "_blank", "noopener,noreferrer");
  });
const pasteToken = (b: Backend) =>
  act(b, "token", async () => {
    const token = await promptDialog(`粘贴 ${b.name} 的令牌`, { message: "在你自己的电脑上生成一个长期令牌（Claude Code 是 claude setup-token），粘贴到这里。令牌只存在运行 omem 的这台机器的密钥库里，不进配置文件，也不会显示出来。", placeholder: "令牌", okText: "保存" });
    if (!token?.trim()) return;
    const r = await post<{ state: string }>(`/api/me/agent-accounts/${b.id}/token`, { token: token.trim() });
    toast(r.state === "logged-in" ? `${b.name} 已登录` : `令牌已保存，但 ${b.name} 说还没登录`, r.state === "logged-in" ? "ok" : "error");
  });
const check = (b: Backend) => act(b, "check", () => post(`/api/me/agent-accounts/${b.id}/check`));
const logout = async (b: Backend) => {
  if (!(await confirmDialog(`退出 ${b.name}`, { message: `退出后删除你在这台机器上的 ${b.name} 登录和它的文件（会话记录、设置）。之后你的运行${b.policy === "own" ? "用不了这个后端，直到你重新登录" : "借用 omem 主人的登录"}。`, okText: "退出并删除", danger: true }))) return;
  await act(b, "logout", () => del(`/api/me/agent-accounts/${b.id}`));
};
const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("已复制", "ok"), () => {});
</script>

<template>
  <template v-if="mine?.supported">
    <h2 class="section-title">我的 AI 账号</h2>
    <p v-if="mine.owner" class="muted small">你用运行 omem 的这台机器上已有的登录，不用在这里登录。成员没登录时借不借用你的，在 <router-link to="/settings?tab=agents">设置 → AI</router-link> 里按后端设。</p>
    <template v-else>
      <p class="muted small">在这里登录以后，你发起的运行就用你自己的账号，额度和使用记录算在你名下。这台机器上所有人的 Agent 都以同一个系统用户运行，靠沙箱把各人的账号目录隔开：你的运行看不到别人的目录，也看不到 omem 主人的登录。</p>
      <div class="list">
        <div v-for="b in mine.backends" :key="b.id" class="card pad stack acct">
          <div class="row wrap head">
            <strong>{{ b.name }}</strong>
            <span class="badge" :class="{ accent: b.state === 'logged-in', danger: b.state === 'expired', warn: b.state === 'logging-in' }">{{ STATE[b.state] }}</span>
            <span v-if="b.user" class="muted small ellipsis" :title="b.user">{{ b.user }}</span>
            <span class="spacer" />
            <template v-if="b.state !== 'logging-in'">
              <button v-if="b.login" class="btn sm" :class="{ primary: b.state !== 'logged-in' }" :disabled="!!busy" @click="login(b)">{{ busy === `${b.id}:login` ? "正在启动…" : b.state === "logged-in" ? "重新登录" : "登录" }}</button>
              <button v-if="b.token" class="btn sm" :class="{ primary: !b.login && b.state !== 'logged-in' }" :disabled="!!busy" @click="pasteToken(b)">粘贴令牌</button>
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
          <span class="muted small">{{ policyText(b) }}{{ b.checkedAt ? ` · 上次检查 ${fmtTime(b.checkedAt)}` : "" }}</span>
          <span v-if="b.error && b.state !== 'logging-in'" class="small warn-text err">{{ b.error }}</span>
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
.err {
  overflow-wrap: anywhere;
}
</style>
