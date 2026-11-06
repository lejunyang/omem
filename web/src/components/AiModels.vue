<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { get, post, put } from "../api";
import { confirmDialog } from "../lib/dialog";
import { toast } from "../store";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * Settings → AI: the API-key providers and the three model categories omem calls itself (voice,
 * decision, image). Keys go to secrets/ai-keys.json through /api/ai/keys and come back only as
 * their last four characters; everything else is part of config `ai` (saved by the parent).
 */
type Kind = "openai" | "anthropic" | "typesafe" | "openrouter" | "openai-compatible";
type Provider = { id: string; name: string; kind: Kind; baseUrl?: string; backends: string[] };
type ProviderView = Provider & { keyHint: string; hasKey: boolean };
type Status = { ready: boolean; detail: string };
type AiView = { providers: ProviderView[]; status: Record<"voice" | "decision" | "image", Status>; defaults: Record<string, Record<string, string>>; kinds: Record<string, string[]>; inherited: string[] };
type Section = "keys" | "voice" | "decision" | "image";

const props = defineProps<{ section: Section; config: any }>();
const emit = defineEmits<{ save: [ai: any, note: string]; changed: [] }>();

const view = ref<AiView | null>(null);
async function load() {
  view.value = await get<AiView>("/api/ai").catch(() => null);
}
onMounted(load);
// The parent saves config `ai`; status depends on it.
watch(() => JSON.stringify(props.config.ai), () => void load());

const KIND_LABEL: Record<Kind, string> = { openai: "OpenAI", anthropic: "Anthropic（Claude）", typesafe: "TypeSafe（Jev）", openrouter: "OpenRouter", "openai-compatible": "OpenAI 兼容接口" };
const KIND_USES: Record<Kind, string> = {
  openai: "Codex（ACP / 命令行）、语音（GPT-Live、Realtime）、决策（Decisions API）、图片（gpt-image）",
  anthropic: "Claude Code（ACP / 命令行）",
  typesafe: "决策（Jev）",
  openrouter: "决策（Jev 等）",
  "openai-compatible": "语音、图片（接口与 OpenAI 相同的服务，例如代理或 Azure）",
};
const BACKEND_LABEL: Record<string, string> = { claude: "Claude Code（ACP）", "claude-cli": "Claude Code（命令行）", codex: "Codex（ACP）", "codex-cli": "Codex（命令行）" };
const BACKENDS_OF: Record<string, string[]> = { anthropic: ["claude", "claude-cli"], openai: ["codex", "codex-cli"] };

const providers = computed<ProviderView[]>(() => view.value?.providers ?? []);
const saveProviders = (list: Provider[], note: string) => emit("save", { ...props.config.ai, providers: list.map(({ id, name, kind, baseUrl, backends }) => ({ id, name, kind, ...(baseUrl ? { baseUrl } : {}), backends })) }, note);

