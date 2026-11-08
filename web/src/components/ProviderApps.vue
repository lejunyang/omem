<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, put } from "../api";
import { toast } from "../store";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import VirtualList from "./VirtualList.vue";

/**
 * Settings → 连接 → 其他平台 (docs/v2/connectors.md): the platforms omem can connect (Feishu and the
 * connect plugin's hundreds), searchable, in a scrolling list that draws only the rows in view. Each
 * row opens to say how it connects: an app the owner registers (callback URL, client id and secret)
 * or a key each member fills in on their account page; and whether members are offered it.
 * Secrets come back only as their last four characters.
 */
export type AppField = { key: string; label: string; secret: boolean; optional: boolean; help: string; value: string; masked: string; set: boolean };
export type Provider = { id: string; label: string; unavailable: string | null; callback: string | null; identity: boolean; group: string; docs: string; credentials: boolean; offered: boolean; app: AppField[] };
type Auth = Record<string, unknown> & { connectors: string[] };

const providers = ref<Provider[] | null>(null);
const auth = ref<Auth | null>(null);
const query = ref("");
const show = ref<"all" | "offered" | "identity" | "key">("all");
const group = ref("");
const open = ref<string | null>(null);
const draft = ref<Record<string, string>>({});
const saving = ref(false);

const SHOW = [
  { value: "all", label: "全部" },
  { value: "offered", label: "已开放" },
  { value: "identity", label: "能登录" },
  { value: "key", label: "填 key 连接" },
];
async function load() {
  const [p, s] = await Promise.all([get<Provider[]>("/api/auth/providers"), get<{ config: { auth: Auth } }>("/api/settings")]);
  providers.value = p;
  auth.value = s.config.auth;
}
onMounted(() => void load().catch((e) => toast((e as Error).message, "error")));

const offered = computed(() => auth.value?.connectors ?? []);
const groups = computed(() => [{ value: "", label: "所有用途" }, ...[...new Set((providers.value ?? []).map((p) => p.group).filter(Boolean))].sort().map((g) => ({ value: g, label: g }))]);
const isOffered = (p: Provider) => p.id === "lark" || offered.value.includes(p.id);
// Offered first, then those that can log in, then those whose content can become sources.
const CAPTURE = ["文档与知识库", "聊天与通讯", "邮件与日程", "会议与转写", "代码与开发", "项目与工单"];
const rank = (p: Provider) => (isOffered(p) ? 0 : p.identity ? 1 : CAPTURE.includes(p.group) ? 2 : 3);
const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (providers.value ?? [])
    .filter((p) => !q || p.id.toLowerCase().includes(q) || p.label.toLowerCase().includes(q) || p.group.includes(q))
    .filter((p) => !group.value || p.group === group.value)
    .filter((p) => (show.value === "offered" ? isOffered(p) : show.value === "identity" ? p.identity : show.value === "key" ? p.credentials : true))
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
});

