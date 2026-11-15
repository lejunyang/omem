<script setup lang="ts">
import { computed, ref, watch } from "vue";
import HelpText from "./HelpText.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/**
 * How flows behave on their own (docs/v2/flows.md, docs/v2/studies.md): reading an item's chats and
 * documents while its flow runs, offering to stop asking at a gate the owner keeps agreeing to, and
 * the places a study's trials may run in.
 */
type Follow = { enabled: boolean; quietMinutes: number; maxMessages: number; maxRunsPerDay?: number };
type Ladder = { enabled: boolean; after: number };
type Env = { id: string; name: string; note: string; ai?: string | { profile: string; model?: string; effort?: string }; thirdParty: boolean };
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
  <div class="card pad stack">
    <div class="section-title">流程进行中，自己跟进群和文档</div>
    <HelpText>一件事按流程推进时，它关联的群、会话和文档里有了新内容，助手攒成一批读一遍，说清这件事变了什么。影响到已经在做或做完的阶段时先问你；只是信息的记在事项页上。文档只读新增或改过的行。读这些内容的是角色 item-follow，在 Agent 页给它选模型。</HelpText>
    <UiCheckbox :model-value="follow.enabled" switch @change="(v: boolean) => saveFollow({ enabled: v }, v ? '流程进行中会跟进群和文档' : '不再跟进群和文档')">流程进行中跟进它的群、会话和文档</UiCheckbox>
    <label class="field"><span>那边安静多少分钟后读这一批（0–1440）</span>
      <input class="input narrow" type="number" inputmode="numeric" min="0" max="1440" :value="follow.quietMinutes" :disabled="!follow.enabled" @change="saveFollow({ quietMinutes: number(($event.target as HTMLInputElement).value, 0, 1440, 20) }, '已保存')" />
    </label>
    <label class="field"><span>攒够多少条就不等安静了（1–1000）</span>
      <input class="input narrow" type="number" inputmode="numeric" min="1" max="1000" :value="follow.maxMessages" :disabled="!follow.enabled" @change="saveFollow({ maxMessages: number(($event.target as HTMLInputElement).value, 1, 1000, 30) }, '已保存')" />
    </label>
    <label class="field"><span>一件事一天最多读几批（0 是不限；到了以后剩下的攒到第二天）</span>
      <input class="input narrow" type="number" inputmode="numeric" min="0" max="200" :value="follow.maxRunsPerDay ?? 12" :disabled="!follow.enabled" @change="saveFollow({ maxRunsPerDay: number(($event.target as HTMLInputElement).value, 0, 200, 12) }, '已保存')" />
    </label>
  </div>

  <div class="card pad stack">
    <div class="section-title">总是同意的关卡，问一次要不要以后直接开始</div>
    <HelpText>流程里“开始前先问你”的阶段，你连着直接点“开始”到下面的次数，助手问一次：以后轮到它就直接开始吗？你同意了才改。之后你重开过这一段，或让它停下，就退回每次问你。流程定义里写了不能改的关卡（推送、上线这类）不参与。已经改成直接开始的，在 流程 页那份流程里能看到、能改回去。</HelpText>
    <UiCheckbox :model-value="ladder.enabled" switch @change="(v: boolean) => saveLadder({ enabled: v }, v ? '连着同意以后会问你要不要直接开始' : '关卡一律每次问你')">连着同意以后，问我要不要改成直接开始</UiCheckbox>
    <label class="field"><span>连着同意几次以后问（2–50）</span>
      <input class="input narrow" type="number" inputmode="numeric" min="2" max="50" :value="ladder.after" :disabled="!ladder.enabled" @change="saveLadder({ after: number(($event.target as HTMLInputElement).value, 2, 50, 5) }, '已保存')" />
    </label>
  </div>

  <div class="card pad stack">
    <div class="section-title">你直接做的提交，事后挂回事项上</div>
    <HelpText>你没经过助手、直接在仓库里写代码并提交时，助手会看这些提交属于哪件事，在一张卡片上请你选：挂到某件已有的事上、新建一件、或不用管。你选了才会动；挂到已有的事上时，它流程里还没开始的编码那一段会记成已经做了。只看你自己写的、本地分支上的新提交，不翻以前的；零碎的提交（改格式、升依赖）不会来问。判断的是角色 commit-claim，在 Agent 页给它选模型。</HelpText>
    <UiCheckbox :model-value="commits.enabled" switch @change="(v: boolean) => saveCommits({ enabled: v }, v ? '会看你直接做的提交' : '不再看你直接做的提交')">看我直接在仓库里做的提交属于哪件事</UiCheckbox>
    <label class="field"><span>分支安静多少分钟以后再来问（1–1440）</span>
      <input class="input narrow" type="number" inputmode="numeric" min="1" max="1440" :value="commits.quietMinutes" :disabled="!commits.enabled" @change="saveCommits({ quietMinutes: number(($event.target as HTMLInputElement).value, 1, 1440, 30) }, '已保存')" />
    </label>
  </div>

  <div class="card pad stack">
    <div class="section-title">课题的试验可以在哪跑</div>
    <HelpText>课题的每个方向写明它的试验在哪个环境里跑，只能用这里登记的。本机不用登记，它一直在：试验在宿主给课题单独建的工作区里跑，不碰你的仓库目录；能不能在本机执行别人仓库的脚本，在每个课题自己的范围里开。别的环境（云端会话、托管的流水线）在这里登记：说明里写清怎么把文件带过去、怎么读回结果，试验的运行会照着做。</HelpText>
    <div v-for="(e, i) in envs" :key="i" class="env">
      <div class="env-line">
        <label class="field env-name"><span>名字</span><input v-model="e.name" class="input" placeholder="云端会话" @input="touch" /></label>
        <label class="field env-id"><span>标识</span><input v-model="e.id" class="input mono" placeholder="cloud" @input="touch" /></label>
        <div class="field env-tier"><span>用哪一档模型</span>
          <span v-if="custom(e)" class="muted small">在配置文件里指定了后端</span>
          <UiSelect v-else :model-value="tierOf(e)" aria-label="用哪一档模型" :options="TIERS" @change="(v) => setTier(e, String(v))" />
        </div>
      </div>
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
</template>

<style scoped>
.narrow { width: 120px; }
.env { display: grid; gap: 8px; padding: 12px 0; border-top: 1px solid var(--line); }
.env-line { display: flex; flex-wrap: wrap; gap: 8px 12px; }
.env-name { flex: 2 1 160px; }
.env-id { flex: 1 1 110px; }
.env-tier { flex: 1 1 150px; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.error { color: var(--danger); margin: 0; }
</style>
