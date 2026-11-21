<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, put } from "../api";
import { relTime, toast } from "../store";
import { egressSettings, inspectDomain, runSummary, type EgressAction, type EgressSettings, type EgressStatus } from "../lib/egress";
import { runName } from "../lib/run-titles";
import Icon from "./Icon.vue";
import MonoLine from "./MonoLine.vue";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * 设置 → 安全 → 出网代理 (src/agents/egress-run.ts, docs/v2/command-gate.md “出网代理”): members' sandboxed
 * runs reach the network only through a proxy on this machine, which judges each host by the operation
 * rules (HTTP kind). The owner's: the whole setting is saved at once (`PUT /api/security/egress`), and
 * below it which hosts recent runs reached and what was refused. A server without it (404) shows nothing.
 */
const status = ref<EgressStatus | null>(null);
const missing = ref(false);
const error = ref("");
async function load() {
  error.value = "";
  try {
    status.value = await get<EgressStatus>("/api/security/egress");
  } catch (e) {
    if ((e as { status?: number }).status === 404) missing.value = true;
    else error.value = (e as Error).message;
  }
}
onMounted(load);

async function save(patch: Partial<EgressSettings>, note: string) {
  if (!status.value) return;
  const next = egressSettings({ ...status.value, ...patch });
  try {
    const saved = await put<EgressSettings>("/api/security/egress", next);
    status.value = { ...status.value, ...saved };
    toast(note, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

const MODES = [
  { value: "strict-only", label: "只管要求隔离的成员" },
  { value: "all-sandboxed", label: "所有进沙箱的运行" },
  { value: "off", label: "关" },
];
const ACTIONS: { value: EgressAction; label: string }[] = [{ value: "allow", label: "放行" }, { value: "approve", label: "要批准" }, { value: "deny", label: "拒绝" }];
const actionText = (a: EgressAction) => ACTIONS.find((x) => x.value === a)?.label ?? a;
const off = computed(() => status.value?.mode === "off");

const domain = ref("");
const domainError = ref("");
function addDomain() {
  if (!status.value) return;
  const r = inspectDomain(domain.value, status.value.inspect);
  if ("error" in r) return void (domainError.value = r.error);
  domainError.value = "";
  domain.value = "";
  void save({ inspect: [...status.value.inspect, r.value] }, `${r.value} 会解密后按路径判定`);
}
function waitSeconds(e: Event) {
  const n = Math.round(Number((e.target as HTMLInputElement).value));
  const v = Number.isFinite(n) ? Math.max(1, Math.min(300, n)) : 90;
  (e.target as HTMLInputElement).value = String(v);
  void save({ waitSeconds: v }, `要批准时最多等 ${v} 秒`);
}

const openRun = ref<number | null>(null);
const allRuns = ref(false);
const runs = computed(() => (status.value?.runs ?? []).slice(0, allRuns.value ? 32 : 6));
</script>

<template>
  <SetCard v-if="!missing" id="set-egress" title="出网代理">
    <template #help>成员在沙箱里跑的命令行工具只能经这台机器上的代理出网，每个主机按操作规则里的 HTTP 规则判定。借别的设备跑的运行不经这台的代理。</template>
    <template v-if="status" #aside>
      <span class="badge" :class="status.support.ok ? 'ok' : 'warn'" :title="status.support.reason ?? ''">{{ status.support.ok ? "这台能用" : "这台用不了" }}</span>
    </template>
    <Skeleton v-if="!status && !error" :rows="3" />
    <div v-else-if="error" class="set-pad row" role="alert"><span class="grow small">读不到出网设置：{{ error }}</span><button class="btn ghost sm" @click="load">重试</button></div>
    <template v-else-if="status">
      <div v-if="!status.support.ok" class="set-pad small warn-text">{{ status.support.reason || "这台机器不能把成员的运行隔开" }}</div>
      <SetRow label="管哪些运行">
        <template #hint>{{ status.mode === "strict-only" ? "只管开了严格隔离的成员的运行" : status.mode === "all-sandboxed" ? "成员进了沙箱的运行都经代理" : "不经代理，沙箱照原样出网" }}</template>
        <UiSegmented :model-value="status.mode" size="sm" aria-label="出网代理管哪些运行" :options="MODES" @change="(v) => save({ mode: v as EgressSettings['mode'] }, `出网代理：${MODES.find((m) => m.value === v)?.label}`)" />
      </SetRow>
      <SetRow label="没有规则命中时" hint="一个主机不在任何 HTTP 规则里" :off="off">
        <UiSegmented :model-value="status.default" size="sm" aria-label="没有规则命中时" :options="ACTIONS" @change="(v) => save({ default: v as EgressAction }, `没有规则命中时${actionText(v as EgressAction)}`)" />
      </SetRow>
      <SetRow label="隧道里判不了时" hint="HTTPS 只看得到主机，规则还要看路径或方法" :off="off">
        <UiSegmented :model-value="status.tunnelWhenUnsure" size="sm" aria-label="隧道里判不了时" :options="ACTIONS" @change="(v) => save({ tunnelWhenUnsure: v as EgressAction }, `隧道里判不了时${actionText(v as EgressAction)}`)" />
      </SetRow>
      <SetRow label="要批准时最多等" hint="秒，1–300；没人回就拒绝" :off="off">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="300" aria-label="要批准时最多等几秒" :value="status.waitSeconds" @change="waitSeconds" />
      </SetRow>
      <SetRow label="解密后按路径判定的域名" block :off="off">
        <template #hint>
          <span class="badge pilot">试点</span>
          钉了证书的客户端连这些域名会失败；解密用的根证书只装进沙箱。
          <span v-if="status.inspectionAvailable === false" class="warn-text">这台没有 openssl，名单里的域名现在解不了密。</span>
        </template>
        <div class="eg-domains">
          <span v-for="d in status.inspect" :key="d" class="eg-chip">
            <span class="mono">{{ d }}</span>
            <button class="x" type="button" :aria-label="`从解密名单去掉 ${d}`" @click="save({ inspect: status!.inspect.filter((x) => x !== d) }, `${d} 不再解密`)"><Icon name="x" :size="12" /></button>
          </span>
          <form class="eg-add" @submit.prevent="addDomain">
            <input v-model="domain" class="input sm mono" placeholder="api.example.com" aria-label="要解密的域名" spellcheck="false" maxlength="253" />
            <button class="btn ghost sm" type="submit"><Icon name="plus" :size="13" />加入</button>
          </form>
          <span v-if="domainError" class="small warn-text" role="alert">{{ domainError }}</span>
        </div>
      </SetRow>

      <div class="set-pad">
        <div class="eg-head"><span class="eg-k">最近的运行连了哪些主机</span><span v-if="status.pending.length" class="badge warn">{{ status.pending.length }} 个等批准</span></div>
        <p v-if="!status.runs.length" class="small muted">还没有经代理出网的运行。</p>
        <div v-for="(r, i) in runs" :key="r.runId ?? i" class="eg-run" :class="{ open: openRun === i }">
          <button type="button" class="eg-run-row" :aria-expanded="openRun === i" @click="openRun = openRun === i ? null : i">
            <span class="eg-run-title">{{ runName(r) }}</span>
            <span class="eg-run-meta" :class="{ 'has-denied': runSummary(r.hosts).denied }">{{ runSummary(r.hosts).text }}</span>
            <Icon name="down" :size="14" class="eg-chev" />
          </button>
          <div v-if="openRun === i" class="eg-hosts">
            <RouterLink v-if="r.runId" class="small" :to="`/runs/${r.runId}`">打开这个运行</RouterLink>
            <div v-for="h in r.hosts" :key="h.host" class="eg-host small">
              <MonoLine :text="h.host" />
              <span class="muted">{{ h.count }} 次{{ h.backend ? " · 后端" : "" }}</span>
              <span v-if="h.denied" class="eg-denied" :title="h.error ?? ''">拒绝 {{ h.denied }}</span>
            </div>
          </div>
        </div>
        <button v-if="status.runs.length > 6" class="btn ghost sm eg-more" @click="allRuns = !allRuns">{{ allRuns ? "只看最近的" : `全部 ${status.runs.length} 个` }}</button>
      </div>
      <div v-if="status.denied.length" class="set-pad">
        <span class="eg-k">最近被拒的</span>
        <div v-for="(d, i) in status.denied.slice(0, 6)" :key="i" class="eg-host small">
          <MonoLine :text="d.host" />
          <span class="muted">{{ d.count }} 次 · {{ d.at ? relTime(new Date(d.at).toISOString()) : "" }}</span>
          <RouterLink v-if="d.runId" class="eg-deny-run" :to="`/runs/${d.runId}`" :title="d.reason ?? ''">{{ runName(d) }}</RouterLink>
        </div>
      </div>
    </template>
  </SetCard>
</template>

<style scoped>
.grow {
  flex: 1;
  min-width: 0;
}
.pilot {
  margin-right: 4px;
}
.eg-domains {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.eg-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  height: 28px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 12px;
  min-width: 0;
}
.eg-chip .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.x {
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  padding: 4px;
  border-radius: 999px;
}
.x:hover {
  color: var(--danger);
}
.eg-add {
  display: inline-flex;
  gap: 8px;
  min-width: 0;
}
.eg-add .input {
  width: 200px;
  max-width: 100%;
  min-width: 0;
}
.eg-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.eg-k {
  font-size: 13px;
  color: var(--ink-2);
}
.eg-run-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 6px 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.eg-run-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eg-run-meta {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.eg-run-meta.has-denied {
  color: var(--danger);
}
.eg-chev {
  flex: none;
  color: var(--muted);
}
.eg-run.open .eg-chev {
  transform: rotate(180deg);
}
.eg-hosts {
  display: grid;
  gap: 4px;
  padding: 0 0 8px 12px;
  border-left: 2px solid var(--line);
}
.eg-host {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.eg-denied {
  color: var(--danger);
}
.eg-deny-run {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eg-more {
  justify-self: start;
}
</style>
