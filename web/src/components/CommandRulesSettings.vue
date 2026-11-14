<script setup lang="ts">
import HelpText from "./HelpText.vue";
import { computed, onMounted, ref } from "vue";
import { get, put } from "../api";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { toast } from "../store";
import { confirmDialog } from "../lib/dialog";

/**
 * 设置 → 安全 → 命令规则 (src/agents/command-gate.ts, docs/v2/command-gate.md): which commands an
 * agent's processes have to ask about first. Rules match in order; the first one that matches decides.
 */
type Action = "approve" | "deny" | "allow";
type Rule = { command: string; args: string; action: Action; approver: string; approvers: string[]; waitSeconds: number; expireHours: number; reuse: "once" | "window"; note: string };
/** A rule as edited: the approver split into what the select shows and a Feishu name typed beside it. */
type Draft = Rule & { key: number; pick: string; larkName: string; larkList: string };

const rules = ref<Draft[] | null>(null);
const approvers = ref<{ value: string; label: string }[]>([]);
const platform = ref("");
const saved = ref("");
const saving = ref(false);
let seq = 0;

const ACTIONS = [
  { value: "approve" as Action, label: "需要审批" },
  { value: "deny" as Action, label: "一律拒绝" },
  { value: "allow" as Action, label: "放行" },
];
const WAITS = [30, 60, 90, 120, 180, 300].map((n) => ({ value: n, label: `${n} 秒` }));
const EXPIRES = [1, 4, 24, 72, 168].map((n) => ({ value: n, label: n < 24 ? `${n} 小时` : `${n / 24} 天` }));
const pickOptions = computed(() => [...approvers.value, { value: "lark", label: "飞书用户（填名字或邮箱）" }, { value: "run", label: "由运行提名（从名单里选）" }]);
const listOptions = computed(() => approvers.value.map((a) => ({ value: a.value, label: a.label })));

function toDraft(r: Rule): Draft {
  const lark = r.approver.startsWith("lark:");
  return {
    ...r,
    key: ++seq,
    pick: lark ? "lark" : r.approver,
    larkName: lark ? r.approver.slice(5) : "",
    larkList: r.approvers.filter((a) => a.startsWith("lark:")).map((a) => a.slice(5)).join("，"),
    approvers: r.approvers.filter((a) => !a.startsWith("lark:")),
  };
}
function toRule(d: Draft): Rule {
  const lark = d.larkList.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).map((s) => `lark:${s}`);
  return {
    command: d.command.trim(),
    args: d.args,
    action: d.action,
    approver: d.pick === "lark" ? `lark:${d.larkName.trim()}` : d.pick,
    approvers: d.pick === "run" ? [...d.approvers, ...lark] : [],
    waitSeconds: d.waitSeconds,
    expireHours: d.expireHours,
    reuse: d.reuse,
    note: d.note,
  };
}
const snapshot = () => JSON.stringify((rules.value ?? []).map(toRule));
const dirty = computed(() => rules.value !== null && snapshot() !== saved.value);

