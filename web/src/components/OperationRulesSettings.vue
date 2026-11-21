<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { get, put } from "../api";
import { toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import { useBackends, useSettings } from "../views/settings/ctx";
import {
  ACTIONS, ENFORCED, FILE_OPS, KINDS, METHODS, actionLabel, cleanScope, fieldOf, jsonPathOf, kindLabel, loadScopeChoices, matchText, rowErrors, scopeChoices, scopeText,
  type Action, type JsonPattern, type Kind, type Match, type OperationRule,
} from "../lib/operation-rules";
import Icon from "./Icon.vue";
import MonoLine from "./MonoLine.vue";
import OperationScope from "./OperationScope.vue";
import RulePacksSettings from "./RulePacksSettings.vue";
import SetCard from "./SetCard.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 设置 → 安全 → 操作规则 (docs/v2/command-gate.md): what an agent has to ask about, may not do, or may
 * do and is only recorded. One row per rule in the order they apply (the first that matches decides,
 * none matching lets it through); a row opens into its editor. The list is saved as a whole
 * (PUT /api/security/operation-rules); rules from a pack keep what they match, only their scope and
 * switch change here. The packs themselves are the card below (RulePacksSettings).
 */
type Draft = {
  key: number;
  rule: OperationRule;
  /** What the server said applies it, for the kind it had when loaded. */
  enforcedBy?: string[];
  loadedKind?: Kind;
  /** Optional fields the rule had when loaded, kept even when empty (so an untouched rule saves as it was). */
  had: Set<string>;
  /** The other kinds' matches, so switching back and forth keeps what was typed. */
  stash: Partial<Record<Kind, Match>>;
  /** Fields edited as text: the subcommand words; the approver as picked; a run's list of Feishu names. */
  sub: string;
  pick: string;
  larkName: string;
  people: string[];
  larkList: string;
  error: string;
};

const { profiles } = useSettings();
const { profileOptions } = useBackends(profiles);
const backendOptions = computed(() => profileOptions.value.map((o) => ({ value: o.value, label: o.label, hint: o.value })));

const drafts = ref<Draft[] | null>(null);
const loadError = ref("");
const saved = ref("");
const saving = ref(false);
const open = ref<number | null>(null);
let seq = 0;

const DEFAULTS: Record<Kind, () => Match> = {
  command: () => ({ kind: "command", executable: "" }),
  http: () => ({ kind: "http", host: "" }),
  file: () => ({ kind: "file", operations: ["write", "delete"], pathRegex: "" }),
  tool: () => ({ kind: "tool", name: "" }),
};
const WAITS = [30, 60, 90, 120, 180, 300].map((n) => ({ value: n, label: n < 60 ? `${n} 秒` : `${n / 60} 分钟`.replace(".5 分钟", " 分半") }));
const pickOptions = computed(() => [...scopeChoices.approvers, { value: "lark", label: "飞书用户（填名字或邮箱）" }, { value: "run", label: "由运行提名（从名单里选）" }]);
const toolOptions = (current: string) => (current && !scopeChoices.tools.some((t) => t.value === current) ? [{ value: current, label: current }, ...scopeChoices.tools] : scopeChoices.tools);

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function toDraft(r: OperationRule): Draft {
  const { enforcedBy, ...rule } = clone(r);
  const had = new Set<string>();
  if (rule.title !== undefined) had.add("title");
  for (const k of ["argsRegex", "pathRegex", "server"]) if ((rule.match as Record<string, unknown>)[k] !== undefined) had.add(k);
  const approver = rule.approval?.approver ?? "owner";
  const approvers = rule.approval?.approvers ?? [];
  return {
    key: ++seq, rule, enforcedBy, loadedKind: rule.match.kind, had, stash: {},
    sub: rule.match.kind === "command" ? (rule.match.subcommand ?? []).join(" ") : "",
    pick: approver.startsWith("lark:") ? "lark" : approver,
    larkName: approver.startsWith("lark:") ? approver.slice(5) : "",
    people: approvers.filter((a) => !a.startsWith("lark:")),
    larkList: approvers.filter((a) => a.startsWith("lark:")).map((a) => a.slice(5)).join("，"),
    error: "",
  };
}

/** The rule as it is saved: no empty lists (an empty list matches nothing), no UI state. */
function clean(d: Draft): OperationRule {
  const r = d.rule;
  const keep = (k: string, v: string | undefined) => (v?.trim() || (d.had.has(k) && v !== undefined) ? v : undefined);
  const pattern = (p: JsonPattern) => ({ jsonPath: p.jsonPath.trim(), regex: p.regex });
  let match: Match;
  const m = r.match;
  if (m.kind === "command") {
    const subcommand = d.sub.split(/\s+/).filter(Boolean);
    match = { kind: "command", executable: m.executable.trim() };
    if (subcommand.length) match.subcommand = subcommand;
    if (m.argv?.length) match.argv = m.argv.map((a) => ({ index: a.index, regex: a.regex }));
    const args = keep("argsRegex", m.argsRegex);
    if (args !== undefined) match.argsRegex = args;
  } else if (m.kind === "http") {
    match = { kind: "http", host: m.host.trim() };
    if (m.methods?.length) match.methods = [...m.methods];
    const path = keep("pathRegex", m.pathRegex);
    if (path !== undefined) match.pathRegex = path;
    if (m.body && (m.body.jsonPath.trim() || m.body.regex)) match.body = pattern(m.body);
  } else if (m.kind === "file") {
    match = { kind: "file", operations: FILE_OPS.map((o) => o.value).filter((o) => m.operations.includes(o)), pathRegex: m.pathRegex };
  } else {
    match = { kind: "tool", name: m.name };
    const server = keep("server", m.server);
    if (server !== undefined) match.server = server;
    const args = (m.args ?? []).filter((a) => a.jsonPath.trim() || a.regex).map(pattern);
    if (args.length) match.args = args;
  }
  const out: OperationRule = { id: r.id, revision: r.revision, enabled: r.enabled, match: r.pack ? r.match : match, action: r.action };
  const title = keep("title", r.title);
  if (title !== undefined) out.title = r.pack ? r.title : title.trim() || title;
  const scope = cleanScope(r.scope);
  if (scope) out.scope = scope;
  if (r.approval) {
    const lark = d.larkList.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).map((s) => `lark:${s}`);
    out.approval = r.pack ? r.approval : {
      ...r.approval,
      approver: d.pick === "lark" ? `lark:${d.larkName.trim()}` : d.pick,
      ...(d.pick === "run" ? { approvers: [...d.people, ...lark] } : {}),
    };
  }
  if (r.pack) out.pack = r.pack;
  return out;
}
const snapshot = () => JSON.stringify((drafts.value ?? []).map(clean));
const dirty = computed(() => drafts.value !== null && snapshot() !== saved.value);

