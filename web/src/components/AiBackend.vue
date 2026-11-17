<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { del, post } from "../api";
import { detectProbe, probes } from "../lib/probes";
import { networkBlock } from "../lib/network-status";
import { toast } from "../store";
import { fmt } from "../lib/time";
import Icon from "./Icon.vue";
import UiSelect from "./UiSelect.vue";
import AiNetworkConditions from "./AiNetworkConditions.vue";

/**
 * One backend in settings → AI: its ACP agent and CLI fallback together (one account, `source`), with
 * everything set per backend: the default model, what it suits (routing candidates), its network
 * condition, how many runs at once, and its account's plan quota.
 */
export type Profile = { id: string; name?: string; transport: string; command: string; args: string[]; model?: string; effort?: string; installed: boolean; install?: string; networkReason?: string | null; peer?: unknown; source?: string };
export type AgentLoad = {
  now: { source: string; model: string; used: number; waiting: number }[];
  recent: { profile: string; model: string; done: number; failed: number; medianMinutes: number | null }[];
  outOfQuota?: { source: string; account?: string; model?: string; until: string; message: string }[];
  quota?: { profile: string; name: string; source: string; plan: string | null; readAt: string | null; windows: { name: string; used: number; model?: string; resetsIn?: string; perDayLeft?: number }[]; avoid?: string; error?: string }[];
  daily?: { profile: string; model: string; perDay: number; used: number }[];
};
type Candidate = { profile: string; model?: string; effort?: string; when: string };
type Limit = { profile: string; model?: string; max: number; perDay?: number };

const props = defineProps<{ source: string; profiles: Profile[]; all: Profile[]; config: any; load: AgentLoad | null }>();
const emit = defineEmits<{ save: [agents: Record<string, unknown>, note: string]; reload: []; network: [policies: unknown[]] }>();
const open = ref(false);
const ids = computed(() => props.profiles.map((p) => p.id));
/** ACP first: it reports its models and is what a new run picks. */
const primary = computed(() => props.profiles[0]);
const probeable = (p: Profile) => p.transport === "acp" || p.transport === "doubao-cli";
const prober = computed(() => props.profiles.find(probeable));
const probe = computed(() => (prober.value ? probes.data[prober.value.id] : undefined));
const probing = computed(() => !!(prober.value && probes.pending[prober.value.id]));
const models = computed(() => probe.value?.models ?? []);
const efforts = computed(() => probe.value?.effortsByModel?.[primary.value.model ?? ""] ?? probe.value?.efforts ?? []);
watch(open, (o) => { if (o && prober.value) void detectProbe(prober.value.id); });

const name = computed(() => (primary.value.name ?? primary.value.id).replace(/\s*[(（](ACP|CLI|命令行)[)）]\s*$/i, ""));
const KIND: Record<string, string> = { acp: "ACP", "claude-cli": "CLI", "codex-cli": "CLI", "doubao-cli": "CLI", doubao: "OpenAPI" };
const kinds = computed(() => [...new Set(props.profiles.map((p) => KIND[p.transport] ?? p.transport))].join(" · "));
const blocked = computed(() => props.profiles.map((p) => networkBlock(p.id)).find(Boolean) ?? null);
/** Where limits are written: the account (source) when a profile of that id exists, else the profile. */
const limitKey = computed(() => (ids.value.includes(props.source) ? props.source : primary.value.id));
const mineLimit = (l: Limit) => l.profile === props.source || ids.value.includes(l.profile);

// ---- the default model, for the ACP agent and its CLI fallback at once
async function setDefault(key: "model" | "effort", value: string) {
  const strip = ({ installed, install, networkReason, ...rest }: Profile) => rest;
  const next = props.profiles.map((p) => ({ ...strip(p), [key]: value || undefined, ...(key === "model" ? { effort: p.effort } : {}) }));
  const list = [...props.config.agents.profiles.filter((x: Profile) => !ids.value.includes(x.id)), ...next];
  emit("save", { profiles: list }, `${name.value}：默认${key === "model" ? "模型" : "强度"} ${value || "跟随后端"}`);
}
const editing = ref<string | null>(null);
const editJson = ref("");
function editProfile(p: Profile) {
  const { installed, install, networkReason, ...rest } = p;
  editing.value = editing.value === p.id ? null : p.id;
  editJson.value = JSON.stringify(rest, null, 2);
}
function saveEdit() {
  try {
    const p = JSON.parse(editJson.value);
    if (!p.id) return toast("配置要有 id", "error");
    emit("save", { profiles: [...props.config.agents.profiles.filter((x: Profile) => x.id !== p.id && x.id !== editing.value), p] }, `已保存 ${p.name ?? p.id}`);
    editing.value = null;
  } catch (e) {
    toast(`不是合法的 JSON：${(e as Error).message}`, "error");
  }
}

