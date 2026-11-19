<script setup lang="ts">
import { onMounted, ref } from "vue";
import { del, get, put } from "../api";
import { fmtTime, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import HelpText from "./HelpText.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * The owner's side of members' own AI accounts (docs/v2/agent-accounts.md): per backend, whether a
 * member who has not logged in borrows the owner's login; who logged in to what (no tokens), with a
 * way to log someone out. Shown only where the machine can start the sandbox.
 */
type Policy = "owner" | "own";
type State = "none" | "logged-in" | "expired" | "logging-in";
type Overview = {
  supported: boolean;
  reason?: string;
  bwrap: string | null;
  backends: { id: string; name: string; policy: Policy }[];
  people: { userId: string; name: string; backends: { id: string; name: string; state: State; user?: string; checkedAt?: string }[] }[];
};
const emit = defineEmits<{ policies: [accounts: Record<string, Policy>] }>();

const data = ref<Overview | null>(null);
async function load() {
  try {
    data.value = await get<Overview>("/api/agent-accounts");
  } catch {
    data.value = null;
  }
}
onMounted(load);

const STATE: Record<State, string> = { none: "没登录", "logged-in": "已登录", expired: "登录过期", "logging-in": "登录中" };
const OPTIONS: { value: Policy; label: string }[] = [
  { value: "owner", label: "借用本人的" },
  { value: "own", label: "只能用自己的" },
];

async function setPolicy(backend: string, policy: Policy) {
  try {
    await put(`/api/agent-accounts/${backend}/policy`, { policy });
    const b = data.value?.backends.find((x) => x.id === backend);
    if (b) b.policy = policy;
    emit("policies", Object.fromEntries((data.value?.backends ?? []).map((x) => [x.id, x.policy])));
    toast(policy === "own" ? "已保存：没登录的成员用不了这个后端" : "已保存：没登录的成员借用你的登录", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
    await load();
  }
}
async function remove(person: Overview["people"][number], b: { id: string; name: string }) {
  if (!(await confirmDialog(`让 ${person.name} 退出 ${b.name}`, { message: `删除 ${person.name} 在这台机器上的 ${b.name} 登录和它的文件。之后他的运行按上面的规则处理。`, okText: "退出并删除", danger: true }))) return;
  try {
    await del(`/api/agent-accounts/${encodeURIComponent(person.userId)}/${b.id}`);
    toast(`${person.name} 已退出 ${b.name}`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
  await load();
}
</script>

<template>
  <div v-if="data?.supported" class="card pad stack">
    <strong>成员的 AI 账号</strong>
    <HelpText>成员可以在自己的“账号”页登录各个后端，之后他发起的运行就用他自己的账号，额度和使用记录算在他名下。这台机器上所有人的 Agent 都以同一个系统用户运行，靠 bubblewrap 沙箱把各人的账号目录隔开：成员的运行看不到你的登录、omem 的数据目录和别人的账号目录。下面按后端设定成员没登录时怎么办：借用你的登录（和以前一样），或者这个后端只能用他自己的账号（运行失败并提示他去登录）。你自己的运行不受影响，照旧用这台机器上的登录。</HelpText>
    <div v-for="b in data.backends" :key="b.id" class="row wrap line">
      <span class="name">{{ b.name }}</span>
      <span class="spacer" />
      <UiSegmented :model-value="b.policy" size="sm" :aria-label="`${b.name}：成员没登录时`" :options="OPTIONS" @change="(v) => setPolicy(b.id, v)" />
    </div>
    <div class="small muted">{{ data.people.length ? "已登录的成员" : "还没有成员登录自己的账号。" }}<template v-if="data.bwrap"> · bubblewrap {{ data.bwrap }}</template></div>
    <div v-for="p in data.people" :key="p.userId" class="stack person">
      <span class="small"><strong>{{ p.name }}</strong> <span class="muted mono">{{ p.userId }}</span></span>
      <div v-for="b in p.backends" :key="b.id" class="row wrap line">
        <span>{{ b.name }}</span>
        <span class="badge" :class="{ accent: b.state === 'logged-in', danger: b.state === 'expired', warn: b.state === 'logging-in' }">{{ STATE[b.state] }}</span>
        <span v-if="b.user" class="muted small ellipsis" :title="b.user">{{ b.user }}</span>
        <span v-if="b.checkedAt" class="muted small">检查于 {{ fmtTime(b.checkedAt) }}</span>
        <span class="spacer" />
        <button class="btn ghost sm danger" @click="remove(p, b)">让他退出</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.line {
  gap: 8px;
  min-width: 0;
  border-top: 1px solid var(--line);
  padding-top: 6px;
}
.name {
  min-width: 0;
}
.person {
  gap: 4px;
  min-width: 0;
}
</style>
