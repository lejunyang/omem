<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import Markdown from "../components/Markdown.vue";
import HelpText from "../components/HelpText.vue";
import { fmtTime, state, toast } from "../store";

/** `unread`: reached the person nowhere else (pushed to Feishu, kept quiet or in-app only are not); `pushed`: went out to Feishu. */
type N = { behaviorChange?: string; id: string; at: string; title: string; body: string; link: string | null; readAt: string | null; unread?: boolean; held?: boolean; bundleItems?: { id: string; title: string; link: string | null }[]; pushed?: { channel: string; at: string } | null; larkMessageId?: string; quiet?: string; ignoreRule?: { id: string; rule: string } | null };
const inFeishu = (n: N) => !!(n.pushed || n.larkMessageId);
const list = ref<N[]>([]);
const loading = ref(true);
const rules = ref<{ id: string; rule: string }[]>([]);
const rulesLoading = ref(true);
const rulesError = ref("");
const deleting = ref<string[]>([]);
async function loadRules() {
  rulesError.value = "";
  rulesLoading.value = true;
  try { rules.value = (await get<{ rules: typeof rules.value }>("/api/notify-ignore-rules")).rules; }
  catch (e) { rulesError.value = (e as Error).message; }
  finally { rulesLoading.value = false; }
}
async function deleteRule(id: string) {
  deleting.value.push(id);
  try {
    await post("/api/notify-ignore-rules/delete", { id });
    rules.value = rules.value.filter((r) => r.id !== id);
    toast("已删除忽略规则", "ok");
  } catch (e) { toast((e as Error).message, "error"); }
  finally { deleting.value = deleting.value.filter((r) => r !== id); }
}
async function load() {
  try {
    list.value = (await get<{ notifications: N[] }>("/api/notifications")).notifications;
  } finally {
    loading.value = false;
  }
}
const acting = ref<string[]>([]);
async function settleChange(id: string, choice: number) {
  acting.value.push(id);
  try {
    const answer = await post<{ result?: string }>(`/api/asks/${id}/answer`, { choice });
    toast(answer.result || "已处理", "ok");
    await load();
  } catch (e) { toast((e as Error).message, "error"); }
  finally { acting.value = acting.value.filter((key) => key !== id); }
}
async function readAll() {
  await post("/api/notifications/read", {});
  state.unread = 0;
  void load();
}
/** A long body shows its first few lines; the rest on demand. */
const opened = ref<Record<string, boolean>>({});
const long = (n: N) => n.behaviorChange ? n.body.length > 650 || n.body.split("\n").length > 16 : n.body.length > 220 || n.body.split("\n").length > 4;
/** A page of this site written out as text (`#/wiki/…`) becomes a link named by its last part. */
function bodyOf(n: N) {
  return n.body.replace(/(^|[\s：])(#\/[^\s)）]+)/g, (_, pre: string, href: string) => {
    let name = href.split(/[/?]/).filter(Boolean).pop() ?? href;
    try { name = decodeURIComponent(name); } catch { /* keep it encoded */ }
    return `${pre}[${name}](${href})`;
  });
}
/**
 * A change an agent made (src/agents/behavior-changes.ts) comes as paragraphs, each file's before and after
 * as an indented block of “− 旧的一段” / “+ 新的一段”: those blocks read as a two-colour comparison with the
 * lines wrapped, the rest as text.
 */
type Part = { kind: "md"; text: string } | { kind: "diff"; lines: { sign: "del" | "add" | ""; text: string }[] };
function changeParts(body: string): Part[] {
  return body.split(/\n[ \t]*\n/).map((p): Part => {
    const lines = p.split("\n");
    if (!lines.every((l) => l.startsWith("    "))) return { kind: "md", text: p };
    return { kind: "diff", lines: lines.map((l) => l.slice(4)).map((l) => ({ sign: l.startsWith("− ") || l.startsWith("- ") ? "del" : l.startsWith("+ ") ? "add" : "", text: /^[−+-] /.test(l) ? l.slice(2) : l })) };
  });
}
onMounted(async () => {
  await Promise.all([load(), state.me?.id === "owner" ? loadRules() : Promise.resolve()]);
});
</script>

