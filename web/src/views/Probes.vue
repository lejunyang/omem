<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { del, get, post, put, type Run } from "../api";
import HelpText from "../components/HelpText.vue";
import Icon from "../components/Icon.vue";
import RuleTabs from "../components/RuleTabs.vue";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSegmented from "../components/UiSegmented.vue";
import { confirmDialog } from "../lib/dialog";
import { forgetFirstLookOptions, PROBE_SAMPLE, RUNTIME_HINT, RUNTIMES, msText, type Probe, type ProbeSummary, type ProbeTry, type Runtime } from "../lib/first-look";
import { fmtTime, relTime, state, toast } from "../store";

/**
 * 预查库 (docs/v2/first-look.md): short read-only scripts the owner keeps by name and a rule or a 关注
 * runs before its first look (or as a rule's 预查 step). The same list-and-detail page as the rules: the
 * probes on the left, one probe's editor and a trial run on the right. Reading the list is for whoever
 * reads rules; the code, saving, deleting and trying are the owner's (the server checks it too).
 */
const route = useRoute();
const router = useRouter();
const isOwner = computed(() => !state.me || state.me.role === "owner");
const list = ref<ProbeSummary[]>([]);
const loading = ref(true);
const selected = computed(() => (typeof route.query.name === "string" ? route.query.name : null));
const creating = computed(() => route.query.new === "1");
/** The last time each probe ran (its runs, kind probe): a trial is said so. */
const lastRun = ref<Record<string, Run>>({});

type Form = { name: string; description: string; match: string; runtime: Runtime; code: string; timeoutSec: number; direct: boolean };
const blank = (): Form => ({ name: "", description: "", match: "", runtime: "node", code: PROBE_SAMPLE.node, timeoutSec: 20, direct: false });
const form = ref<Form | null>(null);
const saved = ref<Probe | null>(null);
const dirty = ref(false);
const saving = ref(false);
const touch = () => (dirty.value = true);

async function loadList() {
  try {
    list.value = await get<ProbeSummary[]>("/api/probes");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    loading.value = false;
  }
  // Not `brief`: that leaves out the input, where the probe's name is (the title has it too: 预查「名字」).
  const runs = await get<{ runs: Run[] }>("/api/runs?kind=probe&all=1&limit=100").catch(() => ({ runs: [] as Run[] }));
  const last: Record<string, Run> = {};
  for (const r of runs.runs) {
    const name = String(r.input?.probe ?? /预查「(.+?)」/.exec(r.title)?.[1] ?? "");
    if (name && !last[name]) last[name] = r;
  }
  lastRun.value = last;
}
let seq = 0;
async function loadCurrent() {
  const my = ++seq;
  trial.value = null;
  saved.value = null;
  dirty.value = false;
  if (creating.value) return void (form.value = blank());
  if (!selected.value) return void (form.value = null);
  if (!isOwner.value) {
    // Reading rules only: what the list says, no code.
    form.value = null;
    return;
  }
  try {
    const p = await get<Probe>(`/api/probes/${encodeURIComponent(selected.value)}`);
    if (my !== seq) return;
    saved.value = p;
    form.value = { name: p.name, description: p.description, match: p.match ?? "", runtime: p.runtime, code: p.code, timeoutSec: p.timeoutSec, direct: p.direct };
  } catch (e) {
    if (my === seq) toast((e as Error).message, "error");
  }
}
onMounted(async () => {
  await loadList();
  await loadCurrent();
});
watch(() => [route.query.name, route.query.new], () => void loadCurrent());
onBeforeRouteLeave(async () => !dirty.value || (await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true })));
async function go(query: Record<string, string>) {
  if (dirty.value && !(await confirmDialog("有未保存的修改，放弃吗？", { okText: "放弃修改", danger: true }))) return;
  dirty.value = false;
  await router.replace({ query });
}
const shown = computed(() => list.value.find((p) => p.name === selected.value) ?? null);

