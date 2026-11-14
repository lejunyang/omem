<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { del, get, patch, post } from "../api";
import { confirmDialog } from "../lib/dialog";
import { state, toast } from "../store";
import HelpText from "./HelpText.vue";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * Assistants (src/agents/assistants.ts): the main one and the Feishu bots bound to this omem, each
 * someone's. `own`: the account page — only the viewer's, with “新建助手”; otherwise everyone's (the
 * owner manages all, a member their own).
 */
const props = defineProps<{ own?: boolean }>();
type Assistant = { id: string; name: string; description: string; userId: string; userName: string; agent: string; enabled: boolean; appId: string | null; connected: boolean; dailyRuns: number | null; todayRuns: number; ownerOpenId: string | null; mine: boolean; manage: boolean };
const list = ref<Assistant[]>([]);
const larkEnabled = ref(true);
const specs = ref<{ name: string; description?: string }[]>([]);
const loaded = ref(false);
const isOwner = computed(() => state.me?.role === "owner" || !state.me);
const shown = computed(() => (props.own ? list.value.filter((a) => a.mine) : list.value));

async function load() {
  try {
    const r = await get<{ assistants: Assistant[]; larkEnabled: boolean }>("/api/assistants");
    list.value = r.assistants;
    larkEnabled.value = r.larkEnabled;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    loaded.value = true;
  }
}
onMounted(() => {
  void load();
  void get<{ name: string; description?: string }[]>("/api/agents").then((s) => (specs.value = s)).catch(() => {});
});
const agentOptions = (current: string) => {
  const o = [{ value: "assistant", label: "主助手角色（独立会话）" }, ...specs.value.map((s) => ({ value: s.name, label: s.name, hint: s.description }))];
  return o.some((x) => x.value === current) ? o : [...o, { value: current, label: current, hint: "档案不存在" }];
};