<template>
  <div class="page notifications">
    <div class="page-head">
      <div>
        <h1>通知</h1>
        <p>提醒、要你决定的事和后台任务的结果；发到飞书的以飞书为准。</p>
      </div>
      <span class="spacer" />
      <button class="btn sm" @click="readAll">全部标为已读</button>
    </div>
    <details v-if="state.me?.id === 'owner'" id="ignore-rules" class="rules">
      <summary class="small">忽略规则<span class="muted"> · {{ rulesLoading ? "…" : rules.length ? `${rules.length} 条` : "还没有" }}</span></summary>
      <HelpText>助手从你的“忽略”和负面表情记下的规则。不合适的删掉，以后这类提醒就可以再发。</HelpText>
      <p v-if="rulesError" role="alert">{{ rulesError }} <button class="btn sm" @click="loadRules">重试</button></p>
      <Skeleton v-else-if="rulesLoading" :rows="2" />
      <template v-else>
        <div v-for="rule in rules" :key="rule.id" class="row rule">
          <span>{{ rule.rule }}</span><button class="btn sm" :disabled="deleting.includes(rule.id)" :aria-label="`删除忽略规则：${rule.rule}`" @click="deleteRule(rule.id)">删除</button>
        </div>
        <p v-if="!rules.length" class="muted small">还没有忽略规则。</p>
      </template>
    </details>
    <Skeleton v-if="loading" variant="cards" :rows="4" />
    <div v-else-if="!list.length" class="empty"><Icon name="bell" :size="32" /><h3>没有通知</h3></div>
    <div v-for="n in list" :key="n.id" class="n" :class="{ unread: n.unread }">
      <div class="row head">
        <a v-if="n.link" :href="n.link" class="ttl">{{ n.title }}</a>
        <strong v-else class="ttl">{{ n.title }}</strong>
        <span class="spacer" />
        <span v-if="n.held" class="tag small">稍后一起发</span>
        <span v-else-if="n.pushed?.channel === 'bundle'" class="tag small">已并入汇总</span>
        <span v-else-if="inFeishu(n)" class="tag small" title="这条通知已经推到飞书">已发到飞书</span>
        <span v-else-if="n.quiet" class="tag small" :title="n.quiet">没有推送</span>
        <span class="muted small">{{ fmtTime(n.at) }}</span>
      </div>
      <ul v-if="n.bundleItems?.length"><li v-for="item in n.bundleItems" :key="item.id"><a v-if="item.link" :href="item.link">{{ item.title }}</a><span v-else>{{ item.title }}</span></li></ul>
      <template v-else-if="n.body">
        <div v-if="n.behaviorChange" class="body change" :class="{ clip: long(n) && !opened[n.id] }">
          <template v-for="(p, i) in changeParts(n.body)" :key="i">
            <Markdown v-if="p.kind === 'md'" :source="bodyOf({ ...n, body: p.text })" compact />
            <div v-else class="diff" role="group" aria-label="改动前后">
              <div v-for="(l, j) in p.lines" :key="j" class="dl" :class="l.sign"><span class="sign" aria-hidden="true">{{ l.sign === "del" ? "−" : l.sign === "add" ? "+" : "" }}</span><span class="sr">{{ l.sign === "del" ? "删去：" : l.sign === "add" ? "加上：" : "" }}</span><span class="txt">{{ l.text }}</span></div>
            </div>
          </template>
        </div>
        <div v-else class="body" :class="{ clip: long(n) && !opened[n.id] }"><Markdown :source="bodyOf(n)" compact /></div>
        <button v-if="long(n)" type="button" class="lnk small" :aria-expanded="!!opened[n.id]" @click="opened[n.id] = !opened[n.id]">{{ opened[n.id] ? "收起" : "展开全文" }}</button>
      </template>
      <div v-if="n.behaviorChange" class="row">
        <button class="btn sm" :disabled="acting.includes(n.behaviorChange)" @click="settleChange(n.behaviorChange, 0)">保留</button>
        <button class="btn sm" :disabled="acting.includes(n.behaviorChange)" @click="settleChange(n.behaviorChange, 1)">撤回</button>
      </div>
      <p v-if="n.ignoreRule" class="hint lesson">从这条提醒记下的忽略规则：{{ n.ignoreRule.rule }}</p>
    </div>
  </div>
</template>

<style scoped>
.rules { margin-bottom: 16px; display: grid; gap: 8px; }
.rules summary { cursor: pointer; width: fit-content; color: var(--ink-2); }
.rules[open] { padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.notifications { max-width: 760px; }
.rule { align-items: flex-start; }
.rule span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rule button { flex: none; }
.lesson { overflow-wrap: anywhere; }
.n {
  border-top: 1px solid var(--line);
  padding: 14px 0;
  display: grid;
  gap: 6px;
}
.n.unread .ttl::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  margin-right: 8px;
  vertical-align: middle;
}
.n li { overflow-wrap: anywhere; }
.body { min-width: 0; overflow-wrap: anywhere; }
.body.change { display: grid; gap: 8px; }
.diff { display: grid; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; font-size: 13px; line-height: 1.55; }
.dl { display: grid; grid-template-columns: 18px minmax(0, 1fr); padding: 3px 10px 3px 4px; }
.dl + .dl { border-top: 1px solid var(--line); }
.dl.del { background: color-mix(in srgb, var(--danger) 7%, transparent); }
.dl.add { background: color-mix(in srgb, var(--ok) 8%, transparent); }
.dl .sign { text-align: center; font-family: var(--mono); color: var(--muted); }
.dl.del .sign { color: var(--danger); }
.dl.add .sign { color: var(--ok); }
.dl:not(.del):not(.add) .txt { color: var(--muted); }
.txt { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.body.clip {
  max-height: 7.2em;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 60%, transparent);
  mask-image: linear-gradient(#000 60%, transparent);
}
.lnk { justify-self: start; border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
.lnk:hover { text-decoration: underline; }
.ttl { font-weight: 600; color: var(--ink); }
.head {
  gap: 8px;
  flex-wrap: wrap;
}
.head .ttl {
  min-width: 0;
  overflow-wrap: anywhere;
}
.tag {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0 8px;
  color: var(--muted);
  white-space: nowrap;
}
</style>