async function load() {
  loadError.value = "";
  try {
    const r = await get<{ rules: OperationRule[] }>("/api/security/operation-rules");
    drafts.value = r.rules.map(toDraft);
    saved.value = snapshot();
  } catch (e) {
    loadError.value = (e as Error).message;
  }
}
onMounted(() => {
  void load();
  void loadScopeChoices();
});

// ---- one line per rule
const asCmd = (d: Draft) => d.rule.match as Extract<Match, { kind: "command" }>;
const asHttp = (d: Draft) => d.rule.match as Extract<Match, { kind: "http" }>;
const asFile = (d: Draft) => d.rule.match as Extract<Match, { kind: "file" }>;
const asTool = (d: Draft) => d.rule.match as Extract<Match, { kind: "tool" }>;
const matchLine = (d: Draft) => matchText(clean(d).match);
const titleOf = (d: Draft) => d.rule.title?.trim() || matchLine(d);
const notEnforced = (d: Draft) => d.rule.match.kind === "http" || (d.loadedKind === d.rule.match.kind && d.enforcedBy?.length === 0);
const scopeOf = (d: Draft) => scopeText(d.rule.scope, backendOptions.value);
const label = (d: Draft) => `「${titleOf(d)}」`;

function toggle(d: Draft) {
  open.value = open.value === d.key ? null : d.key;
}
function setKind(d: Draft, k: Kind) {
  if (d.rule.match.kind === k) return;
  d.stash[d.rule.match.kind] = d.rule.match;
  d.rule.match = d.stash[k] ?? DEFAULTS[k]();
  if (k === "command") d.sub = (asCmd(d).subcommand ?? []).join(" ");
}
function setAction(d: Draft, a: Action) {
  d.rule.action = a;
  if (a === "approve" && !d.rule.approval) {
    d.rule.approval = { approver: "owner", waitSeconds: 90 };
    d.pick = "owner";
  }
}
function setWait(d: Draft, n: number) {
  d.rule.approval = { ...(d.rule.approval ?? {}), waitSeconds: n };
}
function addPair(list: JsonPattern[] | undefined, set: (l: JsonPattern[]) => void) {
  set([...(list ?? []), { jsonPath: "", regex: "" }]);
}
function setHttpBody(d: Draft, part: "field" | "regex", v: string) {
  const m = asHttp(d);
  const body = m.body ?? { jsonPath: "", regex: "" };
  m.body = part === "field" ? { ...body, jsonPath: jsonPathOf(v) } : { ...body, regex: v };
}

