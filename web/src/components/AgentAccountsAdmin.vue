<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { del, get, put } from "../api";
import { fmtTime, state, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * The owner's side of members' own AI accounts (docs/v2/agent-accounts.md): per backend, whether a
 * member who has not logged in borrows the owner's login; who logged in to what (no tokens), with a
 * way to log someone out. Above them, whether this machine can isolate a member's runs at all and
 * what happens to a run that cannot be (`agents.accountIsolation`: run it and note it, or do not run it).
 */
type Policy = "owner" | "own" | "own-or-other";
type State = "none" | "logged-in" | "expired" | "logging-in";
type Mode = "prefer" | "require";
/** Where a backend runs and whether a member's run on it can be kept apart (src/agents/accounts.ts isolationStatus). */
type Isolation = { ok: boolean; reason?: string; mode: Mode; profiles: { id: string; execution: "local" | "cloud" | "peer"; supported: boolean; reason?: string }[] };
type Overview = {
  isolation?: Isolation;
  supported: boolean;
  reason?: string;
  bwrap: string | null;
  backends: { id: string; name: string; policy: Policy }[];
  people: { userId: string; name: string; backends: { id: string; name: string; state: State; user?: string; checkedAt?: string; methodLabel?: string }[] }[];
};
const props = defineProps<{ /** Names of the backends by id, for the ones that cannot be isolated. */ names?: Record<string, string> }>();
const emit = defineEmits<{ policies: [accounts: Record<string, Policy>]; mode: [mode: Mode] }>();

const data = ref<Overview | null>(null);
async function load() {
  // The owner's to see and set: nobody else asks.
  if (state.me && state.me.role !== "owner") return;
  try {
    data.value = await get<Overview>("/api/agent-accounts");
  } catch {
    data.value = null;
  }
}
onMounted(load);

const MODES: { value: Mode; label: string }[] = [{ value: "prefer", label: "照常运行，记一笔" }, { value: "require", label: "不运行" }];
/** Backends a member's run cannot be isolated on although the machine can: by why, with their names. */
const apart = computed(() => {
  const by = new Map<string, string[]>();
  for (const p of data.value?.isolation?.profiles ?? []) {
    if (p.supported || (p.execution === "local" && !data.value?.isolation?.ok)) continue;
    const why = p.reason ?? "不能隔离";
    by.set(why, [...(by.get(why) ?? []), props.names?.[p.id] ?? p.id]);
  }
  return [...by].map(([why, names]) => `${names.join("、")}（${why}）`);
});
/** Members who logged in to something: one who never did has nothing to show or to log out of. */
const loggedIn = computed(() => (data.value?.people ?? []).filter((p) => p.backends.length));
function setMode(mode: Mode) {
  if (data.value?.isolation) data.value.isolation.mode = mode;
  emit("mode", mode);
}

const STATE: Record<State, string> = { none: "没登录", "logged-in": "已登录", expired: "登录过期", "logging-in": "登录中" };
const OPTIONS: { value: Policy; label: string }[] = [
  { value: "owner", label: "借用本人的" },
  { value: "own-or-other", label: "换别的后端" },
  { value: "own", label: "只能用自己的" },
];
const SAVED: Record<Policy, string> = {
  owner: "已保存：没登录的成员借用你的登录",
  own: "已保存：没登录的成员用不了这个后端",
  "own-or-other": "已保存：没登录的成员换一个他登录过、或允许借用的后端",
};

async function setPolicy(backend: string, policy: Policy) {
  try {
    await put(`/api/agent-accounts/${backend}/policy`, { policy });
    const b = data.value?.backends.find((x) => x.id === backend);
    if (b) b.policy = policy;
    emit("policies", Object.fromEntries((data.value?.backends ?? []).map((x) => [x.id, x.policy])));
    toast(SAVED[policy], "ok");
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
  <SetCard v-if="data && (data.supported || data.isolation)" id="set-agent-accounts" title="成员的 AI 账号">
    <template #help>成员可以在自己的“账号”页登录各个后端，之后他发起的运行就用他自己的账号，额度和使用记录算在他名下。这台机器上所有人的 Agent 都以同一个系统用户运行，靠 bubblewrap 沙箱把各人的账号目录隔开：成员的运行看不到你的登录、omem 的数据目录和别人的账号目录。下面按后端设定成员没登录时怎么办：借用你的登录（和以前一样）；换别的后端（按这次运行的选型和兜底顺序，换一个他登录过、或允许借用的后端，都没有才失败）；或者这个后端只能用他自己的账号（运行失败并提示他去登录）。你自己的运行不受影响，照旧用这台机器上的登录。插件可以给某个后端加登录方式（比如用公司账号登录），成员在自己的页面上选。停用一个成员时，他的所有登录和账号目录一并删除。</template>
    <template v-if="data.isolation">
      <SetRow label="成员的运行和你的分开吗">
        <template #hint>
          <template v-if="data.isolation.ok">这台机器可以：成员的 Agent 看不到你的登录、数据目录和别人的工作区。</template>
          <span v-else class="warn-text">这台机器不能：{{ data.isolation.reason }}。成员的运行用的是服务进程的环境和你的登录。</span>
        </template>
        <span class="badge" :class="data.isolation.ok ? 'ok' : 'warn'">{{ data.isolation.ok ? "能隔离" : "不能隔离" }}</span>
      </SetRow>
      <SetRow label="成员的运行不能隔离时" :hint="data.isolation.mode === 'require' ? '不启动，告诉他原因；有能隔离的后端就换过去' : '照常运行，在那次运行里记下没有隔离和原因'">
        <UiSegmented :model-value="data.isolation.mode" size="sm" aria-label="成员的运行不能隔离时" :options="MODES" @change="setMode" />
      </SetRow>
      <p v-if="apart.length" class="set-link muted iso-apart">在这些后端上成员的运行分不开：{{ apart.join("；") }}。</p>
    </template>
    <template v-if="data.supported">
    <div class="set-pad small muted head">成员没登录时，每个后端怎么办<template v-if="data.bwrap"> · bubblewrap {{ data.bwrap }}</template></div>
    <SetRow v-for="b in data.backends" :key="b.id" :label="b.name">
      <UiSegmented :model-value="b.policy" size="sm" :aria-label="`${b.name}：成员没登录时`" :options="OPTIONS" @change="(v) => setPolicy(b.id, v)" />
    </SetRow>
    <div class="set-pad">
    <div class="small muted">{{ loggedIn.length ? "已登录的成员" : "还没有成员登录自己的账号。" }}</div>
    <div v-for="p in loggedIn" :key="p.userId" class="stack person">
      <span class="small"><strong>{{ p.name }}</strong></span>
      <div v-for="b in p.backends" :key="b.id" class="row wrap line">
        <span>{{ b.name }}</span>
        <span class="badge" :class="{ accent: b.state === 'logged-in', danger: b.state === 'expired', warn: b.state === 'logging-in' }">{{ STATE[b.state] }}</span>
        <span v-if="b.user" class="muted small ellipsis" :title="b.user">{{ b.user }}</span>
        <span v-if="b.methodLabel" class="muted small">{{ b.methodLabel }}</span>
        <span v-if="b.checkedAt" class="muted small">检查于 {{ fmtTime(b.checkedAt) }}</span>
        <span class="spacer" />
        <button class="btn ghost sm danger" @click="remove(p, b)">让他退出</button>
      </div>
    </div>
    </div>
    </template>
  </SetCard>
</template>

<style scoped>
.line {
  gap: 8px;
  min-width: 0;
  border-top: 1px solid var(--line);
  padding-top: 6px;
}
.head {
  padding-bottom: 4px;
}
.head + :deep(.set-row) {
  border-top: 0;
}
.person {
  gap: 4px;
  min-width: 0;
}
.warn-text {
  color: var(--warn);
}
.iso-apart {
  border-top: 1px solid var(--line);
}
</style>
