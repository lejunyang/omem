<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { get, post, put } from "../../api";
import { state, toast } from "../../store";
import { byChat, type ListenView } from "../../lib/listen";
import { intIn, useSettings } from "./ctx";
import HelpText from "../../components/HelpText.vue";
import LarkDocExclusions from "../../components/LarkDocExclusions.vue";
import LarkCapturedChats, { type CapturedChat } from "../../components/LarkCapturedChats.vue";
import ProviderApps from "../../components/ProviderApps.vue";
import SetCard from "../../components/SetCard.vue";
import SourceParsers from "../../components/SourceParsers.vue";
import SetRow from "../../components/SetRow.vue";
import Skeleton from "../../components/Skeleton.vue";
import UiCheckbox from "../../components/UiCheckbox.vue";
import UiSegmented from "../../components/UiSegmented.vue";
import UiSelect from "../../components/UiSelect.vue";

/**
 * 设置 → 知识 → 采集: where omem reads from — the owner's Feishu documents and messages (lark-cli's own
 * login, read-only) and the platforms members connect. 关注 is not set here: one line points to the work page.
 */
const { config, saveConfig } = useSettings();
/** The owner's own Feishu (lark-cli): someone else managing settings sees only the shared rows; their own documents are on their account page. */
const isOwner = computed(() => !state.me || state.me.role === "owner");
type Sub = "docs" | "capture" | "platforms";
const SUBS: { value: Sub; label: string }[] = [
  { value: "docs", label: "飞书文档" },
  { value: "capture", label: "消息采集" },
  { value: "platforms", label: "其他平台" },
];
const route = useRoute();
const fromCard: Record<string, Sub> = { "lark-docs": "docs", "lark-recent-docs": "docs", "lark-capture": "capture", platforms: "platforms", "source-parsers": "platforms" };
const sub = ref<Sub>(fromCard[String(route.query.card ?? "")] ?? (SUBS.some((s) => s.value === route.query.sub) ? (route.query.sub as Sub) : "docs"));

// 关注: only how many there are, and where they live now.
const listens = ref<ListenView[] | null>(null);
const activeListens = computed(() => (listens.value ?? []).filter((v) => v.status === "active").length);

