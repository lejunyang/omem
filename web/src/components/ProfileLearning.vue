<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { del, post, put, type Memory } from "../api";
import { compactDiff, diffLines } from "../lib/diff";
import { confirmDialog } from "../lib/dialog";
import { fmtTime, relTime, toast } from "../store";
import ChipPicker from "./ChipPicker.vue";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import MemoryCard from "./MemoryCard.vue";

/**
 * What a profile (agent spec or built-in role) has learned and how it is evolving: its mounted
 * skills, its own memories, the changes its reviews proposed, its use and its history.
 */
export type Proposal = { id: string; kind: "prompt" | "skill" | "settings"; title: string; body: string; reason: string; status: string; createdAt: string; runId: string | null };
export type ProfileDetail = {
  kind: "spec" | "role";
  skills: { name: string; description: string; status: string }[];
  availableSkills: { name: string; description: string; status: string }[];
  memories: Memory[];
  proposals: Proposal[];
  usage: { runs30d: Record<string, number>; lastRun: { id: string; at: string; status: string } | null; recalls30d: number; recallHits30d: number; lastReviewAt: string | null };
  history: { hash: string; at: string; message: string }[];
};

const props = defineProps<{ name: string; detail: ProfileDetail; currentPrompt: string }>();
const emit = defineEmits<{ changed: [] }>();
const router = useRouter();

