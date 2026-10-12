<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, patch, post, put, type Space } from "../api";
import Icon from "../components/Icon.vue";
import { fmtTime, kindLabel, loadSpaces, state, toast } from "../store";

type Profile = { id: string; name?: string; transport: string; command: string; args: string[]; model?: string; effort?: string; installed: boolean };
type Schedule = { id: string; kind: string; cron: string; enabled: boolean; lastRunAt: string | null };
const tab = ref<"spaces" | "agents" | "schedules" | "search" | "lark" | "about">("spaces");
const config = ref<any>(null);
const profiles = ref<Profile[]>([]);
const home = ref("");
const schedules = ref<Schedule[]>([]);
const next = ref<Record<string, string | null>>({});
const labels = ref<Record<string, string>>({});
const newSpace = ref({ name: "", kind: "project", rootPath: "", description: "" });
const editing = ref<Space | null>(null);
const guide = ref("");
const profileJson = ref("");
const larkChats = ref<{ chatId: string; name: string; mode: string }[]>([]);
const larkSubs = ref<{ chatId: string; name: string; spaceId: string; since?: string }[]>([]);
const larkError = ref("");
async function loadLark() {
  larkSubs.value = (await get<{ subscriptions: typeof larkSubs.value }>("/api/lark/subscriptions")).subscriptions;
}
async function loadLarkChats() {
  larkError.value = "";
  try {
    larkChats.value = (await get<{ chats: typeof larkChats.value }>("/api/lark/chats")).chats;
  } catch (e) {
    larkError.value = (e as Error).message;
  }
}
function subOf(chatId: string) {
  return larkSubs.value.find((s) => s.chatId === chatId);
}
async function toggleSub(c: { chatId: string; name: string }, spaceId?: string) {
  const exists = subOf(c.chatId);
  const next = exists && !spaceId ? larkSubs.value.filter((s) => s.chatId !== c.chatId) : [...larkSubs.value.filter((s) => s.chatId !== c.chatId), { chatId: c.chatId, name: c.name, spaceId: spaceId ?? state.space }];
  larkSubs.value = (await put<{ subscriptions: typeof larkSubs.value }>("/api/lark/subscriptions", { subscriptions: next })).subscriptions;
}
async function pollNow() {
  try {
    await post("/api/lark/poll");
    toast("采集完成，新消息交给助理整理", "ok");
    void loadLark();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

const roles = [
  ["assistant", "日常助理（问答、记忆、事项）"],
  ["ingest", "整理新材料"],
  ["wiki-planner", "规划 Wiki"],
  ["wiki-writer", "写 Wiki 页面"],
  ["wiki-linter", "检查受影响页面"],
  ["heartbeat", "巡检"],
  ["dreamer", "整理记忆"],
  ["coder", "编码"],
  ["reviewer", "评审"],
  ["tutor", "生成卡片"],
  ["brief", "简报"],
];

async function load() {
  const s = await get<{ config: any; agents: Profile[]; home: string }>("/api/settings");
  config.value = s.config;
  profiles.value = s.agents;
  home.value = s.home;
  const sc = await get<{ schedules: Schedule[]; next: Record<string, string | null>; labels: Record<string, string> }>("/api/schedules");
  schedules.value = sc.schedules;
  next.value = sc.next;
  labels.value = sc.labels;
}
onMounted(() => {
  void load();
  void loadLark();
});

async function saveConfig(partial: Record<string, unknown>, note = "已保存") {
  try {
    const r = await put<{ config: any }>("/api/settings", partial);
    config.value = r.config;
    toast(`${note}（部分设置需重启服务生效）`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function createSpace() {
  try {
    await post("/api/spaces", { name: newSpace.value.name, kind: newSpace.value.kind, rootPath: newSpace.value.rootPath || undefined, description: newSpace.value.description });
    toast(newSpace.value.rootPath ? "已创建，正在导入目录" : "已创建空间", "ok");
    newSpace.value = { name: "", kind: "project", rootPath: "", description: "" };
    await loadSpaces();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function openSpace(s: Space) {
  editing.value = { ...s, settings: { ...s.settings } };
  guide.value = (await get<{ guide: string }>(`/api/spaces/${s.id}`)).guide;
}
async function saveSpace() {
  if (!editing.value) return;
  await patch(`/api/spaces/${editing.value.id}`, { name: editing.value.name, description: editing.value.description, settings: editing.value.settings, guide: guide.value });
  toast("空间已保存", "ok");
  editing.value = null;
  await loadSpaces();
}
async function toggleSchedule(s: Schedule) {
  await put(`/api/schedules/${s.id}`, { enabled: !s.enabled });
  void load();
}
async function saveCron(s: Schedule, cron: string) {
  try {
    await put(`/api/schedules/${s.id}`, { cron });
    toast("已更新", "ok");
    void load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function runNow(s: Schedule) {
  await post(`/api/schedules/${s.id}/run`);
  toast("已触发", "ok", "#/runs");
}
const defaultProfile = computed({
  get: () => config.value?.agents.default ?? "",
  set: (v: string) => saveConfig({ agents: { ...config.value.agents, default: v || undefined } }),
});
function setRole(role: string, id: string) {
  const roles = { ...config.value.agents.roles };
  if (id) roles[role] = id;
  else delete roles[role];
  void saveConfig({ agents: { ...config.value.agents, roles } });
}
async function addProfile() {
  try {
    const p = JSON.parse(profileJson.value);
    const list = [...config.value.agents.profiles.filter((x: Profile) => x.id !== p.id), p];
    await saveConfig({ agents: { ...config.value.agents, profiles: list } }, "已保存 Agent 配置");
    profileJson.value = "";
    void load();
  } catch (e) {
    toast(`配置不是合法 JSON：${(e as Error).message}`, "error");
  }
}
function editProfile(p: Profile) {
  const { installed, ...rest } = p;
  profileJson.value = JSON.stringify(rest, null, 2);
}
</script>

<template>
  <div class="page">
    <div class="page-head"><div><h1>设置</h1><p v-if="home" class="mono small">数据目录：{{ home }}</p></div></div>
    <div class="tabs">
      <button v-for="[k, l] in [['spaces', '空间'], ['agents', 'Agent'], ['schedules', '定时任务'], ['search', '检索'], ['lark', '渠道'], ['about', '外观与说明']]" :key="k" :class="{ on: tab === k }" @click="tab = k as any">{{ l }}</button>
    </div>

    <section v-if="tab === 'spaces'" class="stack">
      <p class="muted">空间把不同领域的知识分开：每个空间有自己的原件、Wiki、记忆和事项。助理默认只在当前空间调查，需要时才跨空间。代码仓库空间关联一个本地目录，可定期同步。</p>
      <div class="spaces">
        <div v-for="s in state.spaces" :key="s.id" class="card pad sp">
          <div class="row"><strong>{{ s.name }}</strong><span class="badge">{{ kindLabel[s.kind] ?? s.kind }}</span><span class="spacer" /><button class="btn ghost sm" @click="openSpace(s)"><Icon name="edit" :size="14" />设置</button></div>
          <div class="muted small">{{ s.description || "（没有说明）" }}</div>
          <div class="muted small mono" v-if="s.rootPath">{{ s.rootPath }}</div>
          <div class="muted small">{{ s.sources ?? 0 }} 份原件 · {{ s.pages ?? 0 }} 个页面</div>
        </div>
      </div>
      <form class="card pad stack" @submit.prevent="createSpace">
        <strong>新建空间</strong>
        <div class="grid2">
          <label class="field"><span>名称</span><input v-model="newSpace.name" class="input" required placeholder="例如：项目A、英语学习、omem 仓库" /></label>
          <label class="field"><span>类型</span><select v-model="newSpace.kind" class="select"><option value="project">项目</option><option value="repo">代码仓库</option><option value="learning">学习</option><option value="topic">主题</option></select></label>
        </div>
        <label class="field"><span>关联目录（代码仓库或文档目录，可选）</span><input v-model="newSpace.rootPath" class="input mono" placeholder="E:\Projects\omem 或 /home/me/code/app" /><span class="hint">填写后会导入目录下的文本文件（遵守 .gitignore），之后可同步更新。</span></label>
        <label class="field"><span>说明</span><input v-model="newSpace.description" class="input" placeholder="这个空间收什么、给谁读" /></label>
        <div class="row"><span class="spacer" /><button class="btn primary" :disabled="!newSpace.name">创建</button></div>
      </form>
    </section>

    <section v-else-if="tab === 'agents' && config" class="stack">
      <p class="muted">omem 不内置模型：理解、写作和编码交给你已安装并登录的 Agent（通过 ACP 或命令行）。不同角色可以用不同 Agent，例如问答用快的模型，Wiki 和评审用强的模型。</p>
      <div class="card">
        <div v-for="p in profiles" :key="p.id" class="prow">
          <span class="badge" :class="p.installed ? 'ok' : ''">{{ p.installed ? "已安装" : "未找到" }}</span>
          <div class="grow">
            <div><strong>{{ p.name ?? p.id }}</strong> <span class="muted small mono">{{ p.id }}</span></div>
            <div class="muted small mono">{{ p.transport }} · {{ p.command }} {{ p.args.join(" ") }}<template v-if="p.model"> · {{ p.model }}</template><template v-if="p.effort"> · {{ p.effort }}</template></div>
          </div>
          <button class="btn ghost sm" @click="editProfile(p)">编辑</button>
        </div>
      </div>
      <label class="field"><span>默认 Agent</span>
        <select v-model="defaultProfile" class="select"><option value="">自动（第一个已安装的）</option><option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option></select>
      </label>
      <div class="card pad">
        <div class="section-title">按角色指定</div>
        <div class="roles">
          <label v-for="[r, l] in roles" :key="r" class="row role"><span class="grow">{{ l }}</span>
            <select class="select" :value="config.agents.roles[r] ?? ''" @change="setRole(r, ($event.target as HTMLSelectElement).value)"><option value="">默认</option><option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option></select>
          </label>
        </div>
      </div>
      <div class="card pad stack">
        <div class="section-title">添加或修改 Agent 配置</div>
        <textarea v-model="profileJson" class="textarea mono" rows="9" placeholder='{"id":"codex-sol","name":"Codex · Sol","transport":"acp","command":"codex-acp","args":[],"model":"gpt-6.1-sol","effort":"low"}' />
        <div class="row"><span class="muted small">transport：acp / claude-cli / codex-cli。model、effort 必须是该 Agent 支持的值。</span><span class="spacer" /><button class="btn primary sm" :disabled="!profileJson.trim()" @click="addProfile">保存</button></div>
      </div>
    </section>

    <section v-else-if="tab === 'schedules'" class="stack">
      <p class="muted">后台任务按 cron 运行（时区：{{ config?.timezone }}）。巡检只在到期提醒或关注对象有新材料时才调用 Agent。</p>
      <div v-for="s in schedules" :key="s.id" class="card pad sched">
        <div class="row wrap">
          <label class="row"><input type="checkbox" :checked="s.enabled" @change="toggleSchedule(s)" /><strong>{{ labels[s.kind] ?? s.kind }}</strong></label>
          <span class="spacer" />
          <input class="input mono cron" :value="s.cron" @change="saveCron(s, ($event.target as HTMLInputElement).value)" />
          <button class="btn sm" @click="runNow(s)"><Icon name="play" :size="13" />立即运行</button>
        </div>
        <div class="muted small">上次：{{ s.lastRunAt ? fmtTime(s.lastRunAt) : "从未" }}<template v-if="next[s.id]"> · 下次：{{ fmtTime(next[s.id]) }}</template></div>
      </div>
    </section>

    <section v-else-if="tab === 'search' && config" class="stack">
      <p class="muted">全文检索始终可用（中文按双字切分，代码按标识符切分）。开启向量检索可改善换说法的提问，向量在后台逐步生成。</p>
      <label class="field"><span>向量检索</span>
        <select class="select" :value="config.embeddings.provider" @change="saveConfig({ embeddings: { ...config.embeddings, provider: ($event.target as HTMLSelectElement).value } })">
          <option value="none">关闭</option><option value="local">本地模型（transformers.js）</option><option value="openai">OpenAI 兼容接口</option>
        </select>
      </label>
      <label class="field"><span>模型</span><input class="input mono" :value="config.embeddings.model" @change="saveConfig({ embeddings: { ...config.embeddings, model: ($event.target as HTMLInputElement).value } })" /><span class="hint">本地默认 Xenova/bge-small-zh-v1.5（首次使用会下载约 100MB，也可以填本地目录）。</span></label>
      <label v-if="config.embeddings.provider === 'openai'" class="field"><span>接口地址</span><input class="input mono" :value="config.embeddings.url ?? ''" placeholder="https://api.openai.com/v1" @change="saveConfig({ embeddings: { ...config.embeddings, url: ($event.target as HTMLInputElement).value } })" /></label>
    </section>

    <section v-else-if="tab === 'lark' && config" class="stack">
      <p class="muted">飞书机器人是日常指挥入口：私聊可以提问、交代事项、交办任务；机器人所在的群聊会被保存为聊天原件并交给助理整理。通知也会发到私聊。应用密钥从环境变量读取，不写入配置文件。</p>
      <label class="row"><input type="checkbox" :checked="config.lark.enabled" @change="saveConfig({ lark: { ...config.lark, enabled: ($event.target as HTMLInputElement).checked } })" />启用飞书机器人</label>
      <label class="field"><span>App ID</span><input class="input mono" :value="config.lark.appId ?? ''" @change="saveConfig({ lark: { ...config.lark, appId: ($event.target as HTMLInputElement).value } })" /></label>
      <label class="field"><span>App Secret 环境变量名</span><input class="input mono" :value="config.lark.appSecretEnv" @change="saveConfig({ lark: { ...config.lark, appSecretEnv: ($event.target as HTMLInputElement).value } })" /></label>
      <label class="field"><span>本人 open_id</span><input class="input mono" :value="config.lark.ownerOpenId ?? ''" placeholder="首次私聊机器人时会回复你的 open_id" @change="saveConfig({ lark: { ...config.lark, ownerOpenId: ($event.target as HTMLInputElement).value } })" /></label>
      <label class="field"><span>默认空间</span><select class="select" :value="config.lark.defaultSpace" @change="saveConfig({ lark: { ...config.lark, defaultSpace: ($event.target as HTMLSelectElement).value } })"><option v-for="s in state.spaces" :key="s.id" :value="s.id">{{ s.name }}</option></select></label>
      <p class="muted small">在飞书开放平台创建企业自建应用，开启机器人能力，事件订阅选择“长连接”，添加 im.message.receive_v1 事件和 im:message 权限。个人文档读取使用官方 lark-cli 的用户登录。</p>

      <div class="card pad stack">
        <div class="row"><strong>个人消息采集（只读）</strong><span class="spacer" /><button class="btn sm" @click="loadLarkChats">读取最近会话</button><button class="btn sm" @click="pollNow">立即采集</button></div>
        <p class="muted small">使用本机 lark-cli 的个人登录，只读取你选中的会话，以及任意群里 @你 的消息。定时采集在“定时任务”中开启。从不以你的身份发消息。</p>
        <div v-if="larkError" class="badge danger">{{ larkError }}</div>
        <div v-for="s in larkSubs" :key="s.chatId" class="row sub">
          <input type="checkbox" checked @change="toggleSub(s)" /><span class="grow ellipsis">{{ s.name }}</span>
          <select class="select" style="width: 160px" :value="s.spaceId" @change="toggleSub(s, ($event.target as HTMLSelectElement).value)"><option v-for="sp in state.spaces" :key="sp.id" :value="sp.id">{{ sp.name }}</option></select>
          <span class="muted small">{{ s.since ? `已采集到 ${fmtTime(s.since)}` : "尚未采集" }}</span>
        </div>
        <template v-for="c in larkChats" :key="c.chatId">
          <label v-if="!subOf(c.chatId)" class="row sub"><input type="checkbox" @change="toggleSub(c)" /><span class="grow ellipsis">{{ c.name }}</span><span class="muted small">{{ c.mode === "p2p" ? "单聊" : "群聊" }}</span></label>
        </template>
      </div>

      <div class="card pad stack">
        <label class="row"><input type="checkbox" :checked="config.telegram.enabled" @change="saveConfig({ telegram: { ...config.telegram, enabled: ($event.target as HTMLInputElement).checked } })" /><strong>Telegram 机器人</strong></label>
        <p class="muted small">用 @BotFather 创建机器人，把 token 放在环境变量 <span class="mono">{{ config.telegram.tokenEnv }}</span>。首次给机器人发消息会回复你的 chat id。</p>
        <label class="field"><span>本人 chat id</span><input class="input mono" :value="config.telegram.ownerChatId ?? ''" @change="saveConfig({ telegram: { ...config.telegram, ownerChatId: ($event.target as HTMLInputElement).value || undefined } })" /></label>
      </div>

      <div class="card pad stack">
        <label class="row"><input type="checkbox" :checked="config.onebot.enabled" @change="saveConfig({ onebot: { ...config.onebot, enabled: ($event.target as HTMLInputElement).checked } })" /><strong>QQ / 微信（OneBot v11）</strong></label>
        <p class="muted small">连接 NapCat、LLOneBot、Lagrange 等 OneBot 实现（正向 WebSocket）。私聊里只有本人能指挥助理；群消息保存为聊天原件并交给助理整理。</p>
        <div class="grid2">
          <label class="field"><span>WebSocket 地址</span><input class="input mono" :value="config.onebot.url ?? ''" placeholder="ws://127.0.0.1:3001" @change="saveConfig({ onebot: { ...config.onebot, url: ($event.target as HTMLInputElement).value || undefined } })" /></label>
          <label class="field"><span>显示名</span><input class="input" :value="config.onebot.name" @change="saveConfig({ onebot: { ...config.onebot, name: ($event.target as HTMLInputElement).value } })" /></label>
        </div>
        <label class="field"><span>本人账号（QQ 号 / 微信 id）</span><input class="input mono" :value="config.onebot.ownerUserId ?? ''" @change="saveConfig({ onebot: { ...config.onebot, ownerUserId: ($event.target as HTMLInputElement).value || undefined } })" /></label>
      </div>
    </section>

    <section v-else-if="tab === 'about'" class="stack">
      <label class="field"><span>主题</span><select v-model="state.theme" class="select" style="width: 200px"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <div class="card pad small stack">
        <div><kbd>Ctrl K</kbd> 搜索或提问 · <kbd>Ctrl J</kbd> 保存材料 · <kbd>Esc</kbd> 关闭引用层</div>
        <div class="muted">omem 也可以作为 MCP 服务给其他 Agent 使用：<span class="mono">omem mcp</span>（加 <span class="mono">--read-only</span> 只开放读取）。</div>
      </div>
    </section>

    <div v-if="editing" class="modal-overlay" @mousedown.self="editing = null">
      <div class="modal stack">
        <div class="row"><strong>空间设置：{{ editing.id }}</strong><span class="spacer" /><button class="btn ghost sm icon" @click="editing = null"><Icon name="x" /></button></div>
        <label class="field"><span>名称</span><input v-model="editing.name" class="input" /></label>
        <label class="field"><span>说明</span><input v-model="editing.description" class="input" /></label>
        <label class="field"><span>空间指南（SPACE.md，Agent 每次工作前都会读）</span><textarea v-model="guide" class="textarea mono" rows="10" /></label>
        <label class="row"><input type="checkbox" :checked="editing.settings.autoIngest !== false && (editing.kind !== 'repo' || editing.settings.autoIngest === true)" @change="editing.settings.autoIngest = ($event.target as HTMLInputElement).checked" />新材料保存后让助理整理（更新记忆、事项、相关页面）</label>
        <label v-if="editing.rootPath" class="field"><span>检查命令（交办编码后运行）</span><input v-model="editing.settings.checkCommand" class="input mono" placeholder="npm test" /></label>
        <label v-if="editing.rootPath" class="row"><input type="checkbox" :checked="editing.settings.autoLint !== false" @change="editing.settings.autoLint = ($event.target as HTMLInputElement).checked" />同步后自动检查受影响的 Wiki 页面</label>
        <div class="row"><span class="spacer" /><button class="btn primary" @click="saveSpace">保存</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spaces {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.sp {
  display: grid;
  gap: 4px;
}
.grid2 {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 12px;
}
.prow {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.prow:last-child {
  border-bottom: 0;
}
.grow {
  flex: 1;
  min-width: 0;
}
.roles {
  display: grid;
  gap: 6px;
}
.role .select {
  width: 220px;
}
.sched {
  display: grid;
  gap: 6px;
}
.cron {
  width: 160px;
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 55;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 6vh;
}
.modal {
  width: min(640px, calc(100vw - 24px));
  max-height: 88vh;
  overflow: auto;
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 18px;
}
@media (max-width: 640px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
  .role .select {
    width: 150px;
  }
}
</style>
