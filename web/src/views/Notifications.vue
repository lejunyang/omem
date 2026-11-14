<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import Markdown from "../components/Markdown.vue";
import { fmtTime, state, toast } from "../store";

/** `unread`: reached the person nowhere else (pushed to Feishu, kept quiet or in-app only are not); `pushed`: went out to Feishu. */
type N = { id: string; at: string; title: string; body: string; link: string | null; readAt: string | null; unread?: boolean; held?: boolean; bundleItems?: { id: string; title: string; link: string | null }[]; pushed?: { channel: string; at: string } | null; larkMessageId?: string; quiet?: string; ignoreRule?: { id: string; rule: string } | null };
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
async function readAll() {
  await post("/api/notifications/read", {});
  state.unread = 0;
  void load();
}
onMounted(async () => {
  await Promise.all([load(), state.me?.id === "owner" ? loadRules() : Promise.resolve()]);
});
</script>

<template>
  <div class="page" style="max-width: 760px">
    <div class="page-head">
      <div>
        <h1>通知</h1>
        <p>提醒、需要你决定的变化和后台任务结果。发到飞书的以飞书为准，这里只把没能发到飞书的标为未读。</p>
      </div>
      <span class="spacer" />
      <button class="btn sm" @click="readAll">全部标为已读</button>
    </div>
    <section v-if="state.me?.id === 'owner'" id="ignore-rules" class="card pad stack rules">
      <strong>忽略规则</strong>
      <p class="hint">助手从你的“忽略”和负面表情记下的规则。不合适的删掉，以后这类提醒就可以再发。</p>
      <p v-if="rulesError" role="alert">{{ rulesError }} <button class="btn sm" @click="loadRules">重试</button></p>
      <Skeleton v-else-if="rulesLoading" :rows="2" />
      <template v-else>
        <div v-for="rule in rules" :key="rule.id" class="row rule">
          <span>{{ rule.rule }}</span><button class="btn sm" :disabled="deleting.includes(rule.id)" :aria-label="`删除忽略规则：${rule.rule}`" @click="deleteRule(rule.id)">删除</button>
        </div>
        <p v-if="!rules.length" class="muted small">还没有忽略规则。</p>
      </template>
    </section>
    <Skeleton v-if="loading" variant="cards" :rows="4" />
    <div v-else-if="!list.length" class="empty"><Icon name="bell" :size="32" /><h3>没有通知</h3></div>
    <div v-for="n in list" :key="n.id" class="n" :class="{ unread: n.unread }">
      <div class="row head">
        <strong>{{ n.title }}</strong>
        <span class="spacer" />
        <span v-if="n.held" class="tag small">稍后一起发</span>
        <span v-else-if="n.pushed?.channel === 'bundle'" class="tag small">已并入汇总</span>
        <span v-else-if="inFeishu(n)" class="tag small" title="这条通知已经推到飞书">已发到飞书</span>
        <span v-else-if="n.quiet" class="tag small" :title="n.quiet">没有推送</span>
        <span class="muted small">{{ fmtTime(n.at) }}</span>
      </div>
      <ul v-if="n.bundleItems?.length"><li v-for="item in n.bundleItems" :key="item.id"><a v-if="item.link" :href="item.link">{{ item.title }}</a><span v-else>{{ item.title }}</span></li></ul>
      <Markdown v-else-if="n.body" :source="n.body" class="body" />
      <p v-if="n.ignoreRule" class="hint lesson">从这条提醒记下的忽略规则：{{ n.ignoreRule.rule }}</p>
      <a v-if="n.link" :href="n.link" class="small">查看详情 →</a>
    </div>
  </div>
</template>

<style scoped>
.rules { margin-bottom: 20px; }
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
.n.unread strong::before {
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
.body {
  font-size: 14px;
}
.head {
  gap: 8px;
  flex-wrap: wrap;
}
.head strong {
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
