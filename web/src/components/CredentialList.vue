<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { del, get, post, put } from "../api";
import { fmtTime, state, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import { hasCap } from "../lib/caps";
import {
  stateLabel, SCOPE_LABEL, canCancel, coverage, credAnchor, expiryText, lendCandidates, lendingNote, needsAction, settled, sharingBody, sharingSaved, stateTone,
  type Credential, type SharingScope,
} from "../lib/credentials";
import ChipPicker from "./ChipPicker.vue";
import HelpText from "./HelpText.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * 账号 → 凭据 (src/agents/credentials.ts, docs/v2/credentials.md): the kinds plugins registered, one row
 * each — whether this person is logged in and until when, what it supplies, logging in or out, and who
 * may borrow it. The owner's are the logins already on this machine: logged in here only when the plugin
 * offers the tool's own login for it. `?login=<kind>` (a reminder's link) starts that login as the page opens.
 * Nothing shows when no plugin registered one. `loaded`: the list, for “我的 AI 账号” to mark the backends
 * a credential supplies; `changed`: a login or logout finished (the backends' states changed too).
 */
const props = defineProps<{ /** Backend names by id, from 我的 AI 账号. */ backendNames?: Record<string, string> }>();
const emit = defineEmits<{ loaded: [list: Credential[]]; changed: [] }>();

const list = ref<Credential[] | null>(null);
const busy = ref<string | null>(null);
const open = ref<Record<string, boolean>>({});
/** Who one can lend to: `candidates` of GET /api/credentials (every active person but the owner and oneself). */
const people = ref<{ value: string; label: string }[] | null>(null);
const peopleAsked = ref(false);
/** The server sent its list (possibly empty: nobody else to lend to), so the member list is not needed. */
const candidatesSent = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
/** Polling a login stops after this long even if the server still says 登录中 (it gives up at 11 minutes). */
const POLL_FOR = 12 * 60_000;
let pollUntil = 0;

async function load() {
  const before = list.value ?? [];
  try {
    const res = await get<{ credentials: Credential[]; candidates?: { id: string; name: string }[] }>("/api/credentials");
    list.value = res.credentials;
    if (Array.isArray(res.candidates)) {
      candidatesSent.value = true;
      people.value = res.candidates.length ? res.candidates.map((c) => ({ value: c.id, label: c.name })) : null;
    }
  } catch {
    list.value = list.value ?? [];
  }
  emit("loaded", list.value);
  const done = settled(before, list.value);
  for (const d of done) toast(d.ok ? `${d.name} 已登录` : `${d.name} 没有登录成功${d.error ? `：${d.error}` : ""}`, d.ok ? "ok" : "error");
  if (done.length) emit("changed");
  clearTimeout(timer);
  // A login going on ends on the provider's page: look again until it does (as 我的 AI 账号 does).
  if (list.value.some((c) => c.state === "logging-in") && Date.now() < pollUntil) timer = setTimeout(load, 3000);
}
async function loadPeople() {
  try {
    // An older server without candidates: only someone who may read the member list can pick people.
    if (!candidatesSent.value && hasCap("settings.members")) {
      const users = await get<{ id: string; name: string; role: string; status?: string; disabledAt?: string | null }[]>("/api/users");
      people.value = lendCandidates(users, state.me?.id ?? "owner");
    }
  } catch {
    people.value = null;
  } finally {
    peopleAsked.value = true;
  }
}
const route = useRoute();
const router = useRouter();
/** A reminder's link: start the login now and show its link in the row (a window opened without a click would be blocked). */
async function loginFromLink() {
  const kind = typeof route.query.login === "string" ? route.query.login : "";
  if (!kind) return;
  void router.replace({ query: { ...route.query, login: undefined } });
  const c = list.value?.find((x) => x.kind === kind);
  if (!c) return;
  await nextTick();
  document.getElementById(credAnchor(c.kind))?.scrollIntoView({ block: "center" });
  if (c.login && c.state !== "logging-in") await login(c, false);
}
onMounted(async () => {
  pollUntil = Date.now() + POLL_FOR;
  await load();
  await loginFromLink();
  if (list.value?.length) await loadPeople();
});
onBeforeUnmount(() => clearTimeout(timer));
defineExpose({ reload: load });

const nameOf = (id: string) => people.value?.find((p) => p.value === id)?.label ?? id;
const backendName = (id: string) => props.backendNames?.[id] ?? id;
const missing = computed(() => (list.value ?? []).filter(needsAction).length);

async function login(c: Credential, openPage = true) {
  busy.value = `${c.kind}:login`;
  try {
    const r = await post<{ url?: string; code?: string; done?: boolean }>(`/api/credentials/${encodeURIComponent(c.kind)}/login`);
    if (r.url && openPage) window.open(r.url, "_blank", "noopener,noreferrer");
    else if (r.done) {
      toast(`${c.name} 已登录`, "ok");
      emit("changed");
    }
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = null;
    pollUntil = Date.now() + POLL_FOR;
    await load();
  }
}
async function logout(c: Credential) {
  const covers = coverage(c, backendName);
  const what = [...covers.backends, ...covers.commands].join("、");
  if (!(await confirmDialog(`退出 ${c.name}`, { message: `${what ? `它供给的 ${what} 都会一起退出，` : ""}这台机器上为你保存的登录文件也一起删除；借你这份登录的同事也用不了了。之后要用再登录。`, okText: "退出", danger: true }))) return;
  await remove(c, `已退出 ${c.name}`);
}
/** Stopping a first login: the same DELETE, nothing logged in before it to lose. */
const cancel = (c: Credential) => remove(c, `已取消 ${c.name} 的登录`);
async function remove(c: Credential, note: string) {
  busy.value = `${c.kind}:logout`;
  try {
    await del(`/api/credentials/${encodeURIComponent(c.kind)}`);
    toast(note, "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = null;
    await load();
  }
}
/**
 * 指定成员 chosen but nobody picked yet: shown as chosen, nothing saved (saving it now would stop lending
 * to whoever may borrow it today). The first person picked saves it.
 */
const picking = ref<Record<string, boolean>>({});
const scopeOf = (c: Credential) => (picking.value[c.kind] ? "members" : c.sharing.scope);
function choose(c: Credential, scope: SharingScope) {
  if (scope === "members" && c.sharing.scope !== "members") picking.value = { ...picking.value, [c.kind]: true };
  else {
    picking.value = { ...picking.value, [c.kind]: false };
    if (scope !== c.sharing.scope) void share(c, scope);
  }
}
/** Saves who may borrow it: a scope, or under 指定成员 each person added or removed. */
async function share(c: Credential, scope: SharingScope, members = c.sharing.members) {
  const body = sharingBody(scope, members);
  picking.value = { ...picking.value, [c.kind]: false };
  try {
    const r = await put<{ sharing: Credential["sharing"] }>(`/api/credentials/${encodeURIComponent(c.kind)}/sharing`, body);
    c.sharing = r.sharing;
    toast(sharingSaved(r.sharing, nameOf), "ok");
  } catch (e) {
    toast((e as Error).message, "error");
    await load();
  }
}
/** 指定成员 is offered when the people can be listed, or it is what is set now. */
const scopes = (c: Credential) =>
  (["self", "members", "all"] as SharingScope[]).filter((s) => s !== "members" || people.value || c.sharing.scope === "members").map((s) => ({ value: s, label: SCOPE_LABEL[s] }));
const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("已复制", "ok"), () => {});
const fullTime = (ms?: number) => (ms === undefined ? "" : fmtTime(new Date(ms).toISOString()));
</script>

<template>
  <template v-if="list?.length">
    <div class="row cred-title">
      <h2 class="section-title">凭据</h2>
      <span v-if="missing" class="badge warn">{{ missing }} 项必做</span>
    </div>
    <HelpText v-if="list.every((c) => c.machine)">这台机器上已有的登录供给下面写的 AI 后端和命令行；可以借给成员用，借给谁在每一行里选。</HelpText>
    <HelpText v-else>登录一次，就能供给下面写的几个 AI 后端和命令行；可以借给同事用。到期前会自动续，续不了时会通知你重新授权。</HelpText>
    <div class="card cred-list">
      <div v-for="c in list" :id="credAnchor(c.kind)" :key="c.kind" class="cred" tabindex="-1">
        <div class="cred-head">
          <span class="cred-name">{{ c.name }}</span>
          <span v-if="c.required" class="badge" :class="{ warn: needsAction(c) }" :title="needsAction(c) ? '还没登录：要用的工具得先登录它' : '使用这些工具需要这份凭据'">必做</span>
          <span class="cred-state" :class="stateTone(c.state)"><span class="dot" aria-hidden="true" />{{ stateLabel(c) }}</span>
          <span v-if="expiryText(c)" class="muted small" :title="fullTime(c.expiresAt)">{{ expiryText(c) }}</span>
          <span v-if="c.user && c.state !== 'none'" class="muted small ellipsis cred-user" :title="c.user">{{ c.user }}</span>
          <span class="spacer" />
          <span v-if="c.login" class="cred-ops">
            <template v-if="c.state === 'logging-in'">
              <button v-if="canCancel(c)" class="btn ghost sm danger" :disabled="!!busy" @click="cancel(c)">取消</button>
            </template>
            <template v-else>
              <button class="btn sm" :class="{ primary: c.state === 'none' || c.state === 'expired' }" :disabled="!!busy" @click="login(c)">{{ busy === `${c.kind}:login` ? "正在启动…" : c.state === "none" ? "登录" : "重新授权" }}</button>
              <button v-if="c.state !== 'none' && !c.machine" class="btn ghost sm danger" :disabled="!!busy" @click="logout(c)">退出</button>
            </template>
          </span>
        </div>
        <div class="cred-sub small">
          <span v-if="c.describe" class="cred-desc">{{ c.describe }}</span>
          <button v-if="coverage(c).count" type="button" class="lnk small" :aria-expanded="!!open[c.kind]" :aria-controls="`${credAnchor(c.kind)}-cover`" @click="open[c.kind] = !open[c.kind]">{{ open[c.kind] ? "收起" : `供给 ${coverage(c).count} 项` }}</button>
        </div>
        <dl v-if="open[c.kind]" :id="`${credAnchor(c.kind)}-cover`" class="cred-cover small">
          <template v-if="c.backends.length"><dt>AI 后端</dt><dd>{{ coverage(c, backendName).backends.join("、") }}</dd></template>
          <template v-if="c.commands.length"><dt>命令行</dt><dd class="mono">{{ c.commands.join("  ") }}</dd></template>
        </dl>
        <div v-if="c.state === 'logging-in'" class="cred-login small">
          <template v-if="c.url">
            <span>在打开的页面里完成授权{{ c.code ? "，验证码是" : "" }}<strong v-if="c.code" class="mono code">{{ c.code }}</strong>。完成后这里会自动变成“有效”。</span>
            <span class="cred-link">
              <a :href="c.url" target="_blank" rel="noopener noreferrer" class="mono ellipsis" :title="c.url">{{ c.url }}</a>
              <button class="btn ghost sm" @click="copy(c.url!)">复制链接</button>
              <button v-if="c.code" class="btn ghost sm" @click="copy(c.code!)">复制验证码</button>
            </span>
          </template>
          <span v-else>正在准备授权链接…</span>
          <span v-if="!canCancel(c)" class="muted">11 分钟内没完成会自动取消，原来的登录保留。</span>
        </div>
        <div class="cred-lend" :class="{ off: c.lending === 'off' }">
          <span class="small muted cred-k">谁能借</span>
          <div class="cred-lend-ctl" :inert="c.lending === 'off' || undefined">
            <UiSegmented :model-value="scopeOf(c)" size="sm" :aria-label="`${c.name}借给谁`" :options="scopes(c)" @change="(v) => choose(c, v)" />
            <ChipPicker v-if="scopeOf(c) === 'members' && people" :model-value="c.sharing.members" :options="people" labels add-label="＋ 成员" @update:model-value="(m) => share(c, 'members', m)" />
            <span v-else-if="scopeOf(c) === 'members'" class="small">{{ c.sharing.members.length }} 位成员</span>
            <span v-if="picking[c.kind]" class="small muted">选了人才保存</span>
          </div>
          <span v-if="lendingNote(c.lending)" class="small" :class="c.lending === 'off' ? 'warn-text' : 'muted'">{{ lendingNote(c.lending) }}</span>
        </div>
        <p v-if="c.machine" class="small muted">
          这份凭据使用本机登录。
          <template v-if="c.state === 'unknown'">检查出结果前，成员仍按出借设置借用。</template>
          <template v-else-if="c.state === 'none' || c.state === 'expired'">{{ c.login ? "点“登录”在官方页面授权，完成后自动变成“有效”。" : "请先在本机登录，检查确认后即可按出借设置借用。" }}</template>
        </p>
        <p v-else-if="!c.login && c.reason" class="small warn-text">这台机器上不能登录：{{ c.reason }}</p>
        <p v-if="c.error && c.state !== 'logging-in'" class="small warn-text err">{{ c.error }}</p>
        <p v-if="c.missingInstall.length" class="small muted" :title="c.missingInstall.join('\n')">这台机器上缺 {{ c.missingInstall.length }} 个安装目录，用到的命令行可能跑不了。</p>
      </div>
      <p v-if="peopleAsked && !people && !candidatesSent" class="cred-foot small muted">要借给指定的几个人，得能看成员名单；现在可以选只给自己或所有成员。</p>
    </div>
  </template>
</template>

<style scoped>
.cred-title {
  gap: 8px;
  align-items: center;
}
.cred-title .section-title {
  margin: 0;
}
.cred-list {
  display: grid;
  min-width: 0;
}
.cred {
  display: grid;
  gap: 6px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  min-width: 0;
  scroll-margin-top: 16px;
}
.cred:first-child {
  border-top: 0;
}
.cred > p,
.cred-foot {
  margin: 0;
}
.cred-foot {
  padding: 8px 16px;
  border-top: 1px solid var(--line);
}
.cred:focus-visible,
.cred.flash {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  border-radius: var(--radius);
}
.cred-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  min-width: 0;
}
.cred-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}
.cred-user {
  max-width: 180px;
}
.cred-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--ink-2);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line-strong);
  flex: none;
}
.cred-state.ok .dot { background: var(--ok); }
.cred-state.warn { color: var(--warn); }
.cred-state.warn .dot { background: var(--warn); }
.cred-state.danger { color: var(--danger); }
.cred-state.danger .dot { background: var(--danger); }
.cred-state.accent { color: var(--accent); }
.cred-state.accent .dot { background: var(--accent); }
.cred-ops {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}
.cred-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  min-width: 0;
  color: var(--ink-2);
}
.cred-desc {
  font-size: 13px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.cred-cover {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 12px;
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--sunken);
}
.cred-cover dt {
  color: var(--muted);
}
.cred-cover dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.cred-login {
  display: grid;
  gap: 4px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  min-width: 0;
}
.code {
  margin-left: 6px;
  letter-spacing: 0.08em;
}
.cred-link {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.cred-link a {
  flex: 1 1 200px;
  min-width: 0;
  max-width: 100%;
}
.cred-lend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.cred-lend-ctl {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
}
.cred-lend.off .cred-lend-ctl {
  opacity: 0.55;
}
.cred-k {
  flex: none;
}
.err {
  overflow-wrap: anywhere;
}
</style>
