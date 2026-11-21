<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../api";
import { relTime, toast } from "../store";
import Skeleton from "./Skeleton.vue";
import { plainLine } from "../lib/markdown";
import RichText from "./RichText.vue";

/**
 * Nightly replays and their verdicts (src/agents/replay.ts): each past question answered again as of
 * its time, a baseline against one changed axis. Suggestions that wait for the owner (source levels,
 * imports) are adopted or ignored here or on the morning card.
 */
type Effect = { id: string; effect: string; targetKind: string; targetId: string | null; note: string; status: string };
type Replay = { id: string; at: string; status: string; signal: string; axis: string; axisLabel: string; verdict: string | null; verdictLabel: string; taskType: string | null; question: string; reason: string; by: string | null; agree: boolean | null; sameFamily: boolean; runId: string | null; checks: { baseline: string[]; variant: string[] }; effects: Effect[] };
type Status = { enabled: boolean; notice: string | null; judge: { profile: string; model: string | null } | null };

const SIGNAL: Record<string, string> = { negative: "负面表情", correction: "本人纠正", notFound: "没找到", timeout: "超时", slow: "慢", normal: "正常", positive: "正面表情", manual: "手动" };
const list = ref<Replay[] | null>(null);
const status = ref<Status | null>(null);
const failed = ref("");
async function load() {
  try {
    const r = await get<{ status: Status; replays: Replay[] }>("/api/replays?limit=20");
    list.value = r.replays;
    status.value = r.status;
  } catch (e) {
    failed.value = (e as Error).message;
  }
}
onMounted(load);
async function decide(e: Effect, action: "adopt" | "ignore") {
  try {
    const r = await post<{ message: string }>(`/api/replay-effects/${e.id}/${action}`);
    toast(r.message, "ok");
    await load();
  } catch (err) {
    toast((err as Error).message, "error");
  }
}
/** What an effect is about, as a reference the citation drawer opens (no bare ids), then its note. */
function effectText(e: Effect) {
  if (!e.targetId) return e.note;
  const what = e.targetKind === "source" ? `[原件](src:${e.targetId})` : e.targetKind === "memory" ? `[记忆](mem:${e.targetId})` : e.targetKind === "skill" ? `技能 \`${e.targetId}\`` : "";
  return what ? `${what} ${e.note}` : e.note;
}
/** The latest few; the rest behind 再看. */
const SHOWN = 6;
const all = ref(false);
const badge = (v: string | null) => (v === "win" ? "accent" : v === "void" || v === "failed" ? "warn" : "");
</script>

<template>
  <section class="rp">
    <div class="rp-head">
      <h3>夜间复盘</h3>
      <span class="muted small">{{ status?.enabled ? "每晚运行" : "定时已关" }}</span>
      <span class="spacer" />
      <RouterLink class="small" :to="{ path: '/settings', query: { tab: 'agents' } }">设置</RouterLink>
    </div>
    <Skeleton v-if="!list && !failed" :rows="3" />
    <p v-else-if="failed" class="muted small">{{ failed }}</p>
    <template v-else-if="list">
      <p v-if="status?.notice" class="warn small">{{ status.notice }} <RouterLink :to="{ path: '/agents', query: { tab: 'agents', role: 'replay-judge' } }">打开 replay-judge</RouterLink></p>
      <p v-if="!list.length" class="muted small">还没有复盘。打开设置 → 自检与复盘 → 夜间复盘的定时，或点“立即运行”。</p>
      <div v-for="r in all ? list : list.slice(0, SHOWN)" :key="r.id" class="rp-row">
        <div class="rp-line">
          <span class="badge" :class="badge(r.verdict)">{{ r.verdictLabel }}</span>
          <span class="q" :title="plainLine(r.question, 400)">{{ plainLine(r.question, 140) }}</span>
        </div>
        <div class="muted small">
          {{ relTime(r.at) }} · {{ SIGNAL[r.signal] ?? r.signal }} → <span class="mono">{{ r.axis }}</span> {{ r.axisLabel }}<template v-if="r.taskType"> · {{ r.taskType }}</template><template v-if="r.by === 'checks'"> · 由引用检查判定</template><template v-else-if="r.agree === false"> · 两种顺序不一致</template>
          <template v-if="r.runId"> · <RouterLink :to="`/runs/${r.runId}`">运行</RouterLink></template>
        </div>
        <RichText v-if="r.reason" tag="p" class="small reason" :text="r.reason" :run-id="r.runId ?? undefined" :lines="2" />
        <RichText v-for="(c, i) in [...r.checks.baseline.map((x) => `基线：${x}`), ...r.checks.variant.map((x) => `变体：${x}`)]" :key="i" tag="p" class="muted small reason" :text="c" :lines="1" />
        <div v-for="e in r.effects" :key="e.id" class="effect small">
          <span class="grow"><RichText :text="effectText(e)" :lines="2" /></span>
          <template v-if="e.status === 'pending'">
            <button class="btn sm" @click="decide(e, 'adopt')">采纳</button>
            <button class="btn ghost sm" @click="decide(e, 'ignore')">忽略</button>
          </template>
          <span v-else class="muted">{{ { adopted: "已采纳", ignored: "已忽略", applied: "已自动处理", info: "供参考" }[e.status] ?? e.status }}</span>
        </div>
      </div>
      <button v-if="list.length > SHOWN" type="button" class="btn ghost sm more" @click="all = !all">{{ all ? "收起" : `再看 ${list.length - SHOWN} 条` }}</button>
    </template>
  </section>
</template>

<style scoped>
.rp {
  text-align: left;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.rp p {
  margin: 0;
  max-width: none;
  text-align: left;
}
.rp-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rp-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.warn {
  color: var(--warn);
}
.rp-row {
  display: grid;
  gap: 4px;
  padding: 8px 0 4px;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.rp-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
}
.q {
  min-width: 0;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}
.rp-line .badge {
  flex: none;
}
.more {
  justify-self: start;
}
.reason {
  overflow-wrap: anywhere;
}
.effect {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
}
.effect .grow {
  flex: 1 1 200px;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
