<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { get } from "../api";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/**
 * How flows behave on their own (docs/v2/flows.md, docs/v2/studies.md): reading an item's chats and
 * documents while its flow runs, offering to stop asking at a gate the owner keeps agreeing to, and
 * the places a study's trials may run in.
 */
type Follow = { enabled: boolean; quietMinutes: number; maxMessages: number; maxRunsPerDay?: number };
type Ladder = { enabled: boolean; after: number };
type Env = { id: string; name: string; note: string; ai?: string | { profile: string; model?: string; effort?: string }; thirdParty: boolean; peer?: string };
type Commits = { enabled: boolean; quietMinutes: number };
type Flows = { follow?: Follow; gateLadder?: Ladder; commits?: Commits } & Record<string, unknown>;
type Studies = { envs?: Env[] } & Record<string, unknown>;

const props = defineProps<{ flows?: Flows; studies?: Studies }>();
const emit = defineEmits<{ save: [partial: Record<string, unknown>, note: string] }>();

const follow = computed<Follow>(() => ({ enabled: true, quietMinutes: 20, maxMessages: 30, maxRunsPerDay: 12, ...(props.flows?.follow ?? {}) }));
const ladder = computed<Ladder>(() => ({ enabled: true, after: 5, ...(props.flows?.gateLadder ?? {}) }));
const number = (raw: string, min: number, max: number, fallback: number) => { const n = Number(raw); return Number.isFinite(n) && raw.trim() !== "" ? Math.max(min, Math.min(max, Math.round(n))) : fallback; };
const saveFollow = (patch: Partial<Follow>, note: string) => emit("save", { flows: { ...(props.flows ?? {}), follow: { ...follow.value, ...patch } } }, note);
const commits = computed<Commits>(() => ({ enabled: true, quietMinutes: 30, ...(props.flows?.commits ?? {}) }));
const saveCommits = (patch: Partial<Commits>, note: string) => emit("save", { flows: { ...(props.flows ?? {}), commits: { ...commits.value, ...patch } } }, note);
const saveLadder = (patch: Partial<Ladder>, note: string) => emit("save", { flows: { ...(props.flows ?? {}), gateLadder: { ...ladder.value, ...patch } } }, note);

/** The environments are edited as a whole and saved with one button: an id or a name alone is not a valid entry. */
const envs = ref<Env[]>([]), dirty = ref(false), problem = ref("");
watch(() => props.studies?.envs, (list) => { if (!dirty.value) envs.value = (list ?? []).map((e) => ({ ...e })); }, { immediate: true, deep: true });
const TIERS = [{ value: "", label: "跟着流程里写的" }, { value: "strong", label: "好的" }, { value: "standard", label: "中档" }, { value: "cheap", label: "省的" }];
const tierOf = (e: Env) => typeof e.ai === "string" ? e.ai : "";
/** An entry that names a backend directly (written in the config file) is kept as it is; the page only picks a tier. */
const custom = (e: Env) => !!e.ai && typeof e.ai === "object";
function touch() { dirty.value = true; problem.value = ""; }
function add() { envs.value.push({ id: "", name: "", note: "", thirdParty: false }); touch(); }
function remove(i: number) { envs.value.splice(i, 1); touch(); }
function setTier(e: Env, v: string) { if (v) e.ai = v; else delete e.ai; touch(); }
/**
 * The owner's paired devices a trial can be handed to (studies/remote.ts): the server checks again on
 * save; one known to be someone else's server is left out. A device no longer paired stays listed for
 * the entry that names it, so the choice can be seen and changed.
 */
const devices = ref<string[]>([]);
onMounted(async () => {
  try {
    const [peers, cards] = await Promise.all([get<{ peers: { id: string }[] }>("/api/peers"), get<{ cards: { peer: string; card: { as?: string } | null }[] }>("/api/peer/cards").catch(() => ({ cards: [] }))]);
    const others = new Set(cards.cards.filter((c) => c.card?.as === "service").map((c) => c.peer));
    devices.value = peers.peers.map((p) => p.id).filter((id) => !others.has(id));
  } catch { devices.value = []; }
});
const deviceOptions = (e: Env) => [{ value: "", label: "不派给设备" }, ...[...new Set([...devices.value, ...(e.peer ? [e.peer] : [])])].map((id) => ({ value: id, label: devices.value.includes(id) ? id : `${id}（没有配对）` }))];
function setPeer(e: Env, v: string) { if (v) e.peer = v; else delete e.peer; touch(); }
function saveEnvs() {
  const list = envs.value.map((e) => ({ ...e, id: e.id.trim(), name: e.name.trim(), note: e.note.trim() }));
  const bad = list.find((e) => !/^[a-z0-9][a-z0-9-]{0,39}$/.test(e.id) || e.id === "local" || !e.name);
  if (bad) { problem.value = bad.id === "local" ? "local 是内置的本机环境，换一个标识。" : "每个环境要有名字，标识用小写字母、数字和短横线。"; return; }
  if (new Set(list.map((e) => e.id)).size !== list.length) { problem.value = "有两个环境的标识一样。"; return; }
  dirty.value = false;
  emit("save", { studies: { ...(props.studies ?? {}), envs: list } }, list.length ? `登记了 ${list.length} 个执行环境` : "只保留本机这一个执行环境");
}
function reset() { dirty.value = false; problem.value = ""; envs.value = (props.studies?.envs ?? []).map((e) => ({ ...e })); }
</script>