async function save(a: Assistant, body: Record<string, unknown>, done = "已保存") {
  try {
    await patch(`/api/assistants/${encodeURIComponent(a.id)}`, body);
    toast(done, "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function remove(a: Assistant) {
  if (!(await confirmDialog(`移除助手「${a.name}」？`, { message: "它的会话和运行记录都留着；飞书里的机器人应用不会被删除，重启 omem 后它不再回答。", okText: "移除", danger: true }))) return;
  try {
    await del(`/api/assistants/${encodeURIComponent(a.id)}`);
    toast("已移除，重启后机器人不再回答", "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
function setLimit(a: Assistant, raw: string) {
  const n = raw.trim() ? Math.max(1, Math.round(Number(raw) || 0)) : null;
  void save(a, { dailyRuns: n }, n ? `每天最多 ${n} 次` : "不限次数");
}

// A new assistant: a bot app made by scanning in Feishu, or one that exists (App ID + Secret).
const adding = ref(false);
const busy = ref(false);
const form = reactive({ how: "scan" as "scan" | "app", name: "", description: "", agent: "assistant", appId: "", appSecret: "" });
const scan = ref<{ url: string; expiresInMinutes: number } | null>(null);
let poll: ReturnType<typeof setInterval> | null = null;
function reset() {
  adding.value = false;
  scan.value = null;
  if (poll) clearInterval(poll);
  poll = null;
  Object.assign(form, { how: "scan", name: "", description: "", agent: "assistant", appId: "", appSecret: "" });
}
async function create() {
  busy.value = true;
  try {
    if (form.how === "app") {
      await post("/api/assistants", { name: form.name || undefined, description: form.description || undefined, agent: form.agent, appId: form.appId.trim(), appSecret: form.appSecret.trim() });
      toast("助手已建好，机器人正在连接", "ok");
      reset();
      await load();
      return;
    }
    const r = await post<{ url?: string; expiresInMinutes?: number; error?: string }>("/api/assistants/scan", { name: form.name || undefined, description: form.description || undefined, agent: form.agent });
    if (r.error || !r.url) throw new Error(r.error ?? "飞书没有给出链接");
    scan.value = { url: r.url, expiresInMinutes: r.expiresInMinutes ?? 10 };
    // The app appears in the list once the person has confirmed in Feishu.
    const before = list.value.length;
    poll = setInterval(async () => {
      await load();
      if (list.value.length > before) {
        toast("助手已建好", "ok");
        reset();
      }
    }, 4000);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card pad stack">
    <div class="row wrap">
      <strong>{{ own ? "我的助手" : "助手" }}</strong><span class="spacer" />
      <button v-if="!adding" class="btn sm" :disabled="!larkEnabled" :title="larkEnabled ? '' : '这台 omem 还没有启用飞书机器人'" @click="adding = true"><Icon name="plus" :size="13" />新建助手</button>
    </div>
    <HelpText>每个助手是一个飞书机器人，属于建它的人：以这个人的身份回答，读他能读的空间，有自己的会话；由一个 Agent 档案（或主助手角色）回答。几个助手在同一个群里时互相知道对方是谁、做什么，可以 @ 对方转交。成员在 账号 → 我的助手 里建自己的；这台 omem 的主人能看到全部，可以给每个助手设每天的次数。</HelpText>
    <p v-if="loaded && !shown.length" class="muted small">{{ own ? "你还没有助手。" : "还没有助手。" }}</p>
    <div v-for="a in shown" :key="a.id" class="as-row">
      <div class="row wrap">
        <strong>{{ a.name }}</strong>
        <span v-if="!own && a.userId !== 'owner'" class="badge">{{ a.userName }}的</span>
        <span v-if="a.id === 'main'" class="badge accent">主助手</span>
        <span class="badge" :class="a.connected ? 'ok' : a.enabled ? 'warn' : ''">{{ a.connected ? "已连接" : a.enabled ? "未连接" : "已停用" }}</span>
        <span class="muted small">今天 {{ a.todayRuns }} 次<template v-if="a.dailyRuns"> / {{ a.dailyRuns }}</template></span>
        <span class="spacer" />
        <template v-if="a.manage">
          <UiCheckbox :model-value="a.enabled" switch size="sm" @change="(v) => save(a, { enabled: v }, v ? '已启用' : '已停用，重启后不再回答')">启用</UiCheckbox>
          <button class="btn ghost sm danger" @click="remove(a)">移除</button>
        </template>
      </div>
      <template v-if="a.manage">
        <label class="field"><span>做什么（别的助手和别的设备靠这句话知道找它做什么）</span><input class="input" :value="a.description" maxlength="200" placeholder="例如：值班排查——查报警、日志和发布记录" @change="save(a, { description: ($event.target as HTMLInputElement).value })" /></label>
        <div class="row wrap gap">
          <div class="field grow"><span>回答者</span><UiSelect :model-value="a.agent" width="100%" aria-label="回答者" :options="agentOptions(a.agent)" @change="(v) => save(a, { agent: v })" /></div>
          <label v-if="isOwner" class="field limit"><span>每天最多（空着不限）</span><input class="input sm" type="number" inputmode="numeric" min="1" :value="a.dailyRuns ?? ''" placeholder="不限" @change="setLimit(a, ($event.target as HTMLInputElement).value)" /></label>
        </div>
        <label class="field"><span>建它的人在这个应用里的 open_id（每个应用不同，扫码创建时自动填；它靠这个认出主人）<span v-if="a.appId" class="muted mono"> · {{ a.appId }}</span></span><input class="input mono" :value="a.ownerOpenId ?? ''" placeholder="不知道可先私聊这个机器人一句，再看运行日志" @change="save(a, { ownerOpenId: ($event.target as HTMLInputElement).value })" /></label>
      </template>
      <p v-else class="muted small">{{ a.description || "（没有说明）" }}</p>
    </div>

    <div v-if="adding" class="as-new stack">
      <UiSegmented v-model="form.how" size="sm" aria-label="怎么绑定机器人" :options="[{ value: 'scan', label: '用飞书创建机器人' }, { value: 'app', label: '已有飞书应用' }]" />
      <template v-if="scan">
        <p class="small">在飞书里打开这个链接并确认（{{ scan.expiresInMinutes }} 分钟内有效），确认后这里会出现新助手：</p>
        <a class="mono small link" :href="scan.url" target="_blank" rel="noopener noreferrer">{{ scan.url }}</a>
        <div class="row"><span class="muted small">等你在飞书里确认…</span><span class="spacer" /><button class="btn ghost sm" @click="reset">取消</button></div>
      </template>
      <template v-else>
        <div class="row wrap gap">
          <label class="field grow"><span>名字{{ form.how === "scan" ? "（也是机器人的名字）" : "（空着用机器人的名字）" }}</span><input v-model="form.name" class="input" maxlength="40" placeholder="例如：值班助手" /></label>
          <div class="field grow"><span>回答者</span><UiSelect v-model="form.agent" width="100%" aria-label="回答者" :options="agentOptions(form.agent)" /></div>
        </div>
        <label class="field"><span>做什么</span><input v-model="form.description" class="input" maxlength="200" placeholder="一句话：它负责什么、适合找它做什么" /></label>
        <div v-if="form.how === 'app'" class="row wrap gap">
          <label class="field grow"><span>App ID</span><input v-model="form.appId" class="input mono" placeholder="cli_…" /></label>
          <label class="field grow"><span>App Secret（只存在这台 omem 的密钥文件里）</span><input v-model="form.appSecret" class="input mono" type="password" autocomplete="off" /></label>
        </div>
        <p v-else class="muted small">点“下一步”后给你一个飞书链接：在飞书里确认，就按 omem 需要的权限和事件建好机器人应用并绑定到这个助手，不用去开发者后台。</p>
        <div class="row"><span class="spacer" /><button class="btn ghost sm" @click="reset">取消</button><button class="btn primary sm" :disabled="busy || (form.how === 'app' && (!form.appId.trim() || !form.appSecret.trim()))" @click="create">{{ form.how === "scan" ? "下一步" : "绑定" }}</button></div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.as-row {
  display: grid;
  gap: 8px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.as-new {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--sunken);
}
.limit {
  width: 150px;
}
.link {
  overflow-wrap: anywhere;
}
.gap {
  gap: 12px;
}
</style>