type Policy = "ingest" | "involved" | "store" | "skip";
const larkChats = ref<{ chatId: string; name: string; mode: string; kind: string; muted: boolean; policy: Policy }[]>([]);
const captured = ref<CapturedChat[] | null>(null);
const showChats = ref(false);
/** Recent chats capture has not read: the rest are in the chat list below. */
const recentNew = computed(() => {
  const known = new Set((captured.value ?? []).map((c) => c.chatId));
  return larkChats.value.filter((c) => !known.has(c.chatId));
});
const policyOptions: { value: Policy; label: string; hint: string }[] = [
  { value: "ingest", label: "保存并整理", hint: "每批新消息都交给助理整理成记忆和事项" },
  { value: "involved", label: "与我有关时整理", hint: "保存；本人发言、被 @ 或参与的话题有新消息时才整理" },
  { value: "store", label: "只保存", hint: "可检索、可引用，不整理" },
  { value: "skip", label: "不读取", hint: "" },
];
const policyLabel = Object.fromEntries(policyOptions.map((o) => [o.value, o.label])) as Record<Policy, string>;
const chatKindLabel: Record<string, string> = { p2p: "单聊", bot: "机器人单聊", "own-bot": "omem 机器人", group: "群聊", topic: "话题群" };
const policyKinds: [string, string, string][] = [
  ["p2p", "单聊（人）", "和同事的一对一聊天"],
  ["bot", "机器人单聊", "通知、审批、工单助手等应用发来的消息"],
  ["group", "普通群", ""],
  ["topic", "话题群", "按话题回复的群"],
  ["muted", "免打扰的会话", "你设了免打扰的群和单聊，优先于上面的类型"],
];
async function loadCaptured() {
  captured.value = (await get<{ chats: CapturedChat[] }>("/api/lark/captured").catch(() => ({ chats: [] as CapturedChat[] }))).chats;
}
const listenByChat = computed(() => byChat(listens.value ?? []));
const subscribedCount = computed(() => (captured.value ?? []).filter((c) => c.subscribed).length);
/** One chat changed (subscription, space, policy): replace its row, drop it if it is no longer listed, add it if new. */
function capturedChanged(chatId: string, chat: CapturedChat | null) {
  const list = captured.value ?? [];
  const rest = list.filter((c) => c.chatId !== chatId);
  const at = list.findIndex((c) => c.chatId === chatId);
  if (!chat) captured.value = rest;
  else if (at < 0) captured.value = [chat, ...rest];
  else captured.value = list.map((c) => (c.chatId === chatId ? chat : c));
}
async function setChatPolicy(c: { chatId: string }, policy: Policy | "") {
  const r = await put<{ chat: CapturedChat | null }>(`/api/lark/chats/${encodeURIComponent(c.chatId)}/policy`, { policy: policy || null });
  toast(policy ? `已改为：${policyLabel[policy]}` : "已恢复默认", "ok");
  if (r.chat) capturedChanged(c.chatId, r.chat);
  if (larkChats.value.length) void loadLarkChats();
}
function setKindPolicy(kind: string, policy: Policy) {
  const capture = config.value.lark.capture;
  void saveConfig({ lark: { ...config.value.lark, capture: { ...capture, policies: { ...capture.policies, [kind]: policy } } } }, "已保存采集方式");
}
const larkError = ref("");
const loadingRecent = ref(false);
async function loadLarkChats() {
  larkError.value = "";
  loadingRecent.value = true;
  try {
    larkChats.value = (await get<{ chats: typeof larkChats.value }>("/api/lark/chats")).chats;
  } catch (e) {
    larkError.value = (e as Error).message;
  } finally {
    loadingRecent.value = false;
  }
}
/** Subscribe to a recent chat into the current space; it then shows in the chat list. */
async function subscribeRecent(c: { chatId: string; name: string }) {
  try {
    const r = await put<{ chat: CapturedChat | null }>(`/api/lark/chats/${encodeURIComponent(c.chatId)}/subscription`, { subscribed: true, name: c.name, spaceId: state.space });
    capturedChanged(c.chatId, r.chat);
    toast(`已订阅：${c.name}`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function pollNow() {
  try {
    await post("/api/lark/poll");
    toast("采集完成，新消息交给助理整理", "ok");
    void loadCaptured();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
function saveCapture(patch: Record<string, unknown>, note = "已保存") {
  void saveConfig({ lark: { ...config.value.lark, capture: { ...config.value.lark.capture, ...patch } } }, note);
}

type Crawl = { id: string; rootTitle?: string; root: string; status: "running" | "paused" | "done" | "stopped"; read: number; queued: number; failed: number; skipped: number; depth: number; maxDocs: number; batch: number | null; updatedAt: string; errors: string[] };
const crawls = ref<Crawl[]>([]);
const crawlLabel: Record<Crawl["status"], string> = { running: "进行中", paused: "已暂停", done: "已完成", stopped: "已停止" };
async function loadCrawls() {
  crawls.value = (await get<{ crawls: Crawl[] }>("/api/lark/wiki-crawls").catch(() => ({ crawls: [] }))).crawls.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function crawlOp(c: Crawl, op: "continue" | "stop") {
  await post(`/api/lark/wiki-crawls/${c.id}/${op}`, {});
  toast(op === "stop" ? "已停止" : "已继续", "ok");
  await loadCrawls();
}
const showAllCrawls = ref(false);
const shownCrawls = computed(() => (showAllCrawls.value ? crawls.value : crawls.value.filter((c) => c.status === "running" || c.status === "paused").concat(crawls.value.filter((c) => c.status !== "running" && c.status !== "paused")).slice(0, 5)));

type Need = { label: string; anyOf: string[] };
const perms = ref<{ user: { name: string | null } | null; unknown: boolean; missing: Need[] } | null>(null);
const permsLoading = ref(false);
const grantUrl = ref("");
async function checkPerms() {
  permsLoading.value = true;
  try {
    perms.value = await get("/api/lark/user-permissions");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    permsLoading.value = false;
  }
}
async function grantPerms() {
  try {
    const r = await post<{ url: string | null }>("/api/lark/user-permissions", {});
    grantUrl.value = r.url ?? "";
    toast(r.url ? "授权链接也发到了飞书私聊" : "没有缺的权限", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

onMounted(() => {
  void loadCaptured();
  void loadCrawls();
  void get<ListenView[]>("/api/listen").then((l) => (listens.value = l)).catch(() => (listens.value = []));
});
</script>

<template>
  <Skeleton v-if="!config" :rows="6" />
  <div v-else class="stack">
    <HelpText lead>omem 从哪些平台读内容：你本人的飞书（lark-cli 的个人登录，只读），以及成员各自连接的 Notion、GitHub、Google、钉钉等平台。机器人和聊天渠道在“渠道”里，谁能登录在“成员”里。</HelpText>
    <div class="card set-link">
      <span class="grow">关注：{{ listens === null ? "…" : activeListens ? `在关注 ${activeListens} 件事` : "还没有关注" }}。看着哪些群和事、怎么回，在工作页里看和改</span>
      <RouterLink to="/">去工作页看</RouterLink>
    </div>
    <UiSegmented v-model="sub" size="sm" aria-label="采集分类" :options="SUBS" />

    <template v-if="sub === 'docs'">
      <SetCard id="set-lark-docs" title="导入飞书文档">
        <template #help>读飞书文档时，它链接的文档和它在知识库里的子页面一起导入，层数从最先给的那篇算起（不是每篇子文档各算一遍）。整个知识库或很大的目录交给助理用“知识库爬取”分批读，进度存在库里，可以配合定时规则每天读一批。</template>
        <SetRow label="跟随层数" hint="0–5，0 = 只读这一篇">
          <input class="input set-num" type="number" inputmode="numeric" min="0" max="5" aria-label="跟随层数" :value="config.lark.capture.docLinkDepth ?? 2" @change="saveCapture({ docLinkDepth: intIn($event, 0, 5, 2) })" />
        </SetRow>
        <SetRow label="一次导入最多读多少篇">
          <input class="input set-num" type="number" inputmode="numeric" min="1" aria-label="一次导入最多读多少篇" :value="config.lark.capture.docMaxPerImport ?? 100" @change="saveCapture({ docMaxPerImport: intIn($event, 1, 100000, 100) })" />
        </SetRow>
        <SetRow label="每篇最多跟随的链接">
          <input class="input set-num" type="number" inputmode="numeric" min="0" aria-label="每篇最多跟随的链接" :value="config.lark.capture.docMaxLinked ?? 30" @change="saveCapture({ docMaxLinked: intIn($event, 0, 10000, 30) })" />
        </SetRow>
        <SetRow label="每个知识库页面最多读的子页面">
          <input class="input set-num" type="number" inputmode="numeric" min="0" aria-label="每个知识库页面最多读的子页面" :value="config.lark.capture.docWikiChildren ?? 50" @change="saveCapture({ docWikiChildren: intIn($event, 0, 10000, 50) })" />
        </SetRow>
        <SetRow label="知识库爬取默认最多读多少篇">
          <input class="input set-num" type="number" inputmode="numeric" min="1" aria-label="知识库爬取默认最多读多少篇" :value="config.lark.capture.wikiCrawlMaxDocs ?? 2000" @change="saveCapture({ wikiCrawlMaxDocs: intIn($event, 1, 100000, 2000) })" />
        </SetRow>
      </SetCard>

      <SetCard v-if="isOwner" id="set-lark-recent-docs" title="你最近打开的文档">
        <template #help>定时采集时读你最近打开过的飞书文档（文档、旧版文档和知识库页面），每篇读一次，之后由文档检查跟进改动；读的时候按上面的层数跟随它的链接。下面排除的文档和从别处链过去的都不再自动读；你让助理读的照常读。成员各自在账号页设置自己的。</template>
        <SetRow label="读最近打开的文档">
          <UiCheckbox :model-value="config.lark.capture.recentDocs" switch size="sm" aria-label="读最近打开的文档" @change="(v) => saveCapture({ recentDocs: v }, v ? '会读最近打开的文档' : '不再读最近打开的文档')" />
        </SetRow>
        <SetRow label="多少天内打开的" :off="!config.lark.capture.recentDocs">
          <input class="input set-num" type="number" inputmode="numeric" min="1" max="90" aria-label="多少天内打开的" :value="config.lark.capture.recentDocsDays ?? 7" @change="saveCapture({ recentDocsDays: intIn($event, 1, 90, 7) })" />
        </SetRow>
        <div class="set-pad"><LarkDocExclusions :disabled="!config.lark.capture.recentDocs" /></div>
      </SetCard>

      <SetCard v-if="crawls.length" title="知识库爬取">
        <template #aside><button class="btn ghost sm" @click="loadCrawls">刷新</button></template>
        <div v-for="c in shownCrawls" :key="c.id" class="crawl">
          <span class="crawl-name ellipsis" :title="c.rootTitle || c.root">{{ c.rootTitle || c.root }}</span>
          <span class="muted small crawl-meta">读了 {{ c.read }} · 待读 {{ c.queued }}{{ c.failed ? ` · 失败 ${c.failed}` : "" }} · {{ c.depth }} 层{{ c.batch ? ` · 每批 ${c.batch}` : "" }}</span>
          <span class="badge" :class="{ accent: c.status === 'running', warn: c.status === 'paused' }">{{ crawlLabel[c.status] }}</span>
          <span class="crawl-ops">
            <button v-if="c.status === 'paused'" class="btn ghost sm" @click="crawlOp(c, 'continue')">继续</button>
            <button v-if="c.status === 'running' || c.status === 'paused'" class="btn ghost sm" @click="crawlOp(c, 'stop')">停止</button>
          </span>
        </div>
        <div v-if="crawls.length > 5" class="set-pad"><button class="btn ghost sm" @click="showAllCrawls = !showAllCrawls">{{ showAllCrawls ? "只看最近的" : `全部 ${crawls.length} 个` }}</button></div>
      </SetCard>

      <SetCard v-if="isOwner" title="以你的身份写文档">
        <template #help>你让助理整理成文档时，它用 lark-cli 以你的身份新建、编辑和移动飞书文档。放在你的个人文档库或你自己的云空间文件夹里直接做；放进别人也在用的知识库、别人的文件夹或文档时，每次新建、编辑、覆盖和移动都会先把具体位置发给你批准。lark-cli 缺权限时会把授权链接发到你的飞书私聊。</template>
        <SetRow label="lark-cli 授权">
          <template #hint>
            <span v-if="perms?.unknown" class="warn-text">读不到登录信息：先在运行 omem 的电脑上运行 lark-cli auth login</span>
            <template v-else-if="perms?.user?.name">已登录：{{ perms.user.name }}{{ perms.missing.length ? `，缺 ${perms.missing.length} 项权限` : "，权限齐全" }}</template>
            <template v-else>点“检查”看登录和权限</template>
          </template>
          <button class="btn sm" :disabled="permsLoading" @click="checkPerms">{{ permsLoading ? "检查中…" : "检查" }}</button>
        </SetRow>
        <div v-if="perms && perms.missing.length" class="set-pad">
          <div v-for="m in perms.missing" :key="m.label" class="muted small">缺：{{ m.label }}（{{ m.anyOf.join(" 或 ") }}）</div>
          <div class="row wrap"><button class="btn sm primary" @click="grantPerms">去授权</button><a v-if="grantUrl" class="small" :href="grantUrl" target="_blank" rel="noopener">在飞书里打开授权链接</a></div>
        </div>
      </SetCard>
    </template>

    <template v-else-if="sub === 'capture'">
      <SetCard id="set-lark-capture" title="个人消息采集">
        <template #help>使用本机 lark-cli 的个人登录读取会话；除了你亲手发出的私聊指令和规则里的“拉机器人进群”，从不以你的身份发消息或操作；定时采集在“定时任务”里开。omem 机器人自己的私聊和它在群里发的消息不会被采集。</template>
        <template #aside><button class="btn ghost sm" @click="pollNow">立即采集</button></template>
        <SetRow label="采集范围" hint="任何范围下，群里 @你 的消息都会单独读取（不读的会话除外）">
          <UiSegmented
            :model-value="config.lark.capture.mode"
            size="sm"
            aria-label="采集范围"
            :options="[{ value: 'all', label: '所有有新消息的' }, { value: 'subscribed', label: '只读订阅的' }, { value: 'off', label: '关闭' }]"
            @change="(v) => saveConfig({ lark: { ...config.lark, capture: { ...config.lark.capture, mode: v } } }, '已保存采集范围')"
          />
        </SetRow>
        <div class="set-pad kinds-head small muted">按会话类型处理：订阅的会话按“保存并整理”，单个会话可以在下面单独设置，优先于类型</div>
        <SetRow v-for="[k, l, h] in policyKinds" :key="k" :label="l" :hint="h || undefined">
          <UiSelect :model-value="config.lark.capture.policies?.[k] ?? 'ingest'" size="sm" width="170px" :aria-label="`${l} 的处理方式`" :options="policyOptions" @change="(v) => setKindPolicy(k, v)" />
        </SetRow>
      </SetCard>

      <SetCard title="飞书会话">
        <template #aside><span class="muted small">{{ captured === null ? "…" : `${captured.length} 个 · 订阅 ${subscribedCount} 个` }}</span></template>
        <SetRow label="采集过的会话" hint="订阅、采集到哪个空间、怎么处理，逐个设置">
          <button class="btn ghost sm" :aria-expanded="showChats" :disabled="!captured?.length" @click="showChats = !showChats">{{ showChats ? "收起" : `展开 ${captured?.length ?? 0} 个会话` }}</button>
        </SetRow>
        <div v-if="showChats && captured?.length" class="set-pad chats">
          <LarkCapturedChats :chats="captured" :policy-options="policyOptions" :listens="listenByChat" @updated="capturedChanged" />
        </div>
        <SetRow label="最近会话里还没采集过的" hint="从飞书读最近的会话，挑出还没采集的，可以直接订阅">
          <button class="btn ghost sm" :disabled="loadingRecent" @click="loadLarkChats">{{ loadingRecent ? "读取中…" : "读取最近会话" }}</button>
        </SetRow>
        <div v-if="larkError" class="set-pad"><span class="badge danger">{{ larkError }}</span></div>
        <div v-if="larkChats.length" class="set-pad recent">
          <div v-if="!recentNew.length" class="muted small">最近的会话都在上面的列表里。</div>
          <div v-for="c in recentNew" :key="c.chatId" class="recent-row">
            <UiCheckbox :model-value="false" size="sm" :aria-label="`订阅 ${c.name}`" @change="subscribeRecent(c)" />
            <span class="grow ellipsis" :title="c.name">{{ c.name }}</span>
            <span class="badge">{{ chatKindLabel[c.kind] ?? c.kind }}</span>
            <span v-if="c.muted" class="badge warn">免打扰</span>
            <UiSelect :model-value="c.policy" size="sm" width="150px" aria-label="处理方式" :options="policyOptions" @change="(v) => setChatPolicy(c, v)" />
          </div>
        </div>
      </SetCard>
    </template>

    <template v-else>
      <div id="set-platforms"><ProviderApps /></div>
      <SourceParsers />
    </template>
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
  min-width: 0;
}
.warn-text {
  color: var(--warn);
}
.kinds-head {
  padding-bottom: 4px;
}
.kinds-head + :deep(.set-row) {
  border-top: 0;
}
.crawl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 12px;
  padding: 8px 18px;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.crawl-name {
  font-size: 14px;
  min-width: 0;
}
.crawl-ops {
  display: flex;
  gap: 4px;
}
.chats :deep(.lark-chats > .head .section-title) {
  display: none;
}
.recent {
  gap: 0;
}
.recent-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 0;
  min-width: 0;
}
.recent-row + .recent-row {
  border-top: 1px solid var(--line);
}
.recent-row > .grow {
  min-width: 140px;
}
@media (max-width: 640px) {
  .crawl {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 8px 14px;
  }
  .crawl-meta {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
