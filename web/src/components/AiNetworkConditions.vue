<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { relTime, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import { checkNetwork, loadNetwork, network, saveNetwork, statusOf, watchNetwork, type NetworkPolicy } from "../lib/network-status";
import UiSelect from "./UiSelect.vue";
import UiCheckbox from "./UiCheckbox.vue";

/**
 * The network conditions of one backend (settings → AI, inside its block): the ones that govern any of
 * `scope` (the profile ids of the backend, ACP and CLI), with adding one for them.
 */
const props = defineProps<{ scope: string[]; backends: { id: string; name?: string; peer?: unknown }[]; noAdd?: boolean }>();
const emit = defineEmits<{ saved: [policies: NetworkPolicy[]] }>();
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const stop = watchNetwork();
onBeforeUnmount(stop);
const mine = computed(() => network.policies.filter((p) => p.backends.some((b) => props.scope.includes(b))));
const saving = ref(false), checking = ref("");
const draft = ref<NetworkPolicy | null>(null), newPolicy = ref(false), ipInput = ref(""), dohInput = ref(""), dnsInput = ref("");
const names = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const region = (c?: string) => (c ? names.of(c) ?? c : "地区未知");
const codes = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");
const countryOptions = codes.map((c) => ({ value: c, label: names.of(c) ?? c, hint: c })).sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
const labels: Record<string, string> = { unchecked: "用到时检查", checking: "正在查", ready: "正常", unavailable: "不可用", recovering: "恢复中" };
const badgeOf = (status?: string) => status === "ready" ? "ok" : status === "unavailable" ? "danger" : status === "checking" || status === "recovering" ? "warn" : "";
const backendName = (id: string) => props.backends.find((b) => b.id === id)?.name ?? id;
const others = (p: NetworkPolicy) => p.backends.filter((b) => !props.scope.includes(b));
const backendOptions = computed(() => {
  const ids = [...new Set([...props.backends.filter((b) => !b.peer).map((b) => b.id), ...(draft.value?.backends ?? [])])];
  const taken = (id: string) => network.policies.some((p) => p.id !== draft.value?.id && p.backends.includes(id));
  return ids.map((id) => ({ value: id, label: backendName(id), hint: taken(id) ? "已有别的网络条件" : id, disabled: taken(id) }));
});
const interfaceOptions = computed(() => [{ value: "", label: "不看网卡" }, ...[...new Set([...network.interfaces.map((i) => i.name), ...(draft.value?.watch.interface ? [draft.value.watch.interface] : [])])].map((name) => ({ value: name, label: name, hint: network.interfaces.find((i) => i.name === name)?.addresses.join("、") || "现在没有这块网卡" }))]);
const DOH = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];
function edit(p?: NetworkPolicy) {
  newPolicy.value = !p;
  const free = props.scope.filter((id) => !network.policies.some((x) => x.backends.includes(id)) && props.backends.some((b) => b.id === id && !b.peer));
  draft.value = p ? copy(p) : {
    id: `network-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: "", backends: free, connection: { type: "system" }, watch: {},
    probe: { url: "", format: "cloudflare-trace", ipField: "ip", countryField: "country_code", timeoutMs: 3000, maxAgeSeconds: 3600 },
    require: { countries: [], ips: [] }, onFailure: "stop-and-fallback", ipv6: { enabled: false, doh: [...DOH] }, dns: { enabled: false, expectedServers: [] },
  };
  draft.value.ipv6 ??= { enabled: false, doh: [...DOH] };
  draft.value.dns ??= { enabled: false, expectedServers: [] };
  ipInput.value = draft.value.require.ips.join("\n");
  dohInput.value = draft.value.ipv6.doh.join("\n"); dnsInput.value = draft.value.dns.expectedServers.join("\n");
}
async function persist(next: NetworkPolicy[]) {
  saving.value = true;
  try {
    emit("saved", await saveNetwork(next));
    draft.value = null;
    toast("已保存网络条件", "ok");
  } catch (e) { toast((e as Error).message, "error"); }
  finally { saving.value = false; }
}
async function save() {
  if (!draft.value) return;
  const p = copy(draft.value);
  if (!p.name.trim() || !p.backends.length || !p.probe.url.trim()) return toast("要填名称、用于哪些后端和出口检测地址", "error");
  p.require.ips = ipInput.value.split(/\s+/).filter(Boolean);
  p.ipv6.doh = dohInput.value.split(/\s+/).filter(Boolean);
  p.dns.expectedServers = dnsInput.value.split(/\s+/).filter(Boolean);
  if (!p.dns.mihomoConfig?.trim()) delete p.dns.mihomoConfig;
  if (!p.watch.interface) delete p.watch.interface;
  await persist([...network.policies.filter((x) => x.id !== p.id), p]);
}
async function remove(p: NetworkPolicy) {
  if (await confirmDialog("删除网络条件", { message: `删除“${p.name}”后，${p.backends.map(backendName).join("、")} 在什么网络下都会用。` })) await persist(network.policies.filter((x) => x.id !== p.id));
}
async function check(id: string) {
  checking.value = id;
  try { await checkNetwork(id); }
  catch (e) { toast((e as Error).message, "error"); }
  finally { checking.value = ""; }
}
const how = (p: NetworkPolicy) => p.connection.type === "proxy" ? `代理 ${p.connection.url}` : `系统路由${p.watch.interface ? `，看网卡 ${p.watch.interface}` : ""}`;
const want = (p: NetworkPolicy) => [p.require.countries.length ? `出口在${p.require.countries.map((c) => region(c)).join("、")}` : "", p.require.ips.length ? `出口 IP 是 ${p.require.ips.join("、")}` : ""].filter(Boolean).join("，") || "不限出口";
</script>

<template>
  <div class="net stack">
    <p v-if="network.error" class="warn-text small" role="status">读不到网络条件的状态：{{ network.error }} <button class="btn ghost sm" @click="loadNetwork">重试</button></p>
    <div v-for="p in mine" :key="p.id" class="net-row stack">
      <div class="row wrap"><strong class="grow">{{ p.name }}</strong><span class="badge" :class="badgeOf(statusOf(p.id)?.status)">{{ labels[statusOf(p.id)?.status ?? 'unchecked'] }}</span></div>
      <p v-if="statusOf(p.id)?.reason" class="small" :class="statusOf(p.id)?.status === 'unavailable' ? 'failed' : 'warn-text'" role="status">{{ statusOf(p.id)?.reason }}</p>
      <p class="small">要求{{ want(p) }} · {{ how(p) }}</p>
      <p v-if="statusOf(p.id)?.ip" class="small muted">出口 {{ region(statusOf(p.id)?.country) }} · <span class="mono">{{ statusOf(p.id)?.ip }}</span><template v-if="statusOf(p.id)?.checkedAt"> · {{ relTime(statusOf(p.id)!.checkedAt!) }}查的，{{ p.probe.maxAgeSeconds / 60 }} 分钟内有效</template></p>
      <template v-if="statusOf(p.id)?.ipv6">
        <p v-for="o in statusOf(p.id)!.ipv6!.observations" :key="o.address" class="small muted">IPv6 出口 {{ region(o.country) }} · <span class="mono">{{ o.ip }}</span></p>
        <p v-if="statusOf(p.id)?.ipv6?.reason" class="small muted">IPv6：{{ statusOf(p.id)?.ipv6?.reason }}</p>
      </template>
      <details v-if="statusOf(p.id)?.dns" class="small">
        <summary :class="statusOf(p.id)!.dns!.warnings.length ? 'warn-text' : 'muted'">DNS：{{ statusOf(p.id)!.dns!.warnings.length ? `${statusOf(p.id)!.dns!.warnings.length} 处要看` : "没发现问题" }}</summary>
        <div class="stack dns">
          <p v-for="w in statusOf(p.id)!.dns!.warnings" :key="w">{{ w }}</p>
          <p class="muted">{{ statusOf(p.id)?.dns?.source }}：<span class="mono">{{ statusOf(p.id)?.dns?.servers.join("、") || "没读到" }}</span></p>
        </div>
      </details>
      <p v-if="others(p).length" class="small muted">也管着 {{ others(p).map(backendName).join("、") }}</p>
      <div class="row wrap">
        <button class="btn ghost sm" :disabled="!!checking || saving" @click="check(p.id)">{{ checking === p.id ? "正在查…" : "现在查" }}</button>
        <button class="btn ghost sm" :disabled="saving" @click="edit(p)">编辑</button>
        <button class="btn ghost sm danger" :disabled="saving" @click="remove(p)">删除</button>
        <RouterLink v-for="id in statusOf(p.id)?.runs ?? []" :key="id" class="small" :to="`/runs/${id}`">正在用的运行</RouterLink>
      </div>
    </div>
    <div v-if="!mine.length && !draft && !noAdd" class="row wrap">
      <span class="muted small grow">什么网络下都用。</span>
      <button class="btn sm" :disabled="saving" @click="edit()">添加网络条件</button>
    </div>
    <form v-if="draft" class="net-editor stack" @submit.prevent="save">
      <strong>{{ newPolicy ? "添加网络条件" : "编辑网络条件" }}</strong>
      <label class="field"><span>名称</span><input v-model="draft.name" class="input" required maxlength="80" placeholder="例如：日本出口" /></label>
      <div class="field"><span>用于哪些后端</span><UiSelect v-model="draft.backends" multiple :options="backendOptions" aria-label="网络条件用于哪些后端" /><span class="hint">走同一个网络的后端可以共用一条。别的设备上的后端在那台设备上设。</span></div>
      <div class="grid2">
        <div class="field"><span>怎么连出去</span><UiSelect :model-value="draft.connection.type" :options="[{ value: 'system', label: '跟随系统路由（TUN）' }, { value: 'proxy', label: '指定 HTTP / HTTPS 代理' }]" aria-label="怎么连出去" @change="(v) => draft!.connection = v === 'proxy' ? { type: 'proxy', url: '' } : { type: 'system' }" /></div>
        <div class="field"><span>看哪块网卡</span><UiSelect :model-value="draft.watch.interface ?? ''" :options="interfaceOptions" aria-label="看哪块网卡" @change="(v) => draft!.watch.interface = v || undefined" /><span class="hint">用 TUN 时选它的网卡：网卡消失或关闭立刻停下。</span></div>
      </div>
      <label v-if="draft.connection.type === 'proxy'" class="field"><span>代理地址</span><input v-model="draft.connection.url" class="input mono" type="url" required placeholder="http://127.0.0.1:7891" /><span class="hint">不带账号密码的 HTTP(S) 代理。后端通过 HTTP_PROXY / HTTPS_PROXY 用它；代理连不上时不会改成直连。</span></label>
      <label class="field"><span>出口检测地址</span><input v-model="draft.probe.url" class="input mono" type="url" required placeholder="https://claude.ai/cdn-cgi/trace" /><span class="hint">填模型接口那个站点的 trace 地址，查到的出口就是模型请求的出口；也可以填返回 IP 和地区的 JSON 服务。</span></label>
      <div class="field"><span>返回格式</span><UiSelect v-model="draft.probe.format" :options="[{ value: 'cloudflare-trace', label: 'Cloudflare Trace（ip / loc）' }, { value: 'json', label: 'JSON' }]" aria-label="出口检测的返回格式" /></div>
      <div v-if="draft.probe.format === 'json'" class="grid2"><label class="field"><span>IP 字段</span><input v-model="draft.probe.ipField" class="input mono" required /></label><label class="field"><span>地区字段</span><input v-model="draft.probe.countryField" class="input mono" required placeholder="location.country_code" /></label></div>
      <div class="field"><span>出口要在哪些国家或地区</span><UiSelect v-model="draft.require.countries" multiple :options="countryOptions" aria-label="出口要在哪些国家或地区" placeholder="不限地区" /><span class="hint">同时填了 IP 时两项都要满足。</span></div>
      <label class="field"><span>出口 IP（可选）</span><textarea v-model="ipInput" class="textarea mono" rows="2" placeholder="每行一个 IPv4 或 IPv6 地址" /></label>
      <div class="field"><UiCheckbox v-model="draft.ipv6.enabled" switch>也查 IPv6 出口</UiCheckbox><span class="hint">检测地址的域名有 IPv6 地址时，从每个 IPv6 地址各查一次出口，地区或 IP 不对同样停下。这台机器没有 IPv6 出口时只看 IPv4。</span></div>
      <div class="field"><UiCheckbox v-model="draft.dns.enabled" switch>检查 DNS 设置</UiCheckbox><span class="hint">列出系统用的 DNS 服务器，对照预期的和 Mihomo 配置，有问题在状态里列出来，不拦运行。</span></div>
      <template v-if="draft.dns.enabled">
        <label class="field"><span>预期的 DNS 服务器（可选）</span><textarea v-model="dnsInput" class="textarea mono" rows="2" placeholder="每行一个 IP" /></label>
        <label class="field"><span>Mihomo 配置文件（可选）</span><input v-model="draft.dns.mihomoConfig" class="input mono" placeholder="正在用的生成配置的路径" /><span class="hint">检查内置 DNS、53 端口接管和 strict-route。</span></label>
      </template>
      <div class="field"><span>出口不对时</span><UiSelect v-model="draft.onFailure" :options="[{ value: 'stop-and-fallback', label: '停下正在跑的，换别的后端' }, { value: 'restrict-new', label: '正在跑的继续，新的不用它' }]" aria-label="出口不对时" /><span class="hint">按兜底顺序换；都不行时运行失败并写明原因，已做的保留。</span></div>
      <details><summary class="small muted">高级</summary>
        <div class="grid2 adv">
          <div class="field"><span>出口结果有效多久</span><UiSelect v-model="draft.probe.maxAgeSeconds" :options="[...new Set([600, 1800, 3600, 21600, draft.probe.maxAgeSeconds])].sort((a, b) => a - b).map((v) => ({ value: v, label: `${v / 60} 分钟` }))" aria-label="出口结果有效多久" /></div>
          <label class="field"><span>检测超时（毫秒）</span><input v-model.number="draft.probe.timeoutMs" class="input" type="number" min="200" max="30000" required /></label>
        </div>
        <label v-if="draft.ipv6.enabled" class="field adv"><span>备用 IPv6 解析（DoH）</span><textarea v-model="dohInput" class="textarea mono" rows="2" /><span class="hint">系统 DNS 查不到 IPv6 地址时依次问这些服务，走代理时经代理问。它们会看到检测地址的域名，检测内网地址时清空。</span></label>
        <p class="hint adv">出错后连续两次查到出口正常才恢复。TUN 里换节点不一定改变网卡，最晚到有效期结束才会发现出口变了。</p>
      </details>
      <div class="row wrap"><span class="spacer" /><button type="button" class="btn ghost sm" :disabled="saving" @click="draft = null">取消</button><button class="btn primary sm" :disabled="saving">{{ saving ? "保存中…" : "保存" }}</button></div>
    </form>
  </div>
</template>

<style scoped>
.net, .net-row, .net-editor, .field { min-width: 0; }
.net-row p, .dns p { margin: 0; }
.net-row { gap: 6px; overflow-wrap: anywhere; }
.net-row + .net-row, .net-row + .net-editor { border-top: 1px solid var(--line); padding-top: 12px; }
.net-editor { overflow-wrap: anywhere; }
.net-editor .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.net-editor .field { align-content: start; }
.adv { margin-top: 12px; }
.dns { margin-top: 6px; padding-left: 12px; border-left: 2px solid var(--line); gap: 4px; }
.failed { color: var(--danger); }
.net-editor :deep(.ui-select), .net-editor input { width: 100%; }
@media (max-width: 760px) { .net-editor .grid2 { grid-template-columns: minmax(0, 1fr); } }
</style>