/** Changing the runtime of an untouched sample swaps the sample too. */
function setRuntime(r: Runtime) {
  const f = form.value!;
  if (Object.values(PROBE_SAMPLE).includes(f.code)) f.code = PROBE_SAMPLE[r];
  f.runtime = r;
  touch();
}
const NAME = /^[\p{L}\p{N}_.-]{1,40}$/u;
const problem = computed(() => {
  const f = form.value;
  if (!f) return "";
  if (!NAME.test(f.name.trim())) return "名字用文字、数字、下划线、点或短横线，最多 40 个字";
  if (!f.description.trim()) return "写一句它查什么、输出什么";
  if (!f.code.trim()) return "代码不能是空的";
  if (f.match.trim()) {
    try {
      new RegExp(f.match.trim(), "iu");
    } catch {
      return "匹配条件不是合法的正则表达式";
    }
  }
  return "";
});
const body = (f: Form) => ({ description: f.description.trim(), ...(f.match.trim() ? { match: f.match.trim() } : {}), runtime: f.runtime, code: f.code, timeoutSec: f.timeoutSec, direct: f.direct });
async function save() {
  const f = form.value;
  if (!f || saving.value) return;
  if (problem.value) return toast(problem.value, "error");
  const name = f.name.trim();
  if (creating.value && list.value.some((p) => p.name === name) && !(await confirmDialog(`已经有叫「${name}」的预查`, { message: "保存会换掉它的说明和代码，用到它的规则和关注从下一次起跑新的。", okText: "替换" }))) return;
  saving.value = true;
  try {
    await put<Probe>(`/api/probes/${encodeURIComponent(name)}`, body(f));
    dirty.value = false;
    forgetFirstLookOptions();
    toast("已保存", "ok");
    await loadList();
    if (creating.value) await router.replace({ query: { name } });
    else await loadCurrent();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
async function remove() {
  const name = saved.value?.name;
  if (!name || !(await confirmDialog(`删除预查「${name}」？`, { message: "用到它的规则和关注会在下次触发时跳过它（结果里写“预查库里没有这个名字”）；改那些规则时要先把它去掉才能保存。", okText: "删除", danger: true }))) return;
  try {
    await del(`/api/probes/${encodeURIComponent(name)}`);
    dirty.value = false;
    forgetFirstLookOptions();
    toast(`已删除：${name}`, "ok");
    await router.replace({ query: {} });
    await loadList();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ---- trying it on a sample message (saved or not: the editor's code as it is now)
const sample = ref("");
const trying = ref(false);
const trial = ref<ProbeTry | null>(null);
async function tryIt() {
  const f = form.value;
  if (!f || trying.value) return;
  if (problem.value) return toast(problem.value, "error");
  trying.value = true;
  trial.value = null;
  try {
    trial.value = await post<ProbeTry>("/api/probes/try", { name: f.name.trim(), ...body(f), sample: { text: sample.value } });
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    trying.value = false;
  }
}
const captureRows = computed(() => Object.entries(trial.value?.captures ?? {}).sort(([a], [b]) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b))));
const runLine = (r: Run) => `${r.input?.trial ? "试跑 · " : ""}${r.status === "done" ? "完成" : r.status === "failed" ? "失败" : r.status === "running" ? "正在跑" : r.status === "cancelled" ? "取消了" : "排队中"} · ${relTime(r.createdAt)}`;
</script>

<template>
  <div class="probes">
    <aside class="list-col">
      <div class="head row">
        <RuleTabs />
        <span class="spacer" />
        <button v-if="isOwner" class="btn ghost sm icon" title="新建预查" aria-label="新建预查" @click="go({ new: '1' })"><Icon name="plus" :size="15" /></button>
      </div>
      <div class="items">
        <Skeleton v-if="loading" :rows="4" />
        <template v-else>
          <div v-for="p in list" :key="p.name" class="li" :class="{ on: p.name === selected }">
            <button class="grow pick" type="button" @click="go({ name: p.name })">
              <div class="row"><strong class="ellipsis mono-name">{{ p.name }}</strong><span v-if="p.direct" class="badge accent" title="成功且有输出时，输出原样作为结论发出，不经模型">直接发出</span></div>
              <div class="muted small clamp">{{ p.description }}</div>
              <div class="muted small meta">
                <span>{{ RUNTIMES.find((r) => r.value === p.runtime)?.label }}</span>
                <span :title="p.match ? `匹配 ${p.match}` : ''">{{ p.match ? "按正则匹配" : "每条都跑" }}</span>
                <span v-if="lastRun[p.name]" :title="fmtTime(lastRun[p.name].createdAt)">{{ runLine(lastRun[p.name]) }}</span>
                <span v-else>还没跑过</span>
              </div>
            </button>
          </div>
          <p v-if="!list.length" class="muted small hint">还没有预查。{{ isOwner ? "点 ＋ 写一个，或让助手在对话里提议（它提的要你在卡片上看完代码点“保存”才进库）。" : "" }}</p>
        </template>
      </div>
    </aside>

    <main class="detail">
      <!-- nothing picked: what a probe is and where the line is -->
      <div v-if="!form && !shown" class="empty">
        <Icon name="zap" :size="34" />
        <h3>预查</h3>
        <p>预查是你存好的只读小脚本，比如“查这个用户 ID 的账号状态”“看这个接口最近一小时的报错数”。规则或关注打开“先快速看一眼”后，消息一来先跑选中的预查，几秒内拿到事实，再交给快模型看；规则里也可以加一步“预查”单独跑。</p>
        <p class="muted small">安全线：只有你能保存、修改和删除预查，助手只能提议，你看过完整代码点“保存”才算数。脚本在运行 omem 的这台机器上跑，每次一个临时目录、只带最基本的环境变量，拿不到 omem 的密钥和令牌；消息作为 JSON 交给它，不会拼进代码或命令行。</p>
        <button v-if="isOwner" class="btn" @click="go({ new: '1' })"><Icon name="plus" :size="14" />新建预查</button>
      </div>

      <!-- reading rules only: what the list says -->
      <div v-else-if="!form && shown" class="page">
        <header class="dh row"><strong class="grow ro-name mono-name">{{ shown.name }}</strong><span v-if="shown.direct" class="badge accent">直接发出</span></header>
        <p class="note">{{ shown.description }}</p>
        <dl class="ro-facts">
          <dt>运行</dt><dd>{{ RUNTIME_HINT[shown.runtime] }} · 最长 {{ shown.timeoutSec }} 秒 · {{ shown.lines }} 行</dd>
          <dt>匹配</dt><dd><code v-if="shown.match">{{ shown.match }}</code><template v-else>每条消息都跑</template></dd>
          <dt>更新</dt><dd>{{ fmtTime(shown.updatedAt) }}</dd>
        </dl>
        <p class="muted small">代码、修改和试跑只有本人看得到。</p>
      </div>

      <div v-else-if="form" class="page">
        <header class="dh row">
          <input v-if="creating" v-model="form.name" class="input title mono-name" maxlength="40" placeholder="名字，例如 order_status" aria-label="预查名" @input="touch" />
          <strong v-else class="grow ro-name mono-name">{{ form.name }}</strong>
          <span v-if="saved?.via === 'proposal'" class="badge" title="助手提议、你在卡片上看过代码后保存的">助手提议的</span>
          <button class="btn sm primary" :disabled="saving || (!creating && !dirty)" @click="save">保存</button>
          <button v-if="saved" class="btn ghost sm icon danger" title="删除" aria-label="删除这个预查" @click="remove"><Icon name="trash" :size="14" /></button>
        </header>
        <HelpText>预查只读、在这台机器上跑：只有你能保存，脚本拿不到 omem 的密钥和令牌，失败或超时不挡后面的步骤。</HelpText>

        <section class="block">
          <div class="block-head"><h3>查什么</h3></div>
          <input v-model="form.description" class="input" maxlength="200" placeholder="一句话：它查什么、输出什么，例如：按订单号查退款状态，输出状态和最后更新时间" aria-label="一句说明" @input="touch" />
          <small class="muted">快模型读预查结果时看到这句话，用它判断输出说明了什么。</small>
        </section>

        <section class="block">
          <div class="block-head"><h3>什么消息才跑</h3><span class="muted small">可不填</span></div>
          <input v-model="form.match" class="input mono small" maxlength="500" placeholder="正则，例如 订单号[:：]?\s*(\d{8,})；不填就每条都跑" aria-label="匹配的正则" @input="touch" />
          <small class="muted">不区分大小写；消息不匹配就跳过，不起运行。捕获组交给脚本：环境变量 OMEM_CAPTURES 里 "0" 是整段匹配，"1" 起是分组，命名组按名字。</small>
        </section>

        <section class="block">
          <div class="block-head"><h3>代码</h3></div>
          <div class="row wrap">
            <UiSegmented :model-value="form.runtime" size="sm" :options="RUNTIMES" aria-label="脚本语言" @update:model-value="(v) => setRuntime(v as Runtime)" />
            <label class="row inline small">最长
              <input v-model.number="form.timeoutSec" class="input sm num" type="number" inputmode="numeric" min="1" max="120" aria-label="最长运行秒数" @change="form.timeoutSec = Math.min(120, Math.max(1, Math.round(form.timeoutSec || 20)))" @input="touch" />
              秒</label>
          </div>
          <textarea v-model="form.code" class="input mono small code" rows="12" spellcheck="false" :aria-label="RUNTIME_HINT[form.runtime] + ' 代码'" @input="touch" />
          <small class="muted">用 {{ RUNTIME_HINT[form.runtime] }} 执行。触发的事件是 JSON：在环境变量 OMEM_EVENT 里，也从标准输入传进来；预查名在 OMEM_PROBE。打印出来的就是结果（交给后面时截到 4000 字）；退出码不是 0 算失败。</small>
        </section>

        <section class="block">
          <UiCheckbox v-model="form.direct" switch size="sm" @change="touch">输出直接发出，不过模型</UiCheckbox>
          <small class="muted">{{ form.direct ? "跑成功且有输出时，输出原样作为“先看一眼”的结论（答完了），按第一条的去处发出，不经快模型，也不经决策模型复核。只给输出本身就能回答的预查打开。" : "关着时，输出交给快模型当材料，由它决定怎么答。" }}</small>
        </section>

        <section class="block">
          <div class="block-head"><h3>试跑</h3><span class="muted small">用编辑器里现在的代码，没保存也能试</span></div>
          <textarea v-model="sample" class="input small" rows="3" placeholder="一条示例消息，例如：订单 20261125001 退款一直没到账，帮忙看下" aria-label="示例消息" />
          <div class="row wrap"><button class="btn sm" :disabled="trying" @click="tryIt">{{ trying ? "试跑中…" : "试跑" }}</button><small class="muted">真的会在这台机器上执行一次，记成一次“预查”运行。</small></div>
          <template v-if="trial">
            <p v-if="!trial.matched" class="small warn-line">示例消息不匹配上面的正则：真遇到这条消息时会跳过，不执行。</p>
            <template v-else>
              <div class="row wrap small facts-line">
                <span class="badge" :class="trial.ok ? 'ok' : 'danger'">{{ trial.ok ? "成功" : trial.timedOut ? "超时" : "失败" }}</span>
                <span>退出码 {{ trial.exitCode ?? "—" }}</span>
                <span>用时 {{ msText(trial.ms) }}</span>
                <router-link v-if="trial.runId" :to="`/runs/${trial.runId}`">看这次运行</router-link>
              </div>
              <div v-if="captureRows.length" class="captures small">
                <div class="muted">匹配到的</div>
                <dl>
                  <template v-for="[k, v] in captureRows" :key="k"><dt>{{ k === "0" ? "整段" : /^\d+$/.test(k) ? `分组 ${k}` : k }}</dt><dd><code>{{ v }}</code></dd></template>
                </dl>
              </div>
              <div class="small muted">输出</div>
              <pre class="out">{{ trial.output || "（没有输出）" }}</pre>
              <template v-if="trial.stderr.trim()">
                <div class="small muted">标准错误</div>
                <pre class="out err">{{ trial.stderr }}</pre>
              </template>
            </template>
          </template>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
.probes {
  display: flex;
  height: 100%;
}
.list-col {
  width: 300px;
  flex: none;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  gap: 8px;
}
.items {
  overflow-y: auto;
  padding: 6px;
  flex: 1;
}
.hint {
  padding: 6px 10px;
}
.li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
}
.li:hover {
  background: var(--hover);
}
.li.on {
  background: var(--accent-soft);
}
.li .row {
  gap: 6px;
}
.pick {
  border: 0;
  background: none;
  text-align: left;
  color: var(--ink);
  cursor: pointer;
  padding: 0;
  min-width: 0;
  font: inherit;
  display: grid;
  gap: 2px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.meta {
  display: flex;
  flex-wrap: wrap;
}
.meta > span + span::before {
  content: "·";
  margin: 0 5px;
}
.mono-name {
  font-family: var(--mono);
}
.detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.page {
  max-width: 880px;
  padding: 16px 24px 40px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}
.dh {
  gap: 10px;
  flex-wrap: wrap;
}
.title {
  flex: 1;
  min-width: 160px;
  font-size: 16px;
  font-weight: 600;
}
.ro-name {
  font-size: 16px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.note {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.block {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
}
.block-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.block-head h3 {
  margin: 0;
  font-size: 14px;
}
.wrap {
  flex-wrap: wrap;
  gap: 8px;
}
.inline {
  gap: 6px;
}
.num {
  width: 72px;
}
.code {
  line-height: 1.5;
  tab-size: 2;
  white-space: pre;
  overflow-x: auto;
}
.facts-line {
  gap: 10px;
  align-items: center;
}
.warn-line {
  margin: 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--warn-soft);
  color: var(--ink-2);
}
.captures dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 12px;
  margin: 4px 0 0;
}
.captures dt {
  color: var(--muted);
}
.captures dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.captures code {
  overflow-wrap: anywhere;
  word-break: break-all;
}
.out {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--sunken);
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow-y: auto;
}
.out.err {
  color: var(--danger);
}
.ro-facts {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 8px 12px;
  margin: 0;
  font-size: 14px;
}
.ro-facts dt {
  color: var(--muted);
}
.ro-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.empty {
  max-width: 620px;
  margin: 50px auto;
  text-align: center;
  color: var(--ink-2);
  padding: 0 16px;
  display: grid;
  gap: 10px;
  justify-items: center;
}
.empty p {
  margin: 0;
  line-height: 1.65;
}
@media (max-width: 760px) {
  .probes {
    flex-direction: column;
  }
  .list-col {
    width: 100%;
    max-height: 36vh;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .page {
    padding: 12px 16px 32px;
  }
}
</style>