const skillNames = computed(() => props.detail.skills.map((s) => s.name));
const missing = computed(() => props.detail.skills.filter((s) => s.status === "missing").map((s) => s.name));
const skillOptions = computed(() => props.detail.availableSkills.map((s) => ({ value: s.name, hint: `${s.status === "draft" ? "（草稿）" : ""}${s.description}` })));
async function setSkills(next: string[]) {
  const add = next.filter((x) => !skillNames.value.includes(x));
  const remove = skillNames.value.filter((x) => !next.includes(x));
  try {
    await put(`/api/profiles/${encodeURIComponent(props.name)}/skills`, { add, remove });
    toast(add.length ? `已挂载 ${add.join("、")}` : `已移除 ${remove.join("、")}`, "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function forget(m: Memory) {
  if (!(await confirmDialog("撤回这条专属记忆？", { message: m.content, okText: "撤回", danger: true }))) return;
  await del(`/api/memories/${m.id}?reason=${encodeURIComponent("网页撤回档案专属记忆")}`);
  toast("已撤回", "ok");
  emit("changed");
}

const pending = computed(() => props.detail.proposals.filter((p) => p.status === "pending"));
const resolved = computed(() => props.detail.proposals.filter((p) => p.status !== "pending").slice(0, 8));
const kindLabel: Record<string, string> = { prompt: "提示词", skill: "技能", settings: "设置" };
function content(p: Proposal) {
  try {
    return JSON.parse(p.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}
const promptDiff = (p: Proposal) => compactDiff(diffLines(props.currentPrompt, String(content(p).prompt ?? "")));
function settingsLines(p: Proposal) {
  const c = content(p) as Record<string, string[] | undefined>;
  return [
    c.add_tools?.length ? `加工具：${c.add_tools.join("、")}` : "",
    c.remove_tools?.length ? `去掉工具：${c.remove_tools.join("、")}` : "",
    c.add_skills?.length ? `挂技能：${c.add_skills.join("、")}` : "",
    c.remove_skills?.length ? `卸技能：${c.remove_skills.join("、")}` : "",
  ].filter(Boolean);
}
async function resolve(p: Proposal, action: "apply" | "reject") {
  try {
    await post(`/api/profile-proposals/${p.id}/${action}`);
    toast(action === "apply" ? "已采纳" : "已忽略", "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

const reviewing = ref(false);
async function review() {
  reviewing.value = true;
  try {
    const r = await post<{ id: string }>(`/api/profiles/${encodeURIComponent(props.name)}/review`);
    toast("已开始复盘，完成后建议出现在这里", "ok", `#/runs/${r.id}`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    reviewing.value = false;
  }
}
const runs = computed(() => Object.values(props.detail.usage.runs30d).reduce((a, b) => a + b, 0));
</script>

<template>
  <div class="learning">
    <section class="block">
      <div class="block-head">
        <h3>挂载技能</h3>
        <span class="muted small">可复用的做法；它做对应的事前会先读。点名字查看与编辑</span>
      </div>
      <ChipPicker :model-value="skillNames" :options="skillOptions" :missing="missing" add-label="＋ 挂载技能" openable @update:model-value="setSkills" @open="(n) => router.push({ path: '/agents', query: { tab: 'skills', name: n } })" />
    </section>

    <section class="block">
      <div class="block-head">
        <h3>专属记忆 <span class="count">{{ detail.memories.length }}</span></h3>
        <span class="muted small">只有它看得到的偏好与经验；共享记忆在「记忆」页</span>
      </div>
      <div v-if="detail.memories.length" class="mems">
        <MemoryCard v-for="m in detail.memories" :key="m.id" :m="m" compact @retract="forget($event)" />
      </div>
      <p v-else class="muted small">还没有。你纠正它的做法后，助理用 <code>remember(agent="{{ name }}")</code> 记在这里；夜里的复盘也会从它的运行里整理。</p>
    </section>

    <section class="block">
      <div class="block-head">
        <h3>进化</h3>
        <span class="spacer" />
        <button class="btn sm" :disabled="reviewing" @click="review"><Icon name="refresh" :size="13" />立即复盘</button>
      </div>
      <div class="stats small">
        <span v-if="detail.kind === 'spec'">近 30 天运行 <b>{{ runs }}</b><template v-if="detail.usage.runs30d.failed"> · 失败 {{ detail.usage.runs30d.failed }}</template></span>
        <span>专属记忆被召回 <b>{{ detail.usage.recalls30d }}</b> 次 · 用上 {{ detail.usage.recallHits30d }}</span>
        <span v-if="detail.usage.lastRun">上次运行 <router-link :to="`/runs/${detail.usage.lastRun.id}`">{{ relTime(detail.usage.lastRun.at) }}</router-link></span>
        <span>上次复盘 {{ detail.usage.lastReviewAt ? relTime(detail.usage.lastReviewAt) : "还没有" }}</span>
      </div>
      <p class="muted small">每晚复盘最近有纠正或失败的档案：经验和偏好直接记成它的专属记忆（经过检查和复核），提示词、技能、设置的改动列在下面，你采纳后才生效。</p>

      <div v-for="p in pending" :key="p.id" class="proposal">
        <div class="row">
          <span class="badge accent">{{ kindLabel[p.kind] }}</span>
          <strong class="grow">{{ p.title }}</strong>
          <span class="muted small">{{ relTime(p.createdAt) }}</span>
        </div>
        <div v-if="p.reason" class="muted small reason"><Markdown :source="p.reason" /></div>
        <div v-if="p.kind === 'prompt'" class="diff">
          <div v-for="(l, i) in promptDiff(p)" :key="i" :class="l.op === '+' ? 'a' : l.op === '-' ? 'r' : l.op === '…' ? 'gap' : ''">{{ l.op === "…" ? "…" : `${l.op === "=" ? " " : l.op} ${l.text}` }}</div>
        </div>
        <details v-else-if="p.kind === 'skill'" class="skill-body">
          <summary class="small">技能 {{ String(content(p).name) }}：{{ String(content(p).description) }}</summary>
          <Markdown :source="String(content(p).body ?? '')" />
        </details>
        <ul v-else class="small">
          <li v-for="l in settingsLines(p)" :key="l">{{ l }}</li>
        </ul>
        <div class="row actions">
          <button class="btn sm primary" @click="resolve(p, 'apply')"><Icon name="check" :size="13" />采纳</button>
          <button class="btn ghost sm" @click="resolve(p, 'reject')">忽略</button>
          <router-link v-if="p.runId" :to="`/runs/${p.runId}`" class="muted small">来自复盘</router-link>
        </div>
      </div>
      <p v-if="!pending.length" class="muted small">没有待确认的建议。</p>
      <details v-if="resolved.length || detail.history.length" class="history">
        <summary class="small">历史</summary>
        <div v-for="p in resolved" :key="p.id" class="small hist-line"><span class="badge">{{ p.status === "applied" ? "已采纳" : "已忽略" }}</span> {{ kindLabel[p.kind] }} · {{ p.title }}</div>
        <div v-for="c in detail.history" :key="c.hash" class="small hist-line mono"><span class="muted">{{ fmtTime(c.at) }}</span> {{ c.message }}</div>
      </details>
    </section>
  </div>
</template>

<style scoped>
.learning {
  display: grid;
  gap: 12px;
}
.block {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.block-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.block-head h3 {
  margin: 0;
  font-size: 14px;
}
.count {
  color: var(--muted);
  font-weight: 400;
}
.mems {
  display: grid;
  max-height: 360px;
  overflow-y: auto;
}
.mems :deep(.mem) {
  padding: 8px 0;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--ink-2);
}
.proposal {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  gap: 6px;
  background: var(--panel, var(--bg));
}
.reason {
  margin: 0;
}
.diff {
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
  border-radius: 6px;
  background: var(--sunken);
  padding: 6px 0;
}
.diff > div {
  padding: 0 10px;
}
.diff .a {
  background: var(--ok-soft);
}
.diff .r {
  background: var(--danger-soft);
}
.diff .gap {
  color: var(--muted);
}
.actions {
  gap: 8px;
}
.hist-line {
  padding: 2px 0;
}
.grow {
  flex: 1;
  min-width: 0;
}
</style>