// ---- what it suits: one line for the backend, optional lines for its models (routing candidates)
const routing = computed(() => props.config.agents.routing);
const when = ref(""), modelWhens = ref<{ model: string; when: string }[]>([]);
function savedRouting() {
  const mine = (routing.value.candidates as Candidate[]).filter((c) => ids.value.includes(c.profile));
  const byModel = new Map<string, string[]>();
  for (const c of mine) if (c.model) byModel.set(c.model, [...(byModel.get(c.model) ?? []), c.when]);
  return { when: mine.filter((c) => !c.model).map((c) => c.when).join("\n"), models: [...byModel].map(([model, w]) => ({ model, when: w.join("\n") })) };
}
function resetRouting() {
  const s = savedRouting();
  when.value = s.when;
  modelWhens.value = s.models;
}
watch(() => JSON.stringify(routing.value.candidates), resetRouting, { immediate: true });
const shape = (w: string, m: { model: string; when: string }[]) => JSON.stringify([w.trim(), m.map((x) => [x.model, x.when.trim()])]);
const routingDirty = computed(() => {
  const s = savedRouting();
  return shape(when.value, modelWhens.value) !== shape(s.when, s.models);
});
const modelChoices = (current: string) => [...new Set([...(current ? [current] : []), ...models.value])].map((m) => ({ value: m, label: m, hint: modelWhens.value.some((x) => x.model === m && x.model !== current) ? "已写过" : undefined, disabled: modelWhens.value.some((x) => x.model === m && x.model !== current) }));
function addModelWhen() {
  const free = models.value.find((m) => !modelWhens.value.some((x) => x.model === m));
  modelWhens.value.push({ model: free ?? "", when: "" });
}
function saveRouting() {
  if (modelWhens.value.some((m) => !m.model.trim() || !m.when.trim())) return toast("每个模型都要选好并写上适合什么", "error");
  const own: Candidate[] = [
    ...(when.value.trim() ? [{ profile: primary.value.id, when: when.value.trim() }] : []),
    ...modelWhens.value.map((m) => ({ profile: primary.value.id, model: m.model.trim(), when: m.when.trim() })),
  ];
  const candidates = [...(routing.value.candidates as Candidate[]).filter((c) => !ids.value.includes(c.profile)), ...own];
  emit("save", { routing: { ...routing.value, candidates } }, `已保存 ${name.value} 的说明`);
}