function toggle(p: Provider) {
  open.value = open.value === p.id ? null : p.id;
  draft.value = Object.fromEntries(p.app.map((f) => [f.key, f.value]));
}
async function setOffered(p: Provider, on: boolean) {
  const connectors = on ? [...new Set([...offered.value, p.id])] : offered.value.filter((x) => x !== p.id);
  try {
    auth.value = (await put<{ config: { auth: Auth } }>("/api/settings", { auth: { ...auth.value!, connectors } })).config.auth;
    toast(on ? `已开放${p.label}，成员能在账号页连接` : `已不再开放${p.label}`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function save(p: Provider) {
  // A secret left empty keeps what is there; a cleared plain field is removed.
  const values: Record<string, string | null> = {};
  for (const f of p.app) {
    const v = (draft.value[f.key] ?? "").trim();
    if (f.secret && !v) continue;
    if (v !== f.value) values[f.key] = v || null;
  }
  if (!Object.keys(values).length) return toast("没有改动", "info");
  saving.value = true;
  try {
    const r = await put<{ unavailable: string | null; app: AppField[] }>(`/api/auth/providers/${p.id}/app`, { values });
    Object.assign(p, { unavailable: r.unavailable, app: r.app });
    toast(r.unavailable ? `已保存；${r.unavailable}` : "已保存", r.unavailable ? "info" : "ok");
    // Filled in for the first time: offer it to members too, unless the owner turns that off again.
    if (!r.unavailable && !isOffered(p)) await setOffered(p, true);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制", "ok");
  } catch {
    toast("复制失败，请手动选中复制", "error");
  }
}
</script>

<template>
  <div class="card pad stack">
    <p class="muted small">成员在账号页连接这些平台后，助手和采集以他的身份读他在那个平台上能看到的内容（只读）。能登录的平台（GitHub、Google、钉钉、微信……）还能用来登录和绑定 omem 账号。一个平台要先“开放”，成员的账号页才会出现它。</p>
    <div class="row wrap">
      <input v-model="query" class="input grow" type="search" placeholder="搜平台，如 notion、日历、钉钉" aria-label="搜平台" />
      <UiSelect v-model="group" width="160px" aria-label="用途" :options="groups" />
      <UiSegmented v-model="show" size="sm" aria-label="范围" :options="SHOW" />
    </div>
    <Skeleton v-if="!providers" variant="text" :rows="5" />
    <template v-else>
      <p class="muted small">共 {{ matches.length }} 个，滚动查看</p>
      <div class="apps" role="list">
        <VirtualList :items="matches" :item-key="(p) => p.id" :estimate="52">
          <template #default="{ item: p }">
            <div class="app stack" role="listitem">
              <div class="row wrap">
                <strong>{{ p.label }}</strong>
                <span v-if="p.group" class="badge">{{ p.group }}</span>
                <span v-if="p.identity" class="badge accent">能登录</span>
                <span v-if="p.credentials" class="badge">填 key 连接</span>
                <span class="spacer" />
                <span v-if="p.unavailable" class="small muted">{{ p.credentials ? "要先填站点" : "未设置应用" }}</span>
                <UiCheckbox v-if="p.id !== 'lark'" :model-value="isOffered(p)" switch size="sm" :aria-label="`开放${p.label}给成员连接`" @change="(v) => setOffered(p, v)">开放</UiCheckbox>
                <button class="btn ghost sm" :aria-expanded="open === p.id" @click="toggle(p)">{{ open === p.id ? "收起" : p.app.length ? "设置" : "说明" }}</button>
              </div>
              <div v-if="open === p.id" class="stack detail">
                <p v-if="p.id === 'lark'" class="small muted">飞书机器人应用在 设置 → 渠道 里配置；成员用它连接自己的飞书。</p>
                <p v-else-if="p.credentials" class="small">
                  用 API Key（或账号密码）连接，不用在{{ p.label }}建应用。开放后，每个成员在自己的账号页填他在{{ p.label }}生成的 key，omem 先用它试一次再保存；之后助手以他的身份读{{ p.label }}上他能看到的内容。不开放就不会出现在账号页。
                </p>
                <p v-else class="small">
                  用授权页连接：先在{{ p.label }}的开发者后台建一个 OAuth 应用，把下面的重定向 URL 填进去，再把 Client ID 和 Secret 填在这里。之后开放给成员，他们在账号页点“连接”、在{{ p.label }}上授权。{{ p.identity ? "它还能用来登录和绑定 omem 账号（在 成员 → 登录方式 里打开）。" : "" }}
                </p>
                <p v-if="p.unavailable" class="small warn-text">{{ p.unavailable }}</p>
                <p v-if="p.callback" class="small muted">重定向 URL：<span class="mono break">{{ p.callback }}</span><button class="btn ghost sm" @click="copy(p.callback)">复制</button></p>
                <p v-if="p.docs" class="small muted">接入说明：<a :href="p.docs" target="_blank" rel="noopener noreferrer" class="break">{{ p.docs }}</a></p>
                <label v-for="f in p.app" :key="f.key" class="field">
                  <span>{{ f.label }}<span v-if="f.optional" class="muted">（可不填）</span></span>
                  <input v-model="draft[f.key]" class="input" :type="f.secret ? 'password' : 'text'" autocomplete="off" :placeholder="f.secret && f.set ? `已填 ${f.masked}，不改就留空` : ''" />
                  <span v-if="f.help" class="hint">{{ f.help }}</span>
                </label>
                <div v-if="p.app.length" class="row"><button class="btn sm primary" :disabled="saving" @click="save(p)">保存</button></div>
              </div>
            </div>
          </template>
        </VirtualList>
        <p v-if="!matches.length" class="muted small">没有找到。换个名字试试，或者看看是不是在“其他”用途里。</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.grow {
  flex: 1 1 220px;
  min-width: 0;
}
/* About twenty rows tall; the rest scroll in, drawn as they come into view. */
.apps {
  max-height: min(1040px, 70vh);
  overflow-y: auto;
  border-top: 1px solid var(--line);
  overscroll-behavior: contain;
}
.app {
  border-bottom: 1px solid var(--line);
  padding: 10px 2px;
  gap: 6px;
  min-width: 0;
}
.detail {
  gap: 8px;
}
.break {
  overflow-wrap: anywhere;
}
</style>