// ------------------------------------------------------------------ keys
const draft = ref<{ kind: Kind; name: string; id: string; baseUrl: string; key: string; backends: string[] }>({ kind: "openai", name: "", id: "", baseUrl: "", key: "", backends: [] });
const busy = ref(false);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
const suggestedId = computed(() => {
  const base = slug(draft.value.name) || slug(draft.value.kind);
  let id = base || "key";
  for (let i = 2; providers.value.some((p) => p.id === id); i++) id = `${base}-${i}`;
  return id;
});
watch(() => draft.value.kind, (k) => { draft.value.backends = [...(BACKENDS_OF[k] ?? [])]; }, { immediate: true });
async function addProvider() {
  const d = draft.value;
  const id = slug(d.id) || suggestedId.value;
  if (providers.value.some((p) => p.id === id)) return toast(`已有 ${id}`, "error");
  if (d.kind === "openai-compatible" && !d.baseUrl.trim()) return toast("OpenAI 兼容接口要填写地址", "error");
  if (!d.key.trim()) return toast("填写 API key", "error");
  busy.value = true;
  try {
    const list: Provider[] = [...providers.value, { id, name: d.name.trim(), kind: d.kind, baseUrl: d.baseUrl.trim() || undefined, backends: d.backends }];
    // Config first (the key endpoint only takes known providers), then the key.
    await put("/api/settings", { ai: { ...props.config.ai, providers: list.map(({ id, name, kind, baseUrl, backends }) => ({ id, name, kind, ...(baseUrl ? { baseUrl } : {}), backends })) } });
    view.value = await put<AiView>(`/api/ai/keys/${encodeURIComponent(id)}`, { key: d.key.trim() });
    draft.value = { kind: d.kind, name: "", id: "", baseUrl: "", key: "", backends: [...(BACKENDS_OF[d.kind] ?? [])] };
    emit("changed");
    toast(`已添加 ${d.name.trim() || id}`, "ok");
    void test(id);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
const tests = ref<Record<string, { loading?: boolean; ok?: boolean; detail?: string }>>({});
async function test(id: string) {
  tests.value[id] = { loading: true };
  try {
    tests.value[id] = await post<{ ok: boolean; detail: string }>(`/api/ai/providers/${encodeURIComponent(id)}/test`);
  } catch (e) {
    tests.value[id] = { ok: false, detail: (e as Error).message };
  }
}
const replacing = ref<Record<string, string>>({});
async function replaceKey(id: string) {
  const key = replacing.value[id]?.trim();
  if (!key) return;
  view.value = await put<AiView>(`/api/ai/keys/${encodeURIComponent(id)}`, { key });
  delete replacing.value[id];
  emit("changed");
  toast("已更换 API key", "ok");
  void test(id);
}
async function remove(p: ProviderView) {
  const used = (["voice", "decision", "image"] as const).filter((c) => props.config.ai[c].provider === p.id);
  const ok = await confirmDialog(`移除 ${p.name || p.id}？`, {
    message: `API key 一起删除${p.backends.length ? `，用它生成的 ${p.backends.length} 个后端也会消失（选了它们的角色会报“后端不存在”）` : ""}${used.length ? `；${used.map((c) => CAT_LABEL[c]).join("、")}要重新选提供方` : ""}。`,
    okText: "移除",
    danger: true,
  });
  if (!ok) return;
  saveProviders(providers.value.filter((x) => x.id !== p.id), `已移除 ${p.name || p.id}`);
  emit("changed");
}
function setBackends(p: ProviderView, backends: string[]) {
  saveProviders(providers.value.map((x) => (x.id === p.id ? { ...x, backends } : x)), "已更新生成的后端");
  emit("changed");
}

// ------------------------------------------------------------ categories
const CAT_LABEL = { voice: "语音模型", decision: "决策模型", image: "图片生成模型" } as const;
type Cat = keyof typeof CAT_LABEL;
const cat = computed(() => (props.section === "keys" ? null : (props.section as Cat)));
const catValue = computed(() => (cat.value ? props.config.ai[cat.value] : null));
const providerOptions = computed(() => {
  if (!cat.value || !view.value) return [];
  const kinds = view.value.kinds[cat.value] ?? [];
  const opts = providers.value.filter((p) => kinds.includes(p.kind)).map((p) => ({ value: p.id, label: p.name || p.id, hint: `${KIND_LABEL[p.kind]}${p.hasKey ? "" : " · 没有 key"}` }));
  if (cat.value === "decision") opts.push({ value: "startlux", label: "StartLux-Decision（本机）", hint: "本地判官，和注入标记共用" });
  return [{ value: "", label: "不使用" }, ...opts];
});
const providerOf = (id: string) => providers.value.find((p) => p.id === id);
const modelPlaceholder = computed(() => {
  if (!cat.value || !catValue.value || !view.value) return "";
  const v = catValue.value;
  if (v.provider === "startlux") return "StartLux-Decision";
  const kind = providerOf(v.provider)?.kind ?? "openai";
  return (cat.value === "voice" && v.api === "realtime" ? view.value.defaults.voice.realtime : view.value.defaults[cat.value][kind]) || "模型名";
});
function setCat(patch: Record<string, unknown>, note = `已保存${cat.value ? CAT_LABEL[cat.value] : ""}`) {
  if (!cat.value) return;
  emit("save", { ...props.config.ai, [cat.value]: { ...props.config.ai[cat.value], ...patch } }, note);
}
const status = computed(() => (cat.value && view.value ? view.value.status[cat.value] : null));
// Try the decision model on a question (yes/no, or a choice with 2+ options, one per line).
const trial = ref({ material: "", question: "", options: "", busy: false, result: null as null | { choice: string; probabilities: Record<string, number>; by: string; ms: number }, error: "" });
async function tryDecision() {
  const t = trial.value;
  t.busy = true;
  t.error = "";
  t.result = null;
  try {
    const options = t.options.split("\n").map((s) => s.trim()).filter(Boolean);
    t.result = await post("/api/ai/decision/test", { material: t.material, question: t.question, options });
  } catch (e) {
    t.error = (e as Error).message;
  } finally {
    t.busy = false;
  }
}
const sortedProbs = computed(() => Object.entries(trial.value.result?.probabilities ?? {}).sort((a, b) => b[1] - a[1]));
const noProviders = computed(() => cat.value && cat.value !== "decision" && providerOptions.value.length <= 1);
</script>

<template>
  <div v-if="section === 'keys'" class="stack">
    <p class="muted">
      用 API key 直接调用模型：语音、决策、图片三类模型用它们；OpenAI 和 Anthropic 的 key 还可以让 Codex / Claude Code 按 API 计费运行，作为单独的后端出现在“通用”里，和本机登录的那个并存，额度和并发分开算。key 存在数据目录的
      <span class="mono">secrets/ai-keys.json</span>，不写进 config.json，网页上只显示后 4 位。
    </p>
    <div v-if="view?.inherited.length" class="card pad small">
      服务的环境里已经有 <span class="mono">{{ view.inherited.join("、") }}</span>：所有 Agent 启动时都会继承它，本机登录的 Codex / Claude Code 也可能因此按 API 计费。只想让下面生成的后端用 key 的话，从服务的环境里去掉它。
    </div>
    <div class="card">
      <div v-for="p in providers" :key="p.id" class="prow wrap">
        <div class="grow">
          <div><strong>{{ p.name || p.id }}</strong> <span class="muted small mono">{{ p.id }}</span> <span class="badge">{{ KIND_LABEL[p.kind] }}</span></div>
          <div class="muted small">
            <span class="mono">{{ p.hasKey ? p.keyHint : "没有 key" }}</span><template v-if="p.baseUrl"> · <span class="mono">{{ p.baseUrl }}</span></template> · 可用于：{{ KIND_USES[p.kind] }}
          </div>
          <div v-if="tests[p.id] && !tests[p.id].loading" class="small" :class="tests[p.id].ok ? 'ok-text' : 'err-text'">{{ tests[p.id].detail }}</div>
          <div v-if="BACKENDS_OF[p.kind]" class="row wrap small be-row">
            <span class="muted">生成后端：</span>
            <UiCheckbox v-for="b in BACKENDS_OF[p.kind]" :key="b" size="sm" :model-value="p.backends" :value="b" @update:model-value="(v) => setBackends(p, v as string[])">{{ BACKEND_LABEL[b] }}<span class="muted mono"> {{ b }}@{{ p.id }}</span></UiCheckbox>
          </div>
          <div v-if="replacing[p.id] !== undefined" class="row wrap be-row">
            <input v-model="replacing[p.id]" class="input mono key-input" type="password" autocomplete="off" placeholder="新的 API key" @keydown.enter="replaceKey(p.id)" />
            <button class="btn sm primary" :disabled="!replacing[p.id]?.trim()" @click="replaceKey(p.id)">保存</button>
            <button class="btn sm ghost" @click="delete replacing[p.id]">取消</button>
          </div>
        </div>
        <button class="btn ghost sm" :disabled="tests[p.id]?.loading" @click="test(p.id)">{{ tests[p.id]?.loading ? "检查中…" : "检查" }}</button>
        <button class="btn ghost sm" @click="replacing[p.id] = ''">更换 key</button>
        <button class="btn ghost sm icon" :aria-label="`移除 ${p.name || p.id}`" title="移除" @click="remove(p)"><Icon name="x" :size="14" /></button>
      </div>
      <div v-if="view && !providers.length" class="prow muted">还没有 API key。</div>
    </div>
    <form class="card pad stack" @submit.prevent="addProvider">
      <div class="section-title">添加 API key</div>
      <div class="grid2">
        <div class="field"><span>提供方</span><UiSelect v-model="draft.kind" aria-label="提供方" :options="(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ value: k, label: KIND_LABEL[k], hint: KIND_USES[k] }))" /></div>
        <label class="field"><span>名称（可选）</span><input v-model="draft.name" class="input" maxlength="40" placeholder="例如：个人、团队" /></label>
      </div>
      <label class="field"><span>API key</span><input v-model="draft.key" class="input mono" type="password" autocomplete="off" required /></label>
      <label class="field">
        <span>接口地址{{ draft.kind === "openai-compatible" ? "" : "（可选，默认官方地址）" }}</span>
        <input v-model="draft.baseUrl" class="input mono" :required="draft.kind === 'openai-compatible'" :placeholder="draft.kind === 'openai-compatible' ? 'https://example.com/v1' : '留空用官方地址'" />
      </label>
      <div v-if="BACKENDS_OF[draft.kind]" class="row wrap small">
        <span class="muted">同时生成后端：</span>
        <UiCheckbox v-for="b in BACKENDS_OF[draft.kind]" :key="b" v-model="draft.backends" size="sm" :value="b">{{ BACKEND_LABEL[b] }}</UiCheckbox>
      </div>
      <div class="row"><span class="muted small">编号 <span class="mono">{{ slug(draft.id) || suggestedId }}</span>，生成的后端叫 <span class="mono">codex@{{ slug(draft.id) || suggestedId }}</span> 这样</span><span class="spacer" /><button class="btn primary sm" :disabled="busy || !draft.key.trim()">{{ busy ? "保存中…" : "添加" }}</button></div>
    </form>
    <div class="card pad stack small">
      <div class="section-title">哪些后端能用 API key</div>
      <p class="muted">这里能直接生成的是 Codex 和 Claude Code。OpenCode、goose、Cline、Kilo、pi、DeepAgents、Factory Droid 也支持自带 OpenAI / Anthropic 的 key，按它们自己的方式配置（多数是环境变量或它们的设置文件，可以写进“通用”里该后端配置的 <span class="mono">env</span>）。Copilot、Cursor、Amp、Junie、Devin、Gemini CLI、Qwen Code 用自家账号或自家的 key，不吃这两家的 key。</p>
    </div>
  </div>

  <div v-else-if="cat && catValue" class="stack">
    <div class="row">
      <span class="badge" :class="{ ok: status?.ready }">{{ status?.ready ? "可用" : "未启用" }}</span>
      <span class="small muted">{{ status?.detail }}</span>
    </div>
    <template v-if="cat === 'voice'">
      <p class="muted">用于问答页的语音输入、和助理实时语音对话，以及英语口语训练（按你选的场景对话，结束后给出真实水平的评价，中途可以用中文问不会的说法）。这几项功能会在语音模型可用后逐步开放。</p>
      <p class="muted small">接口：<strong>GPT-Live</strong>（<span class="mono">gpt-live-1</span>，全双工，边听边说，可以随时打断）或 <strong>Realtime API</strong>（<span class="mono">gpt-realtime-*</span>）。浏览器经 WebRTC 直连 OpenAI，服务器只发一次性的临时凭证，API key 不会进浏览器。</p>
    </template>
    <template v-else-if="cat === 'decision'">
      <p class="muted">决策模型只做有边界的判断：从几个选项里选一个、是或否、按几档打分，并给出每个选项的概率，比通用模型快很多也便宜很多。会用在访客提问的把关（回答 / 拒绝 / 不理）和规则的 AI 判断（规则上可选决策模型或通用模型，默认先用决策模型）。</p>
      <p class="muted small">接口：<strong>OpenAI Decisions API</strong>（<span class="mono">POST /v1/decisions</span>，<span class="mono">gpt-6-luna</span>）、<strong>Jev</strong>（TypeSafe <span class="mono">/v1/systemone</span>，或经 OpenRouter）、本机的 <strong>StartLux-Decision</strong>（和注入标记共用）。三家的请求格式不同，omem 统一成“材料 + 问题 + 选项 → 每个选项的概率”。</p>
    </template>
    <template v-else>
      <p class="muted">图片生成模型可用后，Agent 才会拿到画图工具：给 Wiki 页配示意图，在飞书回复里发图，或者你在问答里直接让它画。</p>
      <p class="muted small">接口：OpenAI Images API（<span class="mono">gpt-image-2</span>，生成与编辑）。</p>
    </template>

    <div v-if="noProviders" class="card pad small">还没有能提供{{ CAT_LABEL[cat] }}的 API key：先到“API key”里添加 OpenAI 的 key。</div>
    <div class="card pad stack">
      <div class="grid2">
        <div class="field"><span>提供方</span><UiSelect :model-value="catValue.provider" aria-label="提供方" :options="providerOptions" @change="(v) => setCat({ provider: v })" /></div>
        <label v-if="catValue.provider !== 'startlux'" class="field">
          <span>模型（留空用默认）</span>
          <input :value="catValue.model" class="input mono" :placeholder="modelPlaceholder" @change="setCat({ model: ($event.target as HTMLInputElement).value.trim() })" />
        </label>
      </div>
      <template v-if="cat === 'voice'">
        <div class="field"><span>接口</span><UiSegmented :model-value="catValue.api" aria-label="语音接口" :options="[{ value: 'live', label: 'GPT-Live' }, { value: 'realtime', label: 'Realtime' }]" @change="(v: string) => setCat({ api: v })" /></div>
        <label class="field"><span>声音（可选）</span><input :value="catValue.voice" class="input mono" style="max-width: 240px" placeholder="默认" @change="setCat({ voice: ($event.target as HTMLInputElement).value.trim() })" /></label>
      </template>
      <template v-else-if="cat === 'decision'">
        <div class="field">
          <span>决策模型出错时（没有配置时总是用通用模型）</span>
          <UiSegmented :model-value="catValue.fallback" aria-label="决策模型出错时" :options="[{ value: 'general', label: '改用通用模型判断' }, { value: 'none', label: '不判断（按否处理）' }]" @change="(v: string) => setCat({ fallback: v })" />
        </div>
        <UiCheckbox :model-value="catValue.gatekeeper !== false" switch @change="(v) => setCat({ gatekeeper: v })">访客提问的把关先用决策模型（拒绝时回固定的一句话；关掉则由“访客提问把关”角色判断）</UiCheckbox>
        <p class="muted small">规则的 AI 判断在每条规则里选“决策模型优先”或“通用模型”，默认决策模型优先。</p>
      </template>
      <template v-else>
        <div class="grid2">
          <label class="field"><span>尺寸（可选）</span><input :value="catValue.size" class="input mono" placeholder="auto，例如 1024x1024" @change="setCat({ size: ($event.target as HTMLInputElement).value.trim() })" /></label>
          <label class="field"><span>质量（可选）</span><input :value="catValue.quality" class="input mono" placeholder="auto / low / medium / high" @change="setCat({ quality: ($event.target as HTMLInputElement).value.trim() })" /></label>
        </div>
      </template>
    </div>
    <form v-if="cat === 'decision'" class="card pad stack" @submit.prevent="tryDecision">
      <div class="section-title">试一下</div>
      <label class="field"><span>材料</span><textarea v-model="trial.material" class="textarea" rows="4" required placeholder="例如一条群消息：线上下单页白屏了，用户点支付没反应，两个浏览器都试过" /></label>
      <label class="field"><span>问题</span><input v-model="trial.question" class="input" required placeholder="例如：这是不是需要马上处理的线上故障？" /></label>
      <label class="field"><span>选项（一行一个；不填就是 是 / 否）</span><textarea v-model="trial.options" class="textarea" rows="3" placeholder="回答&#10;拒绝&#10;不理" /></label>
      <div class="row"><span v-if="trial.error" class="small err-text">{{ trial.error }}</span><span class="spacer" /><button class="btn primary sm" :disabled="trial.busy || !status?.ready">{{ trial.busy ? "判断中…" : "判断" }}</button></div>
      <div v-if="trial.result" class="stack small">
        <div><strong>{{ trial.result.choice === "yes" ? "是" : trial.result.choice === "no" ? "否" : trial.result.choice }}</strong> <span class="muted">· {{ trial.result.by }} · {{ trial.result.ms }} ms</span></div>
        <div v-for="[k, p] in sortedProbs" :key="k" class="prob-row">
          <span class="prob-label">{{ k === "yes" ? "是" : k === "no" ? "否" : k }}</span>
          <span class="prob-bar"><span :style="{ width: `${Math.round(p * 100)}%` }" /></span>
          <span class="mono">{{ p.toFixed(2) }}</span>
        </div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.prow {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.prow:last-child {
  border-bottom: 0;
}
.be-row {
  margin-top: 6px;
  gap: 12px;
}
.key-input {
  width: min(360px, 100%);
}
.ok-text {
  color: var(--ok);
}
.prob-row {
  display: grid;
  grid-template-columns: minmax(48px, 120px) 1fr 40px;
  gap: 8px;
  align-items: center;
}
.prob-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prob-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--sunken);
  overflow: hidden;
}
.prob-bar span {
  display: block;
  height: 100%;
  background: var(--accent);
}
.err-text {
  color: var(--danger);
}
</style>