async function add() {
  if (!drafts.value) return;
  const d = toDraft({ id: `rule-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, revision: 1, enabled: true, match: DEFAULTS.command(), action: "approve", approval: { approver: "owner", waitSeconds: 90 } });
  d.loadedKind = undefined;
  drafts.value.push(d);
  open.value = d.key;
  await nextTick();
  document.getElementById(`rule-${d.key}-first`)?.focus();
}
async function move(i: number, dir: -1 | 1) {
  const list = drafts.value!;
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  // Keep the keyboard on the moved rule's button (it may be disabled now at the top or bottom).
  await nextTick();
  const k = list[j].key;
  const target = document.getElementById(`rule-${k}-${dir < 0 ? "up" : "down"}`) as HTMLButtonElement | null;
  (target && !target.disabled ? target : document.getElementById(`rule-${k}-${dir < 0 ? "down" : "up"}`))?.focus();
}
async function remove(d: Draft) {
  if (!(await confirmDialog("删除这条规则？", { message: `${titleOf(d)}：保存后，Agent 再做这类操作就不经过这条规则。`, okText: "删除", danger: true }))) return;
  drafts.value = drafts.value!.filter((x) => x !== d);
}
function discard() {
  void load();
  open.value = null;
}

/** What is missing before the server is asked, in the same place its own complaints go. */
function missing(d: Draft): string {
  const m = d.rule.match;
  if (m.kind === "command" && !m.executable.trim()) return "还没填命令名";
  if (m.kind === "http" && !m.host.trim()) return "还没填主机";
  if (m.kind === "file" && !m.operations.length) return "至少选一种文件操作";
  if (m.kind === "file" && !m.pathRegex.trim()) return "还没填路径正则";
  if (m.kind === "tool" && !m.name.trim()) return "还没选工具";
  if (d.rule.action === "approve" && d.pick === "lark" && !d.larkName.trim()) return "还没填飞书审批人";
  return "";
}
async function save() {
  const list = drafts.value;
  if (!list) return;
  for (const d of list) d.error = missing(d);
  const bad = list.find((d) => d.error);
  if (bad) {
    open.value = bad.key;
    return;
  }
  saving.value = true;
  try {
    const r = await put<{ rules: OperationRule[] }>("/api/security/operation-rules", { rules: list.map(clean) });
    const keys = new Map(list.map((d) => [d.rule.id, d.key]));
    drafts.value = r.rules.map((x) => ({ ...toDraft(x), key: keys.get(x.id) ?? ++seq }));
    saved.value = snapshot();
    toast("已保存，之后新启动的 Agent 进程按这些规则走", "ok");
  } catch (e) {
    const message = (e as Error).message;
    const rows = rowErrors(message);
    if (rows?.length) {
      for (const { index, text } of rows) if (list[index]) list[index].error = list[index].error ? `${list[index].error}；${text}` : text;
      open.value = list[rows[0].index]?.key ?? open.value;
    } else toast(message, "error");
  } finally {
    saving.value = false;
  }
}
function onPacksChanged() {
  void load();
}
</script>

<template>
  <div class="stack">
    <SetCard id="set-operation-rules" title="操作规则">
      <template #help>
        从上到下，第一条命中的规则生效；都没命中就放行。“放行”用来在更宽的规则前开个口子。命令规则能拦住 shell、脚本、Python 的 subprocess、Node 的 spawn 这类按名字找命令的调用；拦不住用绝对路径调用、Agent 自己改了 PATH、直接调命令背后的接口。它防的是误操作，不是有意绕开的 Agent：真正要保护的凭据不要放在 Agent 能读到的地方。保存后，之后新启动的 Agent 进程按新规则走。
        <template v-if="scopeChoices.platform === 'win32'">这台是 Windows：Node 不带 shell 的 execFile、Python 列表形式的 subprocess 只找 .exe，真正的命令是 .exe 时这两种拦不住。</template>
      </template>
      <template #aside><button class="btn ghost sm" :disabled="!drafts" @click="add"><Icon name="plus" :size="14" />规则</button></template>

      <p v-if="loadError" class="set-link" role="alert"><span class="grow">读不到操作规则：{{ loadError }}</span><button class="btn sm" @click="load">重试</button></p>
      <div v-else-if="!drafts" class="set-pad"><Skeleton variant="list" :rows="3" /></div>
      <p v-else-if="!drafts.length" class="set-link"><span class="grow muted">还没有规则：Agent 的命令、文件和工具调用都只按它自己后端的审批。</span><button class="btn sm" @click="add">新建一条</button></p>

      <div v-for="(d, i) in drafts ?? []" :key="d.key" class="op" :class="{ open: open === d.key, off: !d.rule.enabled }">
        <div class="op-row">
          <UiCheckbox v-model="d.rule.enabled" switch size="sm" :aria-label="`${label(d)}：${d.rule.enabled ? '开着' : '关着'}`" />
          <button type="button" class="op-main" :aria-expanded="open === d.key" :title="d.rule.title ? matchLine(d) : undefined" @click="toggle(d)">
            <span class="op-title">
              <span class="ellipsis" :class="{ mono: !d.rule.title?.trim() }">{{ titleOf(d) }}</span>
              <span class="badge" :title="ENFORCED[d.rule.match.kind]">{{ kindLabel(d.rule.match.kind) }}</span>
              <span v-if="d.rule.pack" class="badge pack" :title="`来自规则包「${d.rule.pack.name}」${d.rule.pack.version}`"><Icon name="box" :size="11" />{{ d.rule.pack.name }}</span>
            </span>
            <span class="op-meta" :title="scopeOf(d).full">{{ scopeOf(d).short }}</span>
          </button>
          <span class="op-end">
            <span v-if="notEnforced(d)" class="op-note" :title="ENFORCED.http">还没有执行点</span>
            <span class="op-act" :class="`act-${d.rule.action}`">{{ actionLabel(d.rule.action) }}</span>
          </span>
          <span class="op-tools">
            <button :id="`rule-${d.key}-up`" class="btn ghost sm icon move" :disabled="i === 0" :aria-label="`上移 ${label(d)}`" title="上移" @click="move(i, -1)"><Icon name="down" :size="14" class="up" /></button>
            <button :id="`rule-${d.key}-down`" class="btn ghost sm icon move" :disabled="i === drafts!.length - 1" :aria-label="`下移 ${label(d)}`" title="下移" @click="move(i, 1)"><Icon name="down" :size="14" /></button>
            <button class="btn ghost sm icon chev" :aria-label="open === d.key ? '收起' : '展开'" :aria-expanded="open === d.key" @click="toggle(d)"><Icon name="right" :size="14" /></button>
          </span>
        </div>
        <p v-if="d.error && open !== d.key" class="op-error" role="alert">{{ d.error }}</p>

        <div v-if="open === d.key" class="op-body">
          <template v-if="d.rule.pack">
            <p class="small muted">来自规则包「{{ d.rule.pack.name }}」{{ d.rule.pack.version }}：匹配什么、怎么处理由包决定，这里只改范围和开关；整包停用在下面的规则包里。</p>
            <div class="op-grid">
              <div class="field"><span>匹配</span><MonoLine :text="matchLine(d)" /></div>
              <div class="field"><span>处理</span><span class="op-act" :class="`act-${d.rule.action}`">{{ actionLabel(d.rule.action) }}</span></div>
            </div>
          </template>

          <template v-else>
            <div class="field">
              <span>匹配什么</span>
              <UiSegmented :model-value="d.rule.match.kind" size="sm" aria-label="匹配什么" :options="KINDS" @change="(k) => setKind(d, k)" />
            </div>

            <div v-if="d.rule.match.kind === 'command'" class="op-grid">
              <label class="field"><span>命令名</span><input :id="`rule-${d.key}-first`" v-model="asCmd(d).executable" class="input sm mono" placeholder="如 acme（不带路径）" spellcheck="false" /></label>
              <label class="field"><span>子命令（可选）</span><input v-model="d.sub" class="input sm mono" placeholder="如 mr create" spellcheck="false" /><span class="hint">按顺序比对开头的几个词，带 - 的选项不算</span></label>
              <label class="field wide"><span>整串参数的正则（可选）</span><input v-model="asCmd(d).argsRegex" class="input sm mono" placeholder="如 ^(deploy|delete)\b" spellcheck="false" /><span class="hint">参数用空格连起来比对，留空表示任何参数</span></label>
              <div class="field wide">
                <span>按位置的参数（可选）</span>
                <div v-for="(a, ai) in asCmd(d).argv ?? []" :key="ai" class="pair">
                  <span class="small muted">第</span>
                  <input class="input sm set-num" type="number" min="1" step="1" :aria-label="`参数位置 ${ai + 1}`" :value="a.index + 1" @change="a.index = Math.max(0, Math.round(Number(($event.target as HTMLInputElement).value) || 1) - 1)" />
                  <span class="small muted">个</span>
                  <input v-model="a.regex" class="input sm mono grow" placeholder="正则，如 ^prod$" spellcheck="false" :aria-label="`第 ${a.index + 1} 个参数的正则`" />
                  <button class="btn ghost sm icon" :aria-label="`去掉第 ${a.index + 1} 个参数的条件`" title="去掉" @click="asCmd(d).argv!.splice(ai, 1)"><Icon name="x" :size="14" /></button>
                </div>
                <div><button class="btn ghost sm" @click="asCmd(d).argv = [...(asCmd(d).argv ?? []), { index: 0, regex: '' }]"><Icon name="plus" :size="14" />按位置的参数</button></div>
              </div>
            </div>

            <template v-else-if="d.rule.match.kind === 'http'">
              <p class="op-pending small">这类规则先存着，还没有地方执行：出网代理和浏览器请求拦截做好之前，它不会拦任何请求。</p>
              <div class="op-grid">
                <label class="field"><span>主机</span><input :id="`rule-${d.key}-first`" v-model="asHttp(d).host" class="input sm mono" placeholder="如 api.example.com 或 *.example.com" spellcheck="false" /></label>
                <div class="field"><span>方法</span><UiSelect :model-value="asHttp(d).methods ?? []" multiple size="sm" placeholder="任何方法" aria-label="方法" :options="METHODS.map((v) => ({ value: v, label: v }))" @change="(v) => (asHttp(d).methods = v as string[])" /></div>
                <label class="field wide"><span>路径正则（可选）</span><input v-model="asHttp(d).pathRegex" class="input sm mono" placeholder="如 ^/v1/orders" spellcheck="false" /><span class="hint">只比对路径，不含主机和查询串</span></label>
                <label class="field"><span>请求体字段（可选）</span><input :value="fieldOf(asHttp(d).body?.jsonPath ?? '')" class="input sm mono" placeholder="如 status 或 items[0].id" spellcheck="false" @input="setHttpBody(d, 'field', ($event.target as HTMLInputElement).value)" /></label>
                <label class="field"><span>这个字段的正则</span><input :value="asHttp(d).body?.regex ?? ''" class="input sm mono" placeholder="如 ^cancel" spellcheck="false" @input="setHttpBody(d, 'regex', ($event.target as HTMLInputElement).value)" /></label>
              </div>
            </template>

            <div v-else-if="d.rule.match.kind === 'file'" class="op-grid">
              <div class="field">
                <span>操作</span>
                <span class="row wrap">
                  <UiCheckbox v-for="o in FILE_OPS" :key="o.value" v-model="asFile(d).operations" :value="o.value" size="sm">{{ o.label }}</UiCheckbox>
                </span>
              </div>
              <label class="field"><span>路径正则</span><input :id="`rule-${d.key}-first`" v-model="asFile(d).pathRegex" class="input sm mono" placeholder="如 ^/srv/secrets/" spellcheck="false" /><span class="hint">比对完整路径；只在 Agent 自己来请求许可时生效</span></label>
            </div>

            <div v-else class="op-grid">
              <div class="field"><span>工具</span><UiSelect :model-value="asTool(d).name" size="sm" placeholder="选一个 omem 工具" aria-label="工具" :options="toolOptions(asTool(d).name)" @change="(v) => (asTool(d).name = v as string)" /></div>
              <div class="field wide">
                <span>参数里的字段（可选）</span>
                <div v-for="(a, ai) in asTool(d).args ?? []" :key="ai" class="pair">
                  <input :value="fieldOf(a.jsonPath)" class="input sm mono" placeholder="字段，如 space" spellcheck="false" :aria-label="`字段 ${ai + 1}`" @input="a.jsonPath = jsonPathOf(($event.target as HTMLInputElement).value)" />
                  <input v-model="a.regex" class="input sm mono grow" placeholder="正则，如 ^personal$" spellcheck="false" :aria-label="`字段 ${ai + 1} 的正则`" />
                  <button class="btn ghost sm icon" :aria-label="`去掉字段 ${ai + 1}`" title="去掉" @click="asTool(d).args!.splice(ai, 1)"><Icon name="x" :size="14" /></button>
                </div>
                <div><button class="btn ghost sm" @click="addPair(asTool(d).args, (l) => (asTool(d).args = l))"><Icon name="plus" :size="14" />参数字段</button></div>
              </div>
            </div>

            <label class="field"><span>说明（可选，给审批人看）</span><input v-model="d.rule.title" class="input sm" :placeholder="`留空时显示：${matchLine(d)}`" /></label>

            <div class="field">
              <span>怎么处理</span>
              <UiSegmented :model-value="d.rule.action" size="sm" aria-label="怎么处理" :options="ACTIONS" @change="(a) => setAction(d, a)" />
            </div>
            <div v-if="d.rule.action === 'approve'" class="op-grid">
              <div class="field"><span>谁来批</span><UiSelect v-model="d.pick" size="sm" aria-label="谁来批" :options="pickOptions" /></div>
              <div class="field"><span>等多久</span><UiSelect :model-value="d.rule.approval?.waitSeconds ?? 90" size="sm" aria-label="等多久" :options="WAITS" @change="(n) => setWait(d, n as number)" /><span class="hint">没等到批准就先返回，批准后再唤醒 Agent 重做</span></div>
              <label v-if="d.pick === 'lark'" class="field wide"><span>飞书用户的名字或邮箱</span><input v-model="d.larkName" class="input sm" placeholder="如 小王 或 xiaowang@example.com" /></label>
              <template v-if="d.pick === 'run'">
                <div class="field"><span>可以被提名的人</span><UiSelect v-model="d.people" multiple size="sm" placeholder="选成员" aria-label="可以被提名的人" :options="scopeChoices.approvers" /></div>
                <label class="field"><span>名单里的飞书用户（可选）</span><input v-model="d.larkList" class="input sm" placeholder="如 小王，小李" /><span class="hint">不在名单里的提名改由你批</span></label>
              </template>
            </div>
          </template>

          <div class="field">
            <span>对谁生效</span>
            <OperationScope v-model="d.rule.scope" :backends="backendOptions" />
            <span class="hint">都不选就是所有人；选了几类时要同时满足</span>
          </div>

          <p v-if="d.error" class="op-error inline" role="alert">{{ d.error }}</p>
          <div class="op-foot">
            <button v-if="!d.rule.pack" class="btn ghost sm danger" @click="remove(d)"><Icon name="trash" :size="14" />删除</button>
            <span class="grow" />
            <button class="btn ghost sm" @click="open = null">收起</button>
          </div>
        </div>
      </div>

      <div v-if="dirty" class="op-save">
        <span class="grow small">改动还没保存</span>
        <button class="btn ghost sm" :disabled="saving" @click="discard">放弃</button>
        <button class="btn primary sm" :disabled="saving" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
      </div>
    </SetCard>

    <RulePacksSettings :backends="backendOptions" :blocked="dirty" @changed="onPacksChanged" />
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
  min-width: 0;
}
.op {
  border-top: 1px solid var(--line);
  min-width: 0;
}
.op-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 8px 18px;
  min-width: 0;
}
.op-main {
  display: grid;
  gap: 2px;
  min-width: 0;
  border: 0;
  background: none;
  padding: 4px 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: var(--ink);
}
.op-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
}
.op-title > .ellipsis {
  flex: 0 1 auto;
  min-width: 0;
}
.op-title > .mono {
  font-size: 13px;
}
.op-title > .badge {
  flex: none;
}
.badge.pack {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.op-meta {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A rule switched off: greyed (by colour, not opacity, which left stale layers after a row above collapsed). */
.op.off .op-title,
.op.off .op-act.op-act {
  color: var(--muted);
}
.op-end {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  min-width: 0;
}
.op-note {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  cursor: help;
}
.op-act {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  white-space: nowrap;
  color: var(--muted);
}
.op-act::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.op-act.act-deny {
  color: var(--danger);
}
.op-act.act-approve {
  color: var(--warn);
}
.op-act.act-allow {
  color: var(--ok);
}
.op-tools {
  display: flex;
  align-items: center;
  gap: 2px;
}
.op-tools .move {
  color: var(--muted);
}
/* Moving is the less common act: with a pointer the arrows show on the row being pointed at or
   worked with the keyboard; on touch they are always there. */
@media (hover: hover) {
  .op:not(.open):not(:hover):not(:focus-within) .move {
    visibility: hidden;
  }
}
.up {
  transform: rotate(180deg);
}
.chev {
  margin-left: 4px;
}
.chev :deep(svg) {
  transition: transform 0.15s ease;
}
.op.open .chev :deep(svg) {
  transform: rotate(90deg);
}
.op-error {
  margin: 0;
  padding: 0 18px 8px 62px;
  font-size: 13px;
  color: var(--danger);
  overflow-wrap: anywhere;
}
.op-error.inline {
  padding: 0;
}
.op-body {
  display: grid;
  gap: 16px;
  padding: 4px 18px 16px 62px;
  min-width: 0;
}
.op-body > p {
  margin: 0;
}
.op-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  min-width: 0;
}
.op-grid > .field,
.op-body > .field {
  min-width: 0;
  align-content: start;
}
.op-body :deep(.ui-seg) {
  justify-self: start;
  max-width: 100%;
}
.op-grid > .wide {
  grid-column: 1 / -1;
}
.op-pending {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--sunken);
  color: var(--ink-2);
}
.pair {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pair > .input {
  min-width: 0;
}
.pair > .input.mono:not(.grow) {
  flex: 0 1 180px;
}
.pair > .grow {
  flex: 1 1 auto;
}
.op-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.op-save {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-top: 1px solid var(--line);
  background: var(--panel);
  border-radius: 0 0 var(--radius) var(--radius);
  color: var(--ink-2);
}
@media (max-width: 640px) {
  /* Narrow: the title and its tags wrap, the way it is handled sits above the "no enforcement yet"
     note, and the arrows only show on the open rule. */
  .op-row {
    gap: 8px;
    padding: 8px 8px 8px 14px;
  }
  .op-title {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .op-title > .ellipsis {
    max-width: 100%;
  }
  .op-end {
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }
  .op:not(.open) .move {
    display: none;
  }
  .op-body,
  .op-error {
    padding-left: 14px;
    padding-right: 14px;
  }
  .op-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .op-save {
    padding: 10px 14px;
  }
}
</style>