async function load() {
  const r = await get<{ rules: Rule[]; approvers: { value: string; label: string }[]; platform: string }>("/api/security/command-rules");
  approvers.value = r.approvers;
  platform.value = r.platform;
  rules.value = r.rules.map(toDraft);
  saved.value = snapshot();
}
function add() {
  rules.value?.push(toDraft({ command: "", args: "", action: "approve", approver: "owner", approvers: [], waitSeconds: 90, expireHours: 24, reuse: "once", note: "" }));
}
function move(i: number, d: -1 | 1) {
  const list = rules.value!;
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
async function remove(i: number) {
  const r = rules.value![i];
  if (!(await confirmDialog("删除这条规则？", { message: `${r.command || "（未填命令）"}${r.args ? ` ${r.args}` : ""}：保存后，Agent 再执行它就不经过这条规则。`, okText: "删除", danger: true }))) return;
  rules.value!.splice(i, 1);
}
async function save() {
  if (!rules.value) return;
  const bad = rules.value.find((r) => !r.command.trim() || (r.pick === "lark" && !r.larkName.trim()));
  if (bad) return toast(bad.command.trim() ? `「${bad.command}」的飞书审批人还没填` : "有规则还没填命令名", "error");
  saving.value = true;
  try {
    const r = await put<{ rules: Rule[] }>("/api/security/command-rules", { rules: rules.value.map(toRule) });
    rules.value = r.rules.map(toDraft);
    saved.value = snapshot();
    toast("已保存，之后新启动的 Agent 进程按这些规则拦截", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
onMounted(() => load().catch((e) => toast((e as Error).message, "error")));
</script>

<template>
  <div class="stack">
    <div class="row wrap">
      <strong class="grow">命令规则</strong>
      <button class="btn ghost sm" :disabled="!rules" @click="add">添加规则</button>
      <button class="btn primary sm" :disabled="!dirty || saving" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
    </div>
    <HelpText>
      Agent（以及规则里的脚本）通过 PATH 执行这里列出的命令时，先问 omem：需要审批的会给审批人发卡片，批准后才执行；没等到批准，命令以退出码 126 返回，批准后唤醒发起的运行，让它原样重跑。规则从上到下匹配，第一条命中的生效，都不命中就放行；“放行”用来在更宽的规则前开口子。参数模式是正则，匹配按空格连起来的参数，留空表示任何参数。
    </HelpText>
    <div class="card pad small muted stack">
      <span>能拦住：shell 直接执行、shell 脚本、Python 的 subprocess、Node 的 spawn / execFile 等经 PATH 查找的调用。拦不住：用绝对路径调用、Agent 自己改 PATH 或删掉拦截目录、直接调命令背后的接口。它防的是误操作和默认路径，不是对抗性的 Agent；真正要保护的凭据不要放在 Agent 进程能读到的地方。</span>
      <span v-if="platform === 'win32'">这台是 Windows：cmd、PowerShell、Git Bash 里按名字执行能拦住；Node 不带 shell 的 execFile、Python 列表形式的 subprocess 只找 .exe，若真正的命令是 .exe，这两种调用拦不住。</span>
      <span>规则对之后新启动的 Agent 进程生效；已在运行的会话进程，原来没有任何规则时要等它重新启动。</span>
    </div>
    <Skeleton v-if="!rules" variant="text" :rows="4" />
    <div v-else-if="!rules.length" class="card pad muted">还没有命令规则，Agent 执行任何命令都只按它自己后端的审批。“添加规则”写下要保护的命令名。</div>
    <div v-for="(r, i) in rules ?? []" :key="r.key" class="card pad stack rule">
      <div class="row wrap gap">
        <span class="muted small">第 {{ i + 1 }} 条</span>
        <span class="spacer" />
        <button class="btn ghost sm" :disabled="i === 0" aria-label="上移" @click="move(i, -1)">上移</button>
        <button class="btn ghost sm" :disabled="i === rules!.length - 1" aria-label="下移" @click="move(i, 1)">下移</button>
        <button class="btn ghost sm danger" @click="remove(i)">删除</button>
      </div>
      <div class="grid">
        <label class="field"><span>命令名</span><input v-model="r.command" class="input mono" placeholder="如 acmectl（不带路径）" spellcheck="false" /></label>
        <label class="field"><span>参数模式（正则，留空 = 任何参数）</span><input v-model="r.args" class="input mono" placeholder="如 ^(deploy|delete)\b" spellcheck="false" /></label>
      </div>
      <div class="field"><span>动作</span><UiSegmented v-model="r.action" size="sm" aria-label="动作" :options="ACTIONS" /></div>
      <template v-if="r.action === 'approve'">
        <div class="grid">
          <div class="field">
            <span>审批人</span>
            <UiSelect v-model="r.pick" aria-label="审批人" :options="pickOptions" />
          </div>
          <label v-if="r.pick === 'lark'" class="field"><span>飞书用户的名字或邮箱</span><input v-model="r.larkName" class="input" placeholder="如 小王 或 xiaowang@example.com" /></label>
        </div>
        <template v-if="r.pick === 'run'">
          <div class="field">
            <span>可以被提名的人（Agent 用环境变量 OMEM_APPROVER 提名；不在名单里的改由你批准，提名时你也会收到通知）</span>
            <UiSelect v-model="r.approvers" multiple aria-label="可以被提名的人" placeholder="选 omem 用户" :options="listOptions" />
          </div>
          <label class="field"><span>名单里的飞书用户（不是 omem 用户的，名字或邮箱，用逗号隔开）</span><input v-model="r.larkList" class="input" placeholder="如 小王，小李" /></label>
        </template>
        <div class="grid three">
          <div class="field"><span>命令等审批多久</span><UiSelect v-model="r.waitSeconds" aria-label="命令等审批多久" :options="WAITS" /></div>
          <div class="field"><span>卡片和批准的有效期</span><UiSelect v-model="r.expireHours" aria-label="卡片和批准的有效期" :options="EXPIRES" /></div>
          <div class="field"><span>批准一次</span><UiSegmented v-model="r.reuse" size="sm" aria-label="批准一次" :options="[{ value: 'once', label: '放行一次' }, { value: 'window', label: '有效期内都放行' }]" /></div>
        </div>
      </template>
      <label class="field"><span>说明（给审批人看：这条命令会改什么）</span><textarea v-model="r.note" class="textarea" rows="2" placeholder="如：会改线上的路由配置，影响所有用户" /></label>
    </div>
  </div>
</template>

<style scoped>
.rule {
  min-width: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
@media (max-width: 760px) {
  .grid,
  .grid.three {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
