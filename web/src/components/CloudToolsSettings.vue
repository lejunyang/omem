<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, post } from "../api";
import { relTime, state, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import { CLOUD_TOOLS, cloudConfig, probeState, type CloudProbe, type CloudStatus, type CloudToolsConfig } from "../lib/cloud-tools";
import { useRunTitles } from "../lib/run-titles";
import { useSettings } from "../views/settings/ctx";
import MonoLine from "./MonoLine.vue";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 设置 → 安全 → 云端后端调只读工具 (src/agents/cloud-tools.ts, cloud-probe.ts, docs/v2/external-access.md):
 * a cloud backend without MCP may call a few read-only tools over this omem's public HTTPS address, with
 * a short credential per run. Off by default. Each backend is probed, the owner confirms the result,
 * then it can be named. Only the owner, signed in with a token or a session: a page opened straight on
 * this machine is not enough (the server refuses it), so it says so instead of asking for a token.
 */
const { profiles, saveConfig } = useSettings();
const status = ref<CloudStatus | null>(null);
const missing = ref(false);
const error = ref("");
const local = computed(() => state.me?.via === "local");
const { title, want } = useRunTitles();
async function load() {
  error.value = "";
  try {
    status.value = await get<CloudStatus>("/api/cloud-tools");
    want(status.value.recent.slice(0, 6).map((r) => r.runId));
  } catch (e) {
    if ((e as { status?: number }).status === 404) missing.value = true;
    else error.value = (e as Error).message;
  }
}
onMounted(() => {
  if (!local.value) void load();
});

const name = (id: string) => profiles.value.find((p) => p.id === id)?.name ?? id;
async function save(patch: Partial<CloudToolsConfig>, note: string) {
  if (!status.value) return;
  const next = cloudConfig({ ...status.value, ...patch });
  await saveConfig({ agents: { cloudTools: next } }, note);
  await load();
}
async function credentialIn(v: string) {
  if (v === "message" && !(await confirmDialog("把凭据写进消息？", {
    message: "凭据会留在云端那次会话的历史里，直到会话被删除。它只读、几分钟内有效、只能调上面选的这几个工具，本轮结束就作废。后端有安全通道时用安全通道更好。",
    okText: "写进消息",
  }))) return;
  await save({ credentialIn: v as CloudToolsConfig["credentialIn"] }, v === "message" ? "凭据写进消息" : "凭据走安全通道");
}
function number(e: Event, key: "ttlMinutes" | "maxCalls", max: number, fallback: number) {
  const n = Math.round(Number((e.target as HTMLInputElement).value));
  const v = Number.isFinite(n) ? Math.max(1, Math.min(max, n)) : fallback;
  (e.target as HTMLInputElement).value = String(v);
  void save({ [key]: v }, key === "ttlMinutes" ? `凭据 ${v} 分钟内有效` : `每次运行最多调 ${v} 次`);
}

const probing = ref<string | null>(null);
async function probe(backend: string) {
  probing.value = backend;
  try {
    const r = await post<CloudProbe>("/api/cloud-tools/probe", { backend });
    toast(r.mode ? `${name(backend)}探测通过，确认后可以启用` : `${name(backend)}探测没通过：${r.reason}`, r.mode ? "ok" : "error");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    probing.value = null;
    await load();
  }
}
async function confirmProbe(backend: string, p: CloudProbe) {
  try {
    await post("/api/cloud-tools/probe/confirm", { backend, id: p.id });
    toast(`已确认${name(backend)}的探测`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
  await load();
}
async function revoke() {
  if (!(await confirmDialog("作废现在有效的全部凭据？", {
    message: "正在跑的云端运行之后调不了工具，只能用手里已有的材料答完。要不再签发新凭据，同时关掉上面的总开关。",
    okText: "全部作废", danger: true,
  }))) return;
  try {
    const r = await post<{ revoked: number }>("/api/cloud-tools/revoke");
    toast(r.revoked ? `作废了 ${r.revoked} 个凭据` : "没有有效的凭据", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
  await load();
}
const off = computed(() => !status.value?.enabled);
</script>

<template>
  <SetCard v-if="!missing" id="set-cloud-tools" title="云端后端调只读工具">
    <template #help>没有 MCP 的云端后端经这台 omem 的公网地址调几个只读工具，每次运行一个短期凭据，限工具、空间和次数，本轮结束就作废。默认关。</template>
    <p v-if="local" class="set-pad small muted">这张卡要用登录后的会话或令牌打开：直接在运行 omem 的机器上打开的页面不算本人登录，服务端不认。</p>
    <Skeleton v-else-if="!status && !error" :rows="3" />
    <div v-else-if="error" class="set-pad row" role="alert"><span class="grow small">读不到云端工具的状态：{{ error }}</span><button class="btn ghost sm" @click="load">重试</button></div>
    <template v-else-if="status">
      <SetRow label="允许云端后端调只读工具">
        <template #hint><span v-if="status.addressError" class="warn-text">{{ status.addressError }}</span><span v-else-if="status.url" class="ct-url"><MonoLine :text="status.url" /></span></template>
        <UiCheckbox :model-value="status.enabled" switch aria-label="允许云端后端调只读工具" @change="(v) => save({ enabled: v }, v ? '云端后端可以调只读工具了' : '云端后端不再调工具')" />
      </SetRow>
      <div class="set-pad">
        <span class="ct-k">云端后端</span>
        <p v-if="!status.profiles.length" class="small muted">没有云端后端：在 后端与模型 里加一个之后再来。</p>
        <div v-for="p in status.profiles" :key="p.backend" class="ct-backend">
          <div class="ct-name">
            <span class="ct-title">{{ name(p.backend) }}</span>
            <span class="ct-meta">
              <span :class="probeState(p.probe, status.url).tone === 'ok' ? 'ok-text' : probeState(p.probe, status.url).tone === 'warn' ? 'warn-text' : ''">{{ probeState(p.probe, status.url).text }}</span>
              <template v-if="p.probe"> · {{ relTime(p.probe.at) }}</template>
            </span>
            <span v-if="p.probe && !p.probe.mode" class="ct-reason" :title="p.probe.reason">{{ p.probe.reason }}</span>
            <span v-else-if="p.reason && status.backends.includes(p.backend) && status.enabled" class="ct-reason" :title="p.reason">现在用不了：{{ p.reason }}</span>
          </div>
          <button v-if="probeState(p.probe, status.url).confirm" class="btn sm primary" @click="confirmProbe(p.backend, p.probe!)">确认</button>
          <button class="btn ghost sm" :disabled="probing === p.backend || !status.url" :title="status.url ? '让这个后端读一次公网回执，约一分钟' : '先配好公网 HTTPS 地址'" @click="probe(p.backend)">{{ probing === p.backend ? "探测中…" : "探测" }}</button>
          <UiCheckbox :model-value="status.backends.includes(p.backend)" switch :aria-label="`对${name(p.backend)}启用`" @change="(v) => save({ backends: v ? [...status!.backends, p.backend] : status!.backends.filter((b) => b !== p.backend) }, v ? `已对${name(p.backend)}启用` : `不再对${name(p.backend)}启用`)" />
        </div>
      </div>
      <SetRow label="允许的工具" hint="只能从这几个只读工具里选" block :off="off">
        <UiSelect :model-value="status.tools" multiple size="sm" width="100%" aria-label="允许云端后端调的工具" :options="CLOUD_TOOLS" @change="(v) => (v as string[]).length ? save({ tools: v as string[] }, '已保存允许的工具') : toast('至少留一个工具；不想给就关掉总开关', 'error')" />
      </SetRow>
      <SetRow label="凭据多久有效" hint="分钟，1–30" :off="off">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="30" aria-label="凭据有效分钟数" :value="status.ttlMinutes" @change="number($event, 'ttlMinutes', 30, 15)" />
      </SetRow>
      <SetRow label="每次运行最多调几次" hint="1–100" :off="off">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="100" aria-label="每次运行最多调几次" :value="status.maxCalls" @change="number($event, 'maxCalls', 100, 32)" />
      </SetRow>
      <SetRow label="凭据放哪" :hint="status.credentialIn === 'message' ? '写进发给后端的消息，会留在云端会话的历史里' : '后端的安全通道，不进消息'" :off="off">
        <UiSegmented :model-value="status.credentialIn" size="sm" aria-label="凭据放哪" :options="[{ value: 'channel', label: '安全通道' }, { value: 'message', label: '写进消息' }]" @change="credentialIn" />
      </SetRow>
      <SetRow label="现在有效的凭据" :hint="status.activeCredentials ? `${status.activeCredentials} 个，在跑的云端运行用着` : '没有'">
        <button class="btn ghost sm danger" :disabled="!status.activeCredentials" @click="revoke">全部作废</button>
      </SetRow>
      <div v-if="status.recent.length" class="set-pad">
        <span class="ct-k">最近的调用</span>
        <div v-for="r in status.recent.slice(0, 6)" :key="r.runId" class="ct-call small">
          <RouterLink class="ct-run" :to="`/runs/${r.runId}`">{{ title(r.runId) }}</RouterLink>
          <span class="muted">{{ r.calls }} 次{{ r.errors ? ` · 出错 ${r.errors}` : "" }} · {{ relTime(r.at) }}</span>
          <span v-if="r.lastError" class="ct-err" :title="r.lastError">{{ r.lastError }}</span>
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
.ct-url {
  display: block;
  max-width: 360px;
  min-width: 0;
}
.ct-k {
  font-size: 13px;
  color: var(--ink-2);
}
.ct-backend {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 4px 0;
}
.ct-name {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.ct-title {
  font-size: 14px;
}
.ct-meta {
  font-size: 12px;
  color: var(--muted);
}
.ok-text {
  color: var(--ok);
}
.ct-reason,
.ct-err {
  font-size: 12px;
  color: var(--danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ct-call {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 12px;
  align-items: center;
  min-width: 0;
}
.ct-run {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ct-err {
  grid-column: 1 / -1;
}
@media (max-width: 760px) {
  .ct-backend {
    flex-wrap: wrap;
  }
  .ct-name {
    flex-basis: 100%;
  }
}
</style>
