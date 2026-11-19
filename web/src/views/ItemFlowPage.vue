<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, onServerEvent, onServerResync, post } from "../api";
import Icon from "../components/Icon.vue";
import Markdown from "../components/Markdown.vue";
import ItemStudy from "../components/ItemStudy.vue";
import RunArtifacts from "../components/RunArtifacts.vue";
import Skeleton from "../components/Skeleton.vue";
import FlowWaiting from "../components/FlowWaiting.vue";
import type { Material } from "../components/ItemMaterials.vue";
import { evidenceLink, ownerTurn, stageWords, testWords, type FlowStage, type FlowView, type StageTest } from "../lib/flow";
import { refAction } from "../lib/refs";
import { fmtTime, openCitation, relTime, state } from "../store";

/**
 * One item's flow on its own page, read like a write-up: what it is about (with the materials it
 * came from), what each stage found (with its screenshots in place), where it stands, and what comes
 * next. What waits for the owner is on top, answered with a button, a sentence, or in a conversation.
 */
type Detail = { item: { id: string; title: string; detail: string; spaceId: string; userId: string; status: string; dueAt: string | null; waitingOn: string | null }; materials?: Material[] };
type Shot = StageTest["artifacts"][number];
type Stage = FlowStage;

const route = useRoute(), router = useRouter();
const spaceName = (sid: string) => state.spaces.find((s) => s.id === sid)?.name ?? sid;
const id = computed(() => String(route.params.id ?? ""));
const detail = ref<Detail | null>(null), flow = ref<FlowView | null>(null);
const loading = ref(true), error = ref("");
let seq = 0;

async function load() {
  const n = ++seq, item = id.value;
  try {
    const [d, f] = await Promise.all([get<Detail>(`/api/items/${item}`), get<FlowView>(`/api/items/${item}/flow`)]);
    if (n === seq) { detail.value = d; flow.value = f; error.value = ""; }
  } catch (e) { if (n === seq) error.value = (e as Error).message; }
  finally { if (n === seq) loading.value = false; }
}
watch(id, () => { detail.value = null; flow.value = null; loading.value = true; void load(); }, { immediate: true });
const off = onServerEvent((e) => { if (e.type === "changed" && e.entity === "item" && e.id === id.value) void load(); });
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++seq; off(); resync(); });

const item = computed(() => detail.value?.item);
const editable = computed(() => !!item.value && (!state.me || item.value.userId === state.me.id));
const stages = computed(() => (flow.value?.stages ?? []) as Stage[]);
const ended = computed(() => !!flow.value?.flow?.endedAt);
const waiting = computed(() => ended.value ? [] : stages.value.filter((s) => ownerTurn(s) || s.state === "blocked"));
const current = computed(() => waiting.value[0] ?? stages.value.find((s) => ["doing", "stale"].includes(s.state)) ?? stages.value.find((s) => ["pending", "gated"].includes(s.state)));
/** Stages that have something to tell: done, being done, stuck, or skipped with a reason. */
const told = computed(() => stages.value.filter((s) => s.state !== "pending" && (s.result || s.note || s.tests?.length || s.shots?.length || ["done", "doing", "blocked", "stale"].includes(s.state))));
const upcoming = computed(() => ended.value ? [] : stages.value.filter((s) => ["pending", "gated"].includes(s.state) && !waiting.value.includes(s)));
const text = (s: Stage) => s.result || s.note;
const images = (list: Shot[] | undefined) => (list ?? []).filter((a) => a.kind === "image");
const others = (list: Shot[] | undefined) => (list ?? []).filter((a) => a.kind !== "image");
const when = (s: Stage) => s.doneAt ? `${fmtTime(s.doneAt)} 完成` : s.enteredAt ? `${relTime(s.enteredAt)}开始` : "";
const dot = (s: Stage) => s.state === "done" ? "ok" : ownerTurn(s) || s.state === "blocked" ? "warn" : s.state === "doing" ? "accent" : "quiet";
const sources = computed(() => (detail.value?.materials ?? []).filter((m) => !m.missing));
const refLabel = (r: string, i: number) => r.startsWith("src:") ? `原件 ${i + 1}` : r.startsWith("design:") ? "方案" : r.startsWith("code-work:") ? "编码交办" : `运行 ${i + 1}`;