// ---- runs at once and the account's quota
const capacity = computed(() => props.config.agents.capacity);
const cap = ref<string>(""), modelLimits = ref<Limit[]>([]), avoidAbove = ref<string>(""), perDayBelow = ref<string>("");
function resetUsage() {
  const mine = (capacity.value.limits as Limit[]).filter(mineLimit);
  const whole = mine.find((l) => !l.model);
  cap.value = whole ? String(whole.max) : "";
  modelLimits.value = mine.filter((l) => l.model).map((l) => ({ ...l }));
  const own = capacity.value.quotaBySource?.[props.source] ?? {};
  avoidAbove.value = own.avoidAbove !== undefined ? String(own.avoidAbove) : "";
  perDayBelow.value = own.perDayBelow !== undefined ? String(own.perDayBelow) : "";
}
watch(() => JSON.stringify([capacity.value.limits, capacity.value.quotaBySource?.[props.source]]), resetUsage, { immediate: true });
const clamp = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
function addModelLimit() {
  const free = models.value.find((m) => !modelLimits.value.some((l) => l.model === m));
  modelLimits.value.push({ profile: limitKey.value, model: free ?? "", max: capacity.value.perModel ?? 3 });
}
function saveUsage() {
  if (modelLimits.value.some((l) => !l.model)) return toast("每一行都要选模型", "error");
  const own: Limit[] = [
    ...(cap.value.trim() !== "" ? [{ profile: limitKey.value, max: clamp(cap.value, 0, 32) }] : []),
    ...modelLimits.value.map((l) => {
      const perDay = l.perDay !== undefined && String(l.perDay) !== "" ? clamp(l.perDay, 0, 100000) : undefined;
      return { profile: limitKey.value, model: l.model, max: clamp(l.max, 0, 32), ...(perDay !== undefined ? { perDay } : {}) };
    }),
  ];
  const limits = [...(capacity.value.limits as Limit[]).filter((l) => !mineLimit(l)), ...own];
  const bySource = { ...(capacity.value.quotaBySource ?? {}) };
  const t = {
    ...(avoidAbove.value.trim() !== "" ? { avoidAbove: clamp(avoidAbove.value, 50, 100) } : {}),
    ...(perDayBelow.value.trim() !== "" ? { perDayBelow: Math.max(0, Math.min(100, Number(perDayBelow.value) || 0)) } : {}),
  };
  if (Object.keys(t).length) bySource[props.source] = t;
  else delete bySource[props.source];
  emit("save", { capacity: { ...capacity.value, limits, quotaBySource: bySource } }, `已保存 ${name.value} 的用量设置`);
}
const now = computed(() => props.load?.now.filter((n) => n.source === props.source) ?? []);
const running = computed(() => now.value.reduce((s, n) => s + n.used, 0));
const recent = (model: string) => props.load?.recent.find((r) => r.profile === props.source && r.model === model);
const today = (l: Limit) => props.load?.daily?.find((d) => (d.profile === l.profile || ids.value.includes(d.profile)) && d.model === l.model);
const quota = computed(() => props.load?.quota?.find((q) => q.source === props.source));
const spent = computed(() => props.load?.outOfQuota?.filter((q) => q.source === props.source || q.account === props.source) ?? []);
const windowLabel = (n: string) => n.replace(/^5h/, "5 小时").replace(/^7d/, "一周");
const quotaShort = computed(() => {
  const w = quota.value?.windows ?? [];
  if (!w.length) return "";
  const top = [...w].sort((a, b) => b.used - a.used)[0];
  return `${windowLabel(top.name)}已用 ${top.used}%`;
});
const reading = ref(false);
async function readQuota() {
  reading.value = true;
  try { await post("/api/agents/quota/refresh", {}); emit("reload"); }
  catch (e) { toast((e as Error).message, "error"); }
  finally { reading.value = false; }
}
async function useAgain(source: string) {
  await del(`/api/agents/quota/${encodeURIComponent(source)}`);
  emit("reload");
}
const when2 = (iso: string) => fmt(iso, { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const chosen = computed(() => routing.value.automatic && (routing.value.candidates as Candidate[]).some((c) => ids.value.includes(c.profile)));
</script>

<template>
  <div class="be" :class="{ open }">
    <button type="button" class="be-head" :aria-expanded="open" @click="open = !open">
      <Icon name="right" :size="14" class="chev" />
      <span class="be-name"><strong>{{ name }}</strong><span class="muted small">（{{ kinds }}）</span></span>
      <span class="be-meta small muted mono">{{ [primary.model, primary.effort].filter(Boolean).join(" · ") || "后端默认模型" }}</span>
      <span class="be-tags">
        <span v-if="running" class="badge">在用 {{ running }}</span>
        <span v-if="chosen" class="badge">候选</span>
        <span v-if="quotaShort" class="badge" :class="{ warn: quota?.avoid }">{{ quotaShort }}</span>
        <span v-if="spent.length" class="badge danger">额度用完</span>
        <span v-if="blocked" class="badge warn" :title="blocked">网络不符</span>
      </span>
    </button>
    <div v-if="open" class="be-body">
      <p v-if="blocked" class="small warn-text">{{ blocked }}</p>

      <section class="part">
        <h4>默认模型</h4>
        <div v-if="models.length" class="row wrap small">
          <span class="muted lbl">模型</span>
          <button v-for="m in models" :key="m" type="button" class="chip" :class="{ on: primary.model === m }" @click="setDefault('model', m)">{{ m }}</button>
        </div>
        <div v-if="efforts.length" class="row wrap small">
          <span class="muted lbl">强度</span>
          <button v-for="v in efforts" :key="v" type="button" class="chip" :class="{ on: primary.effort === v }" @click="setDefault('effort', v)">{{ v }}</button>
        </div>
        <p v-if="probe?.error" class="small warn-text">读不到模型列表：{{ probe.error }}</p>
        <p v-else-if="!prober" class="small muted">这个后端不报告模型列表，在下面的配置里写 model、effort。</p>
        <div class="row wrap small">
          <span v-if="profiles.length > 1" class="muted grow">ACP 和命令行用同一个默认值。</span><span v-else class="grow" />
          <button v-if="prober" class="btn ghost sm" :disabled="probing" @click="detectProbe(prober.id, true)">{{ probing ? "检测中…" : "重新检测" }}</button>
        </div>
        <div v-for="p in profiles" :key="p.id" class="cmd">
          <div class="row small">
            <span class="badge">{{ KIND[p.transport] ?? p.transport }}</span>
            <span class="mono grow ell">{{ p.command }} {{ p.args.join(" ") }}</span>
            <button class="btn ghost sm" @click="editProfile(p)">{{ editing === p.id ? "收起" : "编辑配置" }}</button>
          </div>
          <div v-if="editing === p.id" class="stack">
            <textarea v-model="editJson" class="textarea mono" rows="9" />
            <div class="row"><span class="muted small">model、effort 写后端支持的值，不区分大小写和点 / 连字符。</span><span class="spacer" /><button class="btn ghost sm" @click="editing = null">取消</button><button class="btn primary sm" @click="saveEdit">保存</button></div>
          </div>
        </div>
      </section>

      <section class="part">
        <h4>适合做什么</h4>
        <p class="small muted">交办和自动选 AI 时按这里挑后端。{{ routing.automatic ? "" : "任务选型的自动选择关着，现在不起作用。" }}</p>
        <textarea v-model="when" class="input" rows="2" maxlength="2000" :placeholder="`${name} 适合什么任务，也可以写成本、速度、时段（如“工作日白天排队，晚上优先”）`" />
        <div v-for="(m, i) in modelWhens" :key="i" class="mrow">
          <UiSelect v-if="models.length" :model-value="m.model" size="sm" width="180px" aria-label="模型" :options="modelChoices(m.model)" @change="(v) => (m.model = v)" />
          <input v-else v-model="m.model" class="input sm-input mono" placeholder="模型" aria-label="模型" />
          <textarea v-model="m.when" class="input" rows="1" maxlength="2000" placeholder="这个模型和别的有什么不同、适合什么" />
          <button class="btn ghost sm icon" aria-label="移除" @click="modelWhens.splice(i, 1)"><Icon name="x" :size="14" /></button>
        </div>
        <div class="row wrap">
          <button class="btn ghost sm" @click="addModelWhen"><Icon name="plus" :size="13" />给某个模型单独写</button>
          <span class="spacer" />
          <button class="btn primary sm" :disabled="!routingDirty" @click="saveRouting">保存</button>
        </div>
      </section>

      <section class="part">
        <h4>网络条件</h4>
        <AiNetworkConditions :scope="ids" :backends="all" @saved="(v) => emit('network', v)" />
      </section>

      <section class="part">
        <h4>用量</h4>
        <div v-if="now.length" class="lines small">
          <template v-for="n in now" :key="n.model">
            <span class="mono">{{ n.model || "默认模型" }}</span>
            <span>正在用 {{ n.used }}<template v-if="n.waiting">，等 {{ n.waiting }}</template><span v-if="recent(n.model)" class="muted">（近 7 天完成 {{ recent(n.model)!.done }}、失败 {{ recent(n.model)!.failed }}）</span></span>
          </template>
        </div>
        <label class="row small"><span>整个账号同时最多</span><input v-model="cap" class="input sm num" type="number" inputmode="numeric" min="0" max="32" placeholder="不限" aria-label="整个账号同时最多" /><span>个</span><span class="muted">（每个模型默认最多 {{ capacity.perModel ?? 3 }} 个）</span></label>
        <div v-for="(l, i) in modelLimits" :key="i" class="row wrap small">
          <UiSelect v-if="models.length" :model-value="l.model ?? ''" size="sm" width="180px" aria-label="模型" :options="[...new Set([...(l.model ? [l.model] : []), ...models])].map((m) => ({ value: m, label: m }))" @change="(v) => (l.model = v)" />
          <input v-else v-model="l.model" class="input sm-input mono" placeholder="模型" aria-label="模型" />
          <label class="row">同时最多<input v-model.number="l.max" class="input sm num" type="number" inputmode="numeric" min="0" max="32" aria-label="同时最多" />个</label>
          <label class="row">每天最多<input v-model.number="l.perDay" class="input sm num" type="number" inputmode="numeric" min="0" placeholder="不限" aria-label="每天最多" />次<span v-if="today(l)" class="muted">（今天 {{ today(l)!.used }}）</span></label>
          <span class="spacer" />
          <button class="btn ghost sm icon" aria-label="移除" @click="modelLimits.splice(i, 1)"><Icon name="x" :size="14" /></button>
        </div>
        <p class="small muted">设成 0 的不会被自动选中，只在你点名时用。有的模型每天限次数却不告诉剩多少：填“每天最多”，omem 自己数，到了当天不再自动选它。</p>
        <template v-if="quota">
          <div class="row wrap small">
            <span class="grow">
              <span class="muted">账号额度{{ quota.plan ? `（${quota.plan}）` : "" }}：</span>
              <template v-if="quota.windows.length"><span v-for="(w, i) in quota.windows" :key="w.name">{{ i ? "；" : "" }}{{ windowLabel(w.name) }}已用 {{ w.used }}%<span v-if="w.resetsIn" class="muted">，{{ w.resetsIn }}后重置</span><span v-if="w.perDayLeft !== undefined" class="muted">，每天约 {{ w.perDayLeft }}%</span></span></template>
              <span v-else class="muted">{{ quota.error ? `读不到：${quota.error.slice(0, 80)}` : "还没读过" }}</span>
            </span>
            <button class="btn ghost sm" :disabled="reading" @click="readQuota">{{ reading ? "读取中…" : "现在读取" }}</button>
          </div>
          <p v-if="quota.avoid" class="small warn-text">排到最后：{{ quota.avoid }}</p>
          <label class="row small"><span>任一窗口用到</span><input v-model="avoidAbove" class="input sm num" type="number" inputmode="numeric" min="50" max="100" :placeholder="String(capacity.quotaAvoidAbove ?? 90)" aria-label="任一窗口用到多少以上时排到最后" /><span>% 以上时排到最后</span></label>
          <label class="row small"><span>周额度每天剩不到</span><input v-model="perDayBelow" class="input sm num" type="number" inputmode="decimal" min="0" max="100" step="0.5" :placeholder="String(capacity.quotaPerDayBelow ?? 0)" aria-label="周额度每天剩不到多少时排到最后" /><span>% 时排到最后</span></label>
          <p class="small muted">留空用并行设置里的默认值。排到最后时后台任务先用别的后端，你自己的对话和点名用它的任务不受影响。</p>
        </template>
        <div v-for="q in spent" :key="q.source" class="row wrap small">
          <span class="danger-text">{{ q.model ? `${q.model} ` : "" }}额度用完，{{ when2(q.until) }} 恢复</span><span class="spacer" />
          <button class="btn ghost sm" @click="useAgain(q.source)">现在恢复使用</button>
        </div>
        <div class="row wrap">
          <button class="btn ghost sm" :disabled="modelLimits.length >= 50" @click="addModelLimit"><Icon name="plus" :size="13" />给某个模型设上限</button>
          <span class="spacer" />
          <button class="btn primary sm" @click="saveUsage">保存</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.be { border-top: 1px solid var(--line); }
.be:first-child { border-top: 0; }
.be-head {
  display: grid; grid-template-columns: auto minmax(0, auto) minmax(0, 1fr) auto; align-items: center; gap: 10px;
  width: 100%; padding: 12px 16px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.be-head:hover { background: var(--hover, color-mix(in srgb, var(--fg) 4%, transparent)); }
.chev { transition: transform 0.15s ease; color: var(--muted); }
.open .chev { transform: rotate(90deg); }
.be-name { white-space: nowrap; }
.be-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.be-tags { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.be-body { display: grid; gap: 4px; padding: 0 16px 16px 40px; }
.part { display: grid; gap: 8px; padding: 12px 0; border-top: 1px dashed var(--line); min-width: 0; }
.part:first-of-type { border-top: 0; }
.part h4 { margin: 0; font-size: 13px; font-weight: 600; }
.part p { margin: 0; }
.lbl { min-width: 2.5em; }
.cmd { display: grid; gap: 8px; min-width: 0; }
.ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mrow { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.num { width: 72px; margin: 0 4px; }
.sm-input { width: 180px; }
.lines { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; align-items: baseline; }
.danger-text { color: var(--danger); }
.chip { border: 1px solid var(--line); background: var(--panel); color: inherit; border-radius: 999px; padding: 1px 10px; cursor: pointer; font-family: var(--mono); font-size: 12px; }
.chip.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
@media (max-width: 640px) {
  .be-head { grid-template-columns: auto minmax(0, 1fr); padding: 12px; }
  .be-meta { grid-column: 2; }
  .be-tags { grid-column: 2; justify-content: flex-start; }
  .be-body { padding: 0 12px 12px; }
  .mrow { grid-template-columns: minmax(0, 1fr) auto; }
  .mrow > :first-child { grid-column: 1 / -1; }
  .lines { grid-template-columns: minmax(0, 1fr); gap: 0; }
}
</style>
