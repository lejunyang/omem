<script setup lang="ts">
import { computed, ref } from "vue";
import { put } from "../api";
import { toast } from "../store";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * Settings → 成员 → 平台应用 (docs/v2/connectors.md): the platforms omem can connect (Feishu and the
 * connect plugin's hundreds), searchable. For each the owner fills in its app once (client id and
 * secret, a site), copies the callback URL into the platform's console, and offers it to members on
 * their account page. Secrets come back only as their last four characters.
 */
export type AppField = { key: string; label: string; secret: boolean; optional: boolean; help: string; value: string; masked: string; set: boolean };
export type Provider = { id: string; label: string; unavailable: string | null; callback: string | null; identity: boolean; group: string; docs: string; credentials: boolean; offered: boolean; app: AppField[] };

const props = defineProps<{ providers: Provider[]; offered: string[] }>();
const emit = defineEmits<{ offer: [list: string[]]; saved: [] }>();

const query = ref("");
const show = ref<"all" | "offered" | "identity" | "key">("all");
const group = ref("");
const open = ref<string | null>(null);
const draft = ref<Record<string, string>>({});
const saving = ref(false);
const LIMIT = 40;

const SHOW = [
  { value: "all", label: "全部" },
  { value: "offered", label: "已开放" },
  { value: "identity", label: "能登录" },
  { value: "key", label: "填 key 连接" },
];
const groups = computed(() => [{ value: "", label: "所有用途" }, ...[...new Set(props.providers.map((p) => p.group).filter(Boolean))].sort().map((g) => ({ value: g, label: g }))]);
const isOffered = (p: Provider) => p.id === "lark" || props.offered.includes(p.id);
const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  return props.providers
    .filter((p) => !q || p.id.toLowerCase().includes(q) || p.label.toLowerCase().includes(q))
    .filter((p) => !group.value || p.group === group.value)
    .filter((p) => (show.value === "offered" ? isOffered(p) : show.value === "identity" ? p.identity : show.value === "key" ? p.credentials : true))
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
});
// Offered first, then those that can log in, then those whose content can become sources.
const CAPTURE = ["文档与知识库", "聊天与通讯", "邮件与日程", "会议与转写", "代码与开发", "项目与工单"];
const rank = (p: Provider) => (isOffered(p) ? 0 : p.identity ? 1 : CAPTURE.includes(p.group) ? 2 : 3);
const shown = computed(() => matches.value.slice(0, LIMIT));

function toggle(p: Provider) {
  open.value = open.value === p.id ? null : p.id;
  draft.value = Object.fromEntries(p.app.map((f) => [f.key, f.value]));
}
function offer(p: Provider, on: boolean) {
  emit("offer", on ? [...new Set([...props.offered, p.id])] : props.offered.filter((x) => x !== p.id));
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
    const r = await put<{ unavailable: string | null }>(`/api/auth/providers/${p.id}/app`, { values });
    toast(r.unavailable ? `已保存；还缺：${r.unavailable}` : "已保存", r.unavailable ? "info" : "ok");
    // Filled in for the first time: offer it to members too, unless the owner turns that off again.
    if (!r.unavailable && !isOffered(p)) offer(p, true);
    emit("saved");
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
    <p class="muted small">
      能登录的平台（GitHub、Google、钉钉、微信……）可以用来登录和绑定账号；其余只用来读取，成员连接后，助手和采集以他的身份读他在那个平台上能看到的内容。用授权页连接的平台要先在平台的开发者后台建一个应用，把重定向 URL 填进去，再把 Client ID 和 Secret 填在这里；用 key 连接的平台不用建应用，开放后成员自己填 key。
    </p>
    <div class="row wrap">
      <input v-model="query" class="input grow" type="search" placeholder="搜平台，如 notion、日历、钉钉" aria-label="搜平台" />
      <UiSelect v-model="group" width="160px" aria-label="用途" :options="groups" />
      <UiSegmented v-model="show" size="sm" aria-label="范围" :options="SHOW" />
    </div>
    <p class="muted small">共 {{ matches.length }} 个{{ matches.length > LIMIT ? `，先列出 ${LIMIT} 个，输入名字缩小范围` : "" }}</p>
    <div class="apps">
      <div v-for="p in shown" :key="p.id" class="app stack">
        <div class="row wrap">
          <strong>{{ p.label }}</strong>
          <span v-if="p.group" class="badge">{{ p.group }}</span>
          <span v-if="p.identity" class="badge accent">能登录</span>
          <span v-if="p.credentials" class="badge">填 key 连接</span>
          <span class="spacer" />
          <span v-if="p.unavailable" class="small muted">未设置</span>
          <UiCheckbox v-if="p.id !== 'lark'" :model-value="isOffered(p)" switch size="sm" :aria-label="`开放${p.label}给成员连接`" @change="(v) => offer(p, v)">开放</UiCheckbox>
          <button v-if="p.app.length || p.callback" class="btn ghost sm" :aria-expanded="open === p.id" @click="toggle(p)">{{ open === p.id ? "收起" : "设置" }}</button>
        </div>
        <div v-if="open === p.id" class="stack detail">
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
      <p v-if="!matches.length" class="muted small">没有找到。换个名字试试，或者看看是不是在“其他”用途里。</p>
    </div>
  </div>
</template>

<style scoped>
.grow {
  flex: 1 1 220px;
  min-width: 0;
}
.apps {
  display: grid;
}
.app {
  border-top: 1px solid var(--line);
  padding: 10px 0;
  gap: 6px;
  min-width: 0;
}
.detail {
  gap: 8px;
  padding-left: 2px;
}
.break {
  overflow-wrap: anywhere;
}
</style>