<template>
  <SetCard id="set-flow-follow" title="流程进行中，跟进群和文档">
    <template #help>一件事按流程推进时，它关联的群、会话和文档里有了新内容，助手攒成一批读一遍，说清这件事变了什么。影响到已经在做或做完的阶段时先问你；只是信息的记在事项页上。文档只读新增或改过的行。读这些内容的是角色 item-follow，在 Agent 页给它选模型。</template>
    <SetRow label="流程进行中跟进它的群、会话和文档">
      <UiCheckbox :model-value="follow.enabled" switch aria-label="流程进行中跟进它的群、会话和文档" @change="(v: boolean) => saveFollow({ enabled: v }, v ? '流程进行中会跟进群和文档' : '不再跟进群和文档')" />
    </SetRow>
    <SetRow label="那边安静多少分钟后读这一批" hint="0–1440" :off="!follow.enabled">
      <input class="input set-num" type="number" inputmode="numeric" min="0" max="1440" aria-label="那边安静多少分钟后读这一批" :value="follow.quietMinutes" :disabled="!follow.enabled" @change="saveFollow({ quietMinutes: number(($event.target as HTMLInputElement).value, 0, 1440, 20) }, '已保存')" />
    </SetRow>
    <SetRow label="攒够多少条就不等安静了" hint="1–1000" :off="!follow.enabled">
      <input class="input set-num" type="number" inputmode="numeric" min="1" max="1000" aria-label="攒够多少条就不等安静了" :value="follow.maxMessages" :disabled="!follow.enabled" @change="saveFollow({ maxMessages: number(($event.target as HTMLInputElement).value, 1, 1000, 30) }, '已保存')" />
    </SetRow>
    <SetRow label="一件事一天最多读几批" hint="0 是不限；到了以后剩下的攒到第二天" :off="!follow.enabled">
      <input class="input set-num" type="number" inputmode="numeric" min="0" max="200" aria-label="一件事一天最多读几批" :value="follow.maxRunsPerDay ?? 12" :disabled="!follow.enabled" @change="saveFollow({ maxRunsPerDay: number(($event.target as HTMLInputElement).value, 0, 200, 12) }, '已保存')" />
    </SetRow>
  </SetCard>

  <SetCard id="set-gate-ladder" title="总是同意的关卡">
    <template #help>流程里“开始前先问你”的阶段，你连着直接点“开始”到下面的次数，助手问一次：以后轮到它就直接开始吗？你同意了才改。之后你重开过这一段，或让它停下，就退回每次问你。流程定义里写了不能改的关卡（推送、上线这类）不参与。已经改成直接开始的，在流程页那份流程里能看到、能改回去。</template>
    <SetRow label="连着同意以后，问我要不要改成直接开始">
      <UiCheckbox :model-value="ladder.enabled" switch aria-label="连着同意以后，问我要不要改成直接开始" @change="(v: boolean) => saveLadder({ enabled: v }, v ? '连着同意以后会问你要不要直接开始' : '关卡一律每次问你')" />
    </SetRow>
    <SetRow label="连着同意几次以后问" hint="2–50" :off="!ladder.enabled">
      <input class="input set-num" type="number" inputmode="numeric" min="2" max="50" aria-label="连着同意几次以后问" :value="ladder.after" :disabled="!ladder.enabled" @change="saveLadder({ after: number(($event.target as HTMLInputElement).value, 2, 50, 5) }, '已保存')" />
    </SetRow>
  </SetCard>

  <SetCard id="set-commit-claim" title="你直接做的提交挂回事项">
    <template #help>你没经过助手、直接在仓库里写代码并提交时，助手会看这些提交属于哪件事，在一张卡片上请你选：挂到某件已有的事上、新建一件、或不用管。你选了才会动；挂到已有的事上时，它流程里还没开始的编码那一段会记成已经做了。只看你自己写的、本地分支上的新提交；零碎的提交（改格式、升依赖）不会来问。判断的是角色 commit-claim，在 Agent 页给它选模型。</template>
    <SetRow label="看我直接在仓库里做的提交属于哪件事">
      <UiCheckbox :model-value="commits.enabled" switch aria-label="看我直接在仓库里做的提交属于哪件事" @change="(v: boolean) => saveCommits({ enabled: v }, v ? '会看你直接做的提交' : '不再看你直接做的提交')" />
    </SetRow>
    <SetRow label="分支安静多少分钟以后再来问" hint="1–1440" :off="!commits.enabled">
      <input class="input set-num" type="number" inputmode="numeric" min="1" max="1440" aria-label="分支安静多少分钟以后再来问" :value="commits.quietMinutes" :disabled="!commits.enabled" @change="saveCommits({ quietMinutes: number(($event.target as HTMLInputElement).value, 1, 1440, 30) }, '已保存')" />
    </SetRow>
  </SetCard>

  <SetCard id="set-study-envs" title="研究的试验在哪跑">
    <template #help>研究的每个方向写明它的试验在哪个环境里跑，只能用这里登记的。本机不用登记，它一直在：试验在给研究单独建的工作区里跑，不碰你的仓库目录；能不能在本机执行别人仓库的脚本，在每个研究自己的范围里开。别的环境（云端会话、托管的流水线）在这里登记：说明里写清怎么把文件带过去、怎么读回结果，试验的运行会照着做。选了“派给设备”的环境，试验交给你配对过的那台设备：它找到自己的那份仓库，切到方向确认时的提交，用它自己的模型跑完，把结果和证据文件送回这里。</template>
    <div class="set-pad">
    <div v-for="(e, i) in envs" :key="i" class="env">
      <div class="env-line">
        <label class="field env-name"><span>名字</span><input v-model="e.name" class="input" placeholder="云端会话" @input="touch" /></label>
        <label class="field env-id"><span>标识</span><input v-model="e.id" class="input mono" placeholder="cloud" @input="touch" /></label>
        <div class="field env-tier"><span>用哪一档模型</span>
          <span v-if="custom(e)" class="muted small">在配置文件里指定了后端</span>
          <UiSelect v-else :model-value="tierOf(e)" aria-label="用哪一档模型" :options="TIERS" @change="(v) => setTier(e, String(v))" />
        </div>
        <div class="field env-peer"><span>派给设备</span>
          <UiSelect :model-value="e.peer ?? ''" aria-label="派给设备" :options="deviceOptions(e)" @change="(v) => setPeer(e, String(v))" />
        </div>
      </div>
      <p v-if="e.peer" class="muted small env-hint">试验交给 {{ e.peer }}，用它自己的模型跑；“用哪一档模型”由那台按它自己的档位设置来选。</p>
      <label class="field"><span>怎么用这个环境</span><textarea v-model="e.note" class="input" rows="2" placeholder="把仓库打包上传到会话的工作目录；跑完把日志和结果文件下载回来放进证据。" @input="touch" /></label>
      <div class="row wrap">
        <UiCheckbox v-model="e.thirdParty" @change="touch">这里可以执行别人仓库的安装脚本和构建脚本（用完就丢的环境才勾）</UiCheckbox>
        <span class="spacer" />
        <button type="button" class="btn ghost sm" @click="remove(i)">去掉</button>
      </div>
    </div>
    <p v-if="!envs.length" class="muted small">现在只有本机。</p>
    <p v-if="problem" class="error small" role="alert">{{ problem }}</p>
    <div class="row wrap">
      <button type="button" class="btn ghost sm" @click="add">登记一个环境</button>
      <span class="spacer" />
      <button v-if="dirty" type="button" class="btn ghost sm" @click="reset">放弃改动</button>
      <button v-if="dirty" type="button" class="btn primary sm" @click="saveEnvs">保存</button>
    </div>
    </div>
  </SetCard>
</template>

<style scoped>
.env { display: grid; gap: 8px; padding: 4px 0 12px; border-bottom: 1px solid var(--line); }
.env-line { display: flex; flex-wrap: wrap; gap: 8px 12px; }
.env-name { flex: 2 1 160px; }
.env-id { flex: 1 1 110px; }
.env-tier { flex: 1 1 150px; }
.env-peer { flex: 1 1 150px; }
.env-hint { margin: 0; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.error { color: var(--danger); margin: 0; }
</style>
