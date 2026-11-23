<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { del, get, post } from "../api";
import { confirmDialog } from "../lib/dialog";
import { toast } from "../store";
import { fmt } from "../lib/time";

/**
 * This machine's own login to one backend (src/agents/machine-login.ts), in settings → AI: whether the
 * service is logged in, and logging it in from the page. The login command runs on the machine; the
 * link, the device code and (for a login that waits for it) the box for the authorization page's code
 * are shown here, so nobody has to go to the machine. Hidden when the catalog has no login for it.
 */
type Info = {
  backend: string; name: string; canLogin: boolean; canCheck: boolean;
  state: "unknown" | "logged-in" | "none"; user?: string; error?: string; checkedAt?: string;
  pending: { url: string; code?: string; input: boolean; startedAt: string; sent?: boolean } | null;
  /** Another login of the owner's can be added (src/agents/login-slots.ts); this one is such a login. */
  canAdd?: boolean; extra?: boolean;
};
const props = defineProps<{ backend: string }>();
const emit = defineEmits<{ changed: [] }>();
const info = ref<Info | null>(null);
const busy = ref("");
const pasted = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
const base = () => `/api/agents/${encodeURIComponent(props.backend)}/machine-login`;

async function load(check = false) {
  try {
    info.value = await get<Info>(`${base()}${check ? "?check=1" : ""}`);
  } catch {
    info.value = null;
  }
  follow();
}
/** While a login is open, look every few seconds; once it closes, the server checks and this shows the result. */
let wasPending = false;
function follow() {
  clearTimeout(timer);
  const p = !!info.value?.pending;
  if (p) timer = setTimeout(() => void load(), 3000);
  else if (wasPending) timer = setTimeout(() => void load(), 2500);
  if (wasPending && !p && info.value?.state === "logged-in") toast(`${info.value.name} 已登录${info.value.user ? `：${info.value.user}` : ""}`, "ok");
  wasPending = p;
}
onMounted(() => void load(true));
onBeforeUnmount(() => clearTimeout(timer));

async function run(what: string, fn: () => Promise<Info>) {
  busy.value = what;
  try {
    info.value = await fn();
    follow();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
const start = () => run("login", async () => {
  const r = await post<Info>(base(), {});
  if (r.pending?.url) window.open(r.pending.url, "_blank", "noopener,noreferrer");
  return r;
});
const check = () => run("check", () => get<Info>(`${base()}?check=1`));
const cancel = () => run("cancel", () => del<Info>(base()));
const send = () => run("input", async () => {
  const r = await post<Info>(`${base()}/input`, { text: pasted.value.trim() });
  pasted.value = "";
  return r;
});
async function addLogin() {
  busy.value = "add";
  try {
    const r = await post<{ name: string }>(`/api/agents/${encodeURIComponent(props.backend)}/logins`, {});
    toast(`已加上「${r.name}」，在它的卡片里登录`, "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
async function removeLogin() {
  if (!info.value || !(await confirmDialog(`删除「${info.value.name}」？`, { message: "这个账号的登录和它的目录一起删掉，选了它的角色、档位和候选也一并去掉。账号本身不受影响，以后可以再加回来重新登录。", okText: "删除", danger: true }))) return;
  busy.value = "remove";
  try {
    await del(`/api/agents/${encodeURIComponent(props.backend)}/logins`);
    toast("已删除", "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("已复制", "ok"), () => {});
const when = (iso: string) => fmt(iso, { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <section v-if="info && (info.canLogin || info.canCheck)" class="part">
    <h4>{{ info.extra ? "这个账号的登录" : "这台机器的登录" }}</h4>
    <div class="row wrap small">
      <span class="badge" :class="{ accent: info.state === 'logged-in', warn: info.state === 'none' || !!info.pending }">{{ info.pending ? "登录中" : info.state === "logged-in" ? "已登录" : info.state === "none" ? "没登录" : "没检查" }}</span>
      <span v-if="info.user" class="muted ell" :title="info.user">{{ info.user }}</span>
      <span v-if="info.checkedAt" class="muted">· {{ when(info.checkedAt) }} 检查</span>
      <span class="spacer" />
      <template v-if="!info.pending">
        <button v-if="info.canCheck" class="btn ghost sm" :disabled="!!busy" @click="check">{{ busy === "check" ? "检查中…" : "检查" }}</button>
        <button v-if="info.canLogin" class="btn sm" :class="{ primary: info.state !== 'logged-in' }" :disabled="!!busy" @click="start">{{ busy === "login" ? "正在启动…" : info.state === "logged-in" ? "重新登录" : "登录" }}</button>
      </template>
      <button v-else class="btn ghost sm" :disabled="!!busy" @click="cancel">取消登录</button>
    </div>
    <p v-if="info.state === 'none' && info.error && !info.pending" class="small muted ell" :title="info.error">{{ info.error }}</p>
    <div v-if="info.pending" class="stack tight login">
      <span class="small">在打开的页面里登录{{ info.pending.code ? "，验证码是" : "" }}<strong v-if="info.pending.code" class="mono">{{ info.pending.code }}</strong>。{{ info.pending.input ? "页面最后会给出一段授权码，粘贴到下面提交。" : "" }}{{ info.extra ? "登录的是这个后端的另一个账号，登录状态只放在它自己的目录里。" : "登录的是这台机器上 omem 用的账号：没有自己账号的运行都用它。" }}</span>
      <span class="row wrap tight-row">
        <a :href="info.pending.url" target="_blank" rel="noopener noreferrer" class="mono small ell link" :title="info.pending.url">{{ info.pending.url }}</a>
        <button class="btn ghost sm" @click="copy(info.pending.url)">复制链接</button>
        <button v-if="info.pending.code" class="btn ghost sm" @click="copy(info.pending.code!)">复制验证码</button>
      </span>
      <form v-if="info.pending.input" class="row wrap tight-row" @submit.prevent="send">
        <input v-model="pasted" class="input sm mono grow" maxlength="4000" autocomplete="off" spellcheck="false" placeholder="授权页给出的授权码" aria-label="授权码" />
        <button class="btn sm primary" type="submit" :disabled="!!busy || !pasted.trim()">{{ busy === "input" ? "提交中…" : info.pending.sent ? "再提交一次" : "提交" }}</button>
      </form>
    </div>
    <p v-else-if="!info.canLogin" class="small muted">这个后端没有无界面的登录方式，要在这台机器的终端里登录。</p>
    <div v-if="(info.canAdd || info.extra) && !info.pending" class="row wrap small">
      <span class="muted grow">{{ info.extra ? "另加的账号：有自己的登录目录、额度和用量，可以单独选给角色或候选。" : "同一个后端可以再登录一个账号：它会作为单独的后端出现，有自己的登录目录和额度。" }}</span>
      <button v-if="info.canAdd" class="btn ghost sm" :disabled="!!busy" @click="addLogin">{{ busy === "add" ? "正在加…" : "再加一个账号" }}</button>
      <button v-if="info.extra" class="btn ghost sm danger" :disabled="!!busy" @click="removeLogin">{{ busy === "remove" ? "正在删除…" : "删除这个账号" }}</button>
    </div>
  </section>
</template>

<style scoped>
.part { display: grid; gap: 8px; padding: 12px 0; border-top: 1px dashed var(--line); min-width: 0; }
.part h4 { margin: 0; font-size: 13px; font-weight: 600; }
.part p { margin: 0; }
.login { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); min-width: 0; }
.tight { gap: 6px; }
.tight-row { gap: 6px; min-width: 0; }
.ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.link { flex: 1 1 0; }
.grow { flex: 1 1 200px; min-width: 0; }
</style>
