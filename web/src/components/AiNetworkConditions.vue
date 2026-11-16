<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { get, post, put } from "../api";
import { relTime, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import UiSelect from "./UiSelect.vue";
import UiCheckbox from "./UiCheckbox.vue";
import HelpText from "./HelpText.vue";
import Skeleton from "./Skeleton.vue";

type Policy = {
  id: string; name: string; backends: string[];
  connection: { type: "system" } | { type: "proxy"; url: string };
  watch: { interface?: string };
  probe: { url: string; format: "cloudflare-trace" | "json"; ipField: string; countryField: string; timeoutMs: number; maxAgeSeconds: number };
  require: { countries: string[]; ips: string[] };
  ipv6: { enabled: boolean; doh: string[] };
  dns: { enabled: boolean; expectedServers: string[]; mihomoConfig?: string };
  onFailure: "stop-and-fallback" | "restrict-new";
};
type Status = {
  id: string; status: string; reason: string | null; localReason: string | null; checkedAt?: string; ip?: string; country?: string; runs: string[];
  ipv6?: { status: string; reason?: string; source?: string; checkedAt: string; observations: { address: string; ip: string; country: string }[] };
  dns?: { status: string; checkedAt: string; servers: string[]; source: string; warnings: string[] };
};
const props = defineProps<{ value: Policy[]; backends: { id: string; name?: string; peer?: unknown }[] }>();
const emit = defineEmits<{ saved: [policies: Policy[]]; states: [states: Status[]] }>();
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const policies = ref<Policy[]>([]);
watch(() => props.value, (v) => { policies.value = copy(v ?? []); }, { immediate: true, deep: true });
const statuses = ref<Status[]>([]), interfaces = ref<{ name: string; addresses: string[] }[]>([]);
const loading = ref(true), error = ref(""), saving = ref(false), checking = ref("");
const draft = ref<Policy | null>(null), newPolicy = ref(false), ipInput = ref(""), dohInput = ref(""), dnsInput = ref("");
let timer: ReturnType<typeof setInterval> | undefined;
let fetching = false;
const names = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const codes = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");
const countryOptions = codes.map((c) => ({ value: c, label: names.of(c) ?? c, hint: c })).sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
const labels: Record<string, string> = { unchecked: "尚未检查", checking: "检查中", ready: "正常", unavailable: "不可用", recovering: "恢复确认中" };
const statusOf = (id: string) => statuses.value.find((s) => s.id === id);
/** Not checked yet is not a problem; failing is. */
const badgeOf = (status?: string) => status === "ready" ? "ok" : status === "unavailable" ? "danger" : status === "checking" || status === "recovering" ? "warn" : "";
const backendName = (id: string) => props.backends.find((b) => b.id === id)?.name ?? id;
const backendOptions = computed(() => {
  const ids = [...new Set([...props.backends.filter((b) => !b.peer).map((b) => b.id), ...(draft.value?.backends ?? [])])];
  return ids.map((id) => ({ value: id, label: backendName(id), hint: policies.value.some((p) => p.id !== draft.value?.id && p.backends.includes(id)) ? "已绑定其他网络条件" : id, disabled: policies.value.some((p) => p.id !== draft.value?.id && p.backends.includes(id)) }));
});
const interfaceOptions = computed(() => [{ value: "", label: "不限定接口" }, ...[...new Set([...interfaces.value.map((i) => i.name), ...(draft.value?.watch.interface ? [draft.value.watch.interface] : [])])].map((name) => ({ value: name, label: name, hint: interfaces.value.some((i) => i.name === name) ? "本机网络接口" : "当前未找到" }))]);
function updateStates(next: Status[]) { statuses.value = next; emit("states", next); }
async function load() {
  if (fetching) return;
  fetching = true;
  try {
    const r = await get<{ states: Status[]; interfaces: { name: string; addresses: string[] }[] }>("/api/agents/network-policies");
    updateStates(r.states); interfaces.value = r.interfaces; error.value = "";
  } catch (e) { error.value = (e as Error).message; }
  finally { loading.value = false; fetching = false; }
}
function edit(p?: Policy) {
  newPolicy.value = !p;
  draft.value = p ? copy(p) : {
    id: `network-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: "", backends: [], connection: { type: "system" }, watch: {},
    probe: { url: "", format: "cloudflare-trace", ipField: "ip", countryField: "country_code", timeoutMs: 3000, maxAgeSeconds: 3600 },
    require: { countries: [], ips: [] }, onFailure: "stop-and-fallback",
    ipv6: { enabled: false, doh: ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"] }, dns: { enabled: false, expectedServers: [] },
  };
  draft.value.ipv6 ??= { enabled: false, doh: ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"] };
  draft.value.dns ??= { enabled: false, expectedServers: [] };
  ipInput.value = draft.value.require.ips.join("\n");
  dohInput.value = draft.value.ipv6.doh.join("\n"); dnsInput.value = draft.value.dns.expectedServers.join("\n");
}
async function persist(next: Policy[]) {
  saving.value = true;
  try {
    const r = await put<{ policies: Policy[]; states: Status[] }>("/api/agents/network-policies", { policies: next });
    policies.value = r.policies; updateStates(r.states); emit("saved", r.policies); draft.value = null;
    toast("已保存网络条件", "ok");
  } catch (e) { toast((e as Error).message, "error"); }
  finally { saving.value = false; }
}
async function save() {
  if (!draft.value) return;
  const p = copy(draft.value);
  if (!p.name.trim() || !p.backends.length || !p.probe.url.trim()) return toast("请填写名称、适用后端和出口检测地址", "error");
  p.require.ips = ipInput.value.split(/\s+/).filter(Boolean);
  p.ipv6.doh = dohInput.value.split(/\s+/).filter(Boolean);
  p.dns.expectedServers = dnsInput.value.split(/\s+/).filter(Boolean);
  if (!p.dns.mihomoConfig?.trim()) delete p.dns.mihomoConfig;
  if (!p.watch.interface) delete p.watch.interface;
  await persist([...policies.value.filter((x) => x.id !== p.id), p]);
}
async function remove(p: Policy) {
  if (await confirmDialog("删除网络条件", { message: `删除“${p.name}”后，所选后端不再受这份条件限制。` })) await persist(policies.value.filter((x) => x.id !== p.id));
}
async function check(id: string) {
  checking.value = id;
  try { updateStates((await post<{ states: Status[] }>(`/api/agents/network-policies/${encodeURIComponent(id)}/check`, {})).states); }
  catch (e) { toast((e as Error).message, "error"); }
  finally { checking.value = ""; }
}
onMounted(() => { void load(); timer = setInterval(() => { if (policies.value.length) void load(); }, 2500); });
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="card pad stack network-conditions" id="network-conditions">
    <div class="row wrap"><strong>网络条件</strong><span class="spacer" /><button class="btn sm" :disabled="!!draft || saving" @click="edit()">添加条件</button></div>
    <HelpText>限定哪些网络环境可以运行所选后端。出口结果默认有效一小时，过期且需要使用时才重查；有相关执行时到期也会重查。TUN 接口消失或关闭、代理端口拒绝连接时立即作废结果（端口无响应、出口检测没回应要连续两次），并按设置停止当前执行、尝试兜底后端。本地检查约每两秒一次；接口存在不能保证路由和上游一直正常。</HelpText>
    <Skeleton v-if="loading" variant="lines" :rows="2" />
    <p v-else-if="error" class="warn-text small" role="status">{{ error }} <button class="btn ghost sm" @click="load">重试</button></p>
    <p v-else-if="!policies.length && !draft" class="muted small">还没有网络条件。添加后可同时约束同一网络上的多个后端。</p>
    <div v-for="p in policies" :key="p.id" class="network-row stack">
      <div class="row wrap"><strong class="grow">{{ p.name }}</strong><span class="badge" :class="badgeOf(statusOf(p.id)?.status)">{{ labels[statusOf(p.id)?.status ?? 'unchecked'] }}</span></div>
      <p v-if="statusOf(p.id)?.reason" class="small" :class="statusOf(p.id)?.status === 'unavailable' ? 'failed' : 'warn-text'" role="status">{{ statusOf(p.id)?.reason }}</p>
      <p v-if="statusOf(p.id)?.ip" class="small">上次出口：{{ statusOf(p.id)?.country ? names.of(statusOf(p.id)!.country!) : '地区未知' }} · <span class="mono">{{ statusOf(p.id)?.ip }}</span></p>
      <div v-if="statusOf(p.id)?.ipv6" class="stack small diagnostic">
        <p>IPv6 目标路径 · 检查于{{ relTime(statusOf(p.id)!.ipv6!.checkedAt) }}<span v-if="statusOf(p.id)?.ipv6?.source"> · AAAA：{{ statusOf(p.id)?.ipv6?.source }}</span></p>
        <p v-for="o in statusOf(p.id)!.ipv6!.observations" :key="o.address">{{ o.country ? names.of(o.country) : '地区未知' }} · <span class="mono">{{ o.ip }}</span><span class="muted">（目标 {{ o.address }}）</span></p>
        <p v-if="statusOf(p.id)?.ipv6?.reason" class="muted">{{ statusOf(p.id)?.ipv6?.reason }}</p>
        <p v-if="statusOf(p.id)?.ipv6?.status === 'unknown'" class="muted">未确认 IPv6 路径，不因此限制运行。</p>
      </div>
      <details v-if="statusOf(p.id)?.dns" class="small diagnostic"><summary>DNS 配置检查 · {{ relTime(statusOf(p.id)!.dns!.checkedAt) }}</summary><div class="stack advanced"><p>{{ statusOf(p.id)?.dns?.source }}：<span class="mono">{{ statusOf(p.id)?.dns?.servers.join('、') || '未读取到' }}</span></p><p v-for="w in statusOf(p.id)!.dns!.warnings" :key="w" class="muted">{{ w }}</p></div></details>
      <p class="small muted">适用于：{{ p.backends.map(backendName).join('、') }}</p>
      <p class="small muted">{{ p.watch.interface ? `监控接口 ${p.watch.interface} · ` : '' }}{{ p.connection.type === 'system' ? '系统路由' : '指定代理' }} · 出口{{ statusOf(p.id)?.checkedAt ? `检查于${relTime(statusOf(p.id)!.checkedAt!)}` : '尚未检查' }} · 结果有效 {{ p.probe.maxAgeSeconds / 60 }} 分钟</p>
      <div class="row wrap"><button class="btn ghost sm" :disabled="!!checking || saving" @click="check(p.id)">{{ checking === p.id ? '检查中…' : '现在检查' }}</button><button class="btn ghost sm" :disabled="saving" @click="edit(p)">编辑</button><button class="btn ghost sm danger" :disabled="saving" @click="remove(p)">删除</button><RouterLink v-for="id in statusOf(p.id)?.runs ?? []" :key="id" class="small" :to="`/runs/${id}`">查看相关运行</RouterLink></div>
    </div>
    <form v-if="draft" class="network-editor stack" @submit.prevent="save">
      <strong>{{ newPolicy ? '添加网络条件' : '编辑网络条件' }}</strong>
      <label class="field"><span>名称</span><input v-model="draft.name" class="input" required maxlength="80" placeholder="例如：日本出口" /></label>
      <div class="field"><span>适用后端</span><UiSelect v-model="draft.backends" multiple :options="backendOptions" aria-label="网络条件适用后端" /><span class="hint">逐个选择要限制的后端；远程后端在执行设备上配置。</span></div>
      <div class="grid2">
        <div class="field"><span>连接方式</span><UiSelect :model-value="draft.connection.type" :options="[{ value: 'system', label: '跟随系统路由（TUN）' }, { value: 'proxy', label: '指定 HTTP / HTTPS 代理' }]" aria-label="网络连接方式" @change="(v) => draft!.connection = v === 'proxy' ? { type: 'proxy', url: '' } : { type: 'system' }" /></div>
        <div class="field"><span>监控接口</span><UiSelect :model-value="draft.watch.interface ?? ''" :options="interfaceOptions" @change="(v) => draft!.watch.interface = v || undefined" aria-label="监控网络接口" /><span class="hint">运行 omem 的机器上的接口。使用 TUN 时选它的网卡。</span></div>
      </div>
      <label v-if="draft.connection.type === 'proxy'" class="field"><span>代理地址</span><input v-model="draft.connection.url" class="input mono" type="url" required placeholder="http://127.0.0.1:7891" /><span class="hint">仅支持不带账号密码的 HTTP(S) 代理。后端须支持代理环境变量；出口检测连接失败不会改为直连。</span></label>
      <label class="field"><span>出口检测地址</span><input v-model="draft.probe.url" class="input mono" type="url" required placeholder="https://claude.ai/cdn-cgi/trace" /><span class="hint">检测地址与实际模型接口须使用相同的出口规则。可填写目标站点的 trace 地址或返回 IP、地区的 JSON 服务。</span></label>
      <div class="field"><span>响应格式</span><UiSelect v-model="draft.probe.format" :options="[{ value: 'cloudflare-trace', label: 'Cloudflare Trace（ip / loc）' }, { value: 'json', label: 'JSON' }]" aria-label="出口检测响应格式" /></div>
      <div v-if="draft.probe.format === 'json'" class="grid2"><label class="field"><span>IP 字段</span><input v-model="draft.probe.ipField" class="input mono" required /></label><label class="field"><span>地区字段</span><input v-model="draft.probe.countryField" class="input mono" required placeholder="location.country_code" /></label></div>
      <div class="field"><span>允许的国家或地区</span><UiSelect v-model="draft.require.countries" multiple :options="countryOptions" aria-label="允许的国家或地区" placeholder="不限定地区" /><span class="hint">留空不限定地区；填写了 IP 时，两项条件都要满足。</span></div>
      <label class="field"><span>允许的 IP（可选）</span><textarea v-model="ipInput" class="textarea mono" rows="2" placeholder="每行一个 IPv4 或 IPv6 地址；留空不限定" /></label>
      <div class="field"><UiCheckbox v-model="draft.ipv6.enabled" switch>检查同一目标的 IPv6 出口</UiCheckbox><span class="hint">保留域名与 TLS 校验，使用真实 AAAA 探测相同地址。已观察到的出口同样核对地区 / IP；无法连接、超时和地区未知不因此限制运行。</span></div>
      <div class="field"><UiCheckbox v-model="draft.dns.enabled" switch>检查 DNS 配置风险</UiCheckbox><span class="hint">检查宿主的解析器和可选的 Mihomo 配置，只提示风险，不阻止运行；这不能证明实际 DNS 请求没有泄露。</span></div>
      <template v-if="draft.dns.enabled"><label class="field"><span>预期 DNS 服务器（可选）</span><textarea v-model="dnsInput" class="textarea mono" rows="2" placeholder="每行一个 IP；留空只展示当前配置" /></label><label class="field"><span>Mihomo 生效配置路径（可选）</span><input v-model="draft.dns.mihomoConfig" class="input mono" placeholder="运行 omem 的机器上的生成配置文件" /><span class="hint">支持本机路径，包括 Windows 路径。检查 DNS 开关、TCP / UDP 53 接管和 strict-route；请填写正在使用的生成配置。</span></label></template>
      <div class="field"><span>网络异常时</span><UiSelect v-model="draft.onFailure" :options="[{ value: 'stop-and-fallback', label: '停止当前执行并尝试其他后端' }, { value: 'restrict-new', label: '只限制新执行，当前执行继续' }]" aria-label="网络异常处理方式" /><span class="hint">复用已有的兜底顺序；没有符合条件的后端时会说明失败原因，保留已完成的工作。</span></div>
      <details><summary class="small muted">高级设置</summary><div class="grid2 advanced"><div class="field"><span>出口结果有效期</span><UiSelect v-model="draft.probe.maxAgeSeconds" :options="[...new Set([600, 1800, 3600, 21600, draft.probe.maxAgeSeconds])].sort((a,b) => a-b).map((v) => ({ value: v, label: `${v / 60} 分钟` }))" aria-label="出口结果有效期" /></div><label class="field"><span>检查超时（毫秒）</span><input v-model.number="draft.probe.timeoutMs" class="input" type="number" min="200" max="30000" required /></label></div><label v-if="draft.ipv6.enabled" class="field advanced"><span>备用 AAAA 解析（DoH JSON）</span><textarea v-model="dohInput" class="textarea mono" rows="2" /><span class="hint">TUN 下系统 DNS 无可用 AAAA 时按顺序查询，指定代理时经代理查询。每行一个 HTTPS 地址；留空只用系统 DNS。服务会收到检测域名，内部地址请清空这里。按 TTL 缓存并发查询，限流时退避。</span></label><p class="hint">故障后有短暂的恢复检查，连续通过两次才恢复可用。TUN 内部切换节点未必会改变接口状态，最长可能到有效期结束才发现出口变化。</p></details>
      <div class="row wrap"><span class="spacer" /><button type="button" class="btn ghost sm" :disabled="saving" @click="draft = null">取消</button><button class="btn primary sm" :disabled="saving">{{ saving ? '保存中…' : '保存网络条件' }}</button></div>
    </form>
  </div>
</template>

<style scoped>
.network-conditions, .network-row, .network-editor, .field { min-width: 0; }
.network-row, .network-editor { border-top: 1px solid var(--line); padding-top: 16px; overflow-wrap: anywhere; }
.network-row .grow { overflow-wrap: anywhere; min-width: 0; }
.network-editor .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
/* Side by side, a field without a hint must not stretch its label to the neighbour's height. */
.network-editor .field { align-content: start; }
.network-editor { scroll-margin-top: 72px; }
.advanced { margin-top: 12px; }
.failed { color: var(--danger); }
.diagnostic { border-left: 2px solid var(--line); padding-left: 12px; }
.network-editor :deep(.ui-select), .network-editor input { width: 100%; }
@media (max-width: 760px) { .network-editor .grid2 { grid-template-columns: minmax(0, 1fr); } }
</style>