/** Take the stage into a conversation: the assistant gets the item and stage to read, the owner writes the rest. */
function discuss(s?: Stage) {
  const i = item.value!;
  const head = s ? `关于事项「${i.title}」（${i.id}）流程里的「${s.name}」（${stageWords[s.state]}）` : `关于事项「${i.title}」（${i.id}）`;
  const said = s && text(s) ? `\n\n> ${text(s).slice(0, 600).replace(/\n+/g, "\n> ")}` : "";
  void router.push({ path: "/ask", query: { draft: `${head}${said}\n\n`, space: i.spaceId } });
}
function openMaterial(m: Material) {
  if (m.kind === "run") return void router.push(`/runs/${m.ref}`);
  if (m.kind === "req") return void router.push(`/reqs/${m.ref}`);
  if (m.kind === "conversation") return void router.push(`/ask/${m.ref}`);
  if (m.kind === "source" && m.readable) openCitation({ kind: "source", id: m.ref }, true);
}
function jump(stage: string) {
  document.getElementById(`stage-${stage}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function openRef(r: string) {
  const a = refAction(r);
  if (a) return a();
  const link = evidenceLink(r);
  if (link) location.hash = link.slice(1);
}
</script>

<template>
  <div class="page flow-page">
    <nav class="crumbs small muted"><router-link to="/items">事项</router-link><span>/</span><router-link to="/board">流程</router-link></nav>
    <Skeleton v-if="loading" variant="text" :rows="6" />
    <p v-else-if="error && !item" class="error" role="alert">{{ error }}</p>
    <template v-else-if="item">
      <header class="head">
        <h1>{{ item.title }}</h1>
        <div class="meta small muted row wrap">
          <span v-if="flow?.flow">{{ flow.flow.name }}</span>
          <span v-if="current">· 现在在「{{ current.name }}」，{{ stageWords[current.state] }}</span>
          <span v-if="ended">· 流程已结束</span>
          <span v-if="item.spaceId !== 'personal'" class="badge">{{ spaceName(item.spaceId) }}</span>
          <span class="spacer" />
          <button type="button" class="btn ghost sm" @click="discuss()"><Icon name="chat" :size="14" />在对话里讨论</button>
          <router-link :to="`/items/${item.id}`" class="btn ghost sm">事项详情</router-link>
        </div>
        <ol v-if="stages.length" class="strip" aria-label="阶段">
          <li v-for="s in stages" :key="s.id" :class="dot(s)"><a :href="`#stage-${s.id}`" @click.prevent="jump(s.id)">{{ s.name }}</a><span class="muted">{{ stageWords[s.state] }}</span></li>
        </ol>
      </header>

      <p v-if="!flow?.flow" class="muted">这件事没有在走流程。<router-link :to="`/items/${item.id}`">到事项里开始一个</router-link></p>
      <p v-if="error" class="error small" role="alert">{{ error }}</p>

      <FlowWaiting :item="{ id: item.id, title: item.title, spaceId: item.spaceId }" :flow="flow" :editable="editable" @changed="(v) => (v ? (flow = v) : load())" />

      <!-- A study's directions, trials and findings: where its directions are chosen ("在下面的……里选一个"). -->
      <ItemStudy v-if="flow?.flow?.study" class="study" :item-id="item.id" :editable="editable" :choosing="!ended && stages.some((s) => s.asking === 'direction')" />

      <article class="article">
        <section v-if="item.detail" class="chapter">
          <h2>背景</h2>
          <Markdown :source="item.detail" class="prose" />
        </section>

        <section v-for="s in told" :id="`stage-${s.id}`" :key="s.id" class="chapter">
          <h2><span class="dot" :class="dot(s)" />{{ s.name }}<span class="when muted small">{{ stageWords[s.state] }}{{ when(s) ? ` · ${when(s)}` : "" }}{{ s.attempt > 1 ? ` · 第 ${s.attempt} 次` : "" }}</span></h2>
          <Markdown v-if="text(s)" :source="text(s)" class="prose" />
          <p v-else class="muted">{{ s.state === "doing" ? "正在做，还没写结果。" : "没有写结果。" }}</p>
          <figure v-for="a in images(s.shots)" :key="a.id" class="shot">
            <a :href="a.url" target="_blank" rel="noopener noreferrer"><img :src="a.url" :alt="a.caption || a.name" loading="lazy" /></a>
            <figcaption>{{ a.caption || a.name }}</figcaption>
          </figure>
          <RunArtifacts v-if="others(s.shots).length" :items="others(s.shots)" />
          <div v-for="t in s.tests ?? []" :key="t.id" class="case">
            <h3><span class="dot" :class="t.status === 'passed' ? 'ok' : t.status === 'failed' ? 'warn' : 'quiet'" />{{ t.name }}<span class="when muted small">{{ testWords[t.status] }}</span></h3>
            <Markdown v-if="t.note" :source="t.note" class="prose" />
            <figure v-for="a in images(t.artifacts)" :key="a.id" class="shot">
              <a :href="a.url" target="_blank" rel="noopener noreferrer"><img :src="a.url" :alt="a.caption || a.name" loading="lazy" /></a>
              <figcaption>{{ a.caption || a.name }}</figcaption>
            </figure>
            <RunArtifacts v-if="others(t.artifacts).length" :items="others(t.artifacts)" />
          </div>
          <p v-if="s.evidence.length || s.object || s.carrier.link" class="refs small muted">
            依据：
            <a v-if="s.object" :href="s.object.link">{{ s.object.title }}（{{ s.object.statusLabel ?? s.object.status }}）</a>
            <a v-else-if="s.carrier.link" :href="s.carrier.link">这一段的运行</a>
            <a v-for="(r, i) in s.evidence" :key="r" href="#" :title="r" @click.prevent="openRef(r)">{{ refLabel(r, i) }}</a>
          </p>
        </section>

        <section v-if="upcoming.length" class="chapter">
          <h2>接下来</h2>
          <ol class="next">
            <li v-for="s in upcoming" :key="s.id"><strong>{{ s.name }}</strong><span class="muted">（{{ s.carrier.label }}{{ s.gate === "confirm" || s.state === "gated" ? "，开始前问你" : "" }}）</span><span v-if="s.instruction">：{{ s.instruction }}</span></li>
          </ol>
        </section>

        <section v-if="sources.length" class="chapter">
          <h2>来源</h2>
          <p class="muted small">这件事的材料，判断都应能在这里对上。</p>
          <ul class="sources">
            <li v-for="m in sources" :key="m.id">
              <a v-if="m.readable && m.kind !== 'repo' && m.kind !== 'space'" href="#" @click.prevent="openMaterial(m)">{{ m.title || m.label }}</a>
              <span v-else>{{ m.kind === "repo" ? `${spaceName(m.meta.space ?? m.ref)} · ${m.meta.branch ?? "当前检出"}` : m.title || m.label }}</span>
              <span v-if="m.changed" class="badge warn">有更新</span>
              <span v-if="m.meta.note" class="muted small"> — {{ m.meta.note }}</span>
            </li>
          </ul>
        </section>

        <details v-if="flow?.log.length" class="chapter log">
          <summary>流程记录（{{ flow.log.length }} 条）</summary>
          <ol>
            <li v-for="l in flow.log.slice(0, 60)" :key="l.id" class="small"><span class="muted">{{ fmtTime(l.at) }}</span> {{ stages.find((s) => s.id === l.stageId)?.name ?? l.stageId }}：{{ stageWords[l.toState] }}<span v-if="l.note" class="muted"> — {{ l.note.slice(0, 160) }}</span></li>
          </ol>
        </details>
      </article>
    </template>
  </div>
</template>

<style scoped>
.flow-page { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; display: grid; gap: 20px; }
.crumbs { display: flex; gap: 6px; }
.head h1 { font-family: var(--serif); font-size: 26px; line-height: 1.3; margin: 0 0 6px; overflow-wrap: anywhere; }
.meta { gap: 6px; align-items: center; }
.strip { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; padding: 0; margin: 12px 0 0; }
.strip li { display: flex; gap: 6px; align-items: baseline; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); font-size: 13px; }
.strip li.ok { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
.strip li.warn { border-color: var(--warn); background: var(--warn-soft); }
.strip li.accent { border-color: var(--accent); }
.strip a { color: inherit; text-decoration: none; }
.study { margin: 6px 0 22px; }
.article { display: grid; gap: 28px; }
.chapter h2 { font-family: var(--serif); font-size: 19px; margin: 0 0 8px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.chapter h3 { font-size: 15px; margin: 14px 0 6px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.when { font-family: var(--sans); font-weight: normal; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; align-self: center; }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.accent { background: var(--accent); }
.prose { line-height: 1.75; overflow-wrap: anywhere; }
.shot { margin: 12px 0; }
.shot img { display: block; max-width: 100%; max-height: 560px; border: 1px solid var(--line); border-radius: 6px; }
.shot figcaption { font-size: 13px; color: var(--muted); margin-top: 4px; }
.case { border-left: 2px solid var(--line); padding-left: 12px; }
.refs { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 10px; }
.next { padding-left: 20px; display: grid; gap: 6px; margin: 0; }
.sources { padding-left: 20px; display: grid; gap: 4px; margin: 0; overflow-wrap: anywhere; }
.log summary { cursor: pointer; color: var(--muted); }
.log ol { padding-left: 18px; display: grid; gap: 2px; }
</style>
