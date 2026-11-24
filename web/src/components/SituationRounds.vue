<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, post } from "../api";
import { promptDialog } from "../lib/dialog";
import { plainLine } from "../lib/plain";
import type { SituationInstance } from "../lib/listen";
import { fmtTime, relTime, toast } from "../store";
import Icon from "./Icon.vue";
import RichText from "./RichText.vue";
import Skeleton from "./Skeleton.vue";

/**
 * A 情境's rounds (GET /api/situation-instances?contextId=): the ones going on first — what it is about,
 * when it started, how long its window runs, where it stands, its item — then the ended ones with their
 * summary. The owner starts one by hand (what it is about) and ends one going on (a summary, or the last
 * “现状”). `active`: the situation is on (a paused one starts no new round).
 */
const props = defineProps<{ contextId: string; name: string; active: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const list = ref<SituationInstance[] | null>(null);
const error = ref("");
let seq = 0;
async function load() {
  const my = ++seq;
  try {
    const r = await get<SituationInstance[]>(`/api/situation-instances?contextId=${encodeURIComponent(props.contextId)}&limit=100`);
    if (my === seq) (list.value = r), (error.value = "");
  } catch (e) {
    if (my === seq) error.value = (e as Error).message;
  }
}
watch(() => props.contextId, () => ((list.value = null), void load()), { immediate: true });
// A round's run ended, or the server says items changed: what it stands at may have moved.
const off = onServerEvent((e) => {
  if (!list.value?.some((i) => i.status === "active")) return;
  if ((e.type === "run" && ["done", "failed"].includes(e.status)) || (e.type === "changed" && e.entity === "item")) void load();
});
onBeforeUnmount(off);

const going = computed(() => (list.value ?? []).filter((i) => i.status === "active"));
const ended = computed(() => (list.value ?? []).filter((i) => i.status === "ended"));
const ENDED_FIRST = 10;
const allEnded = ref(false);
/** “项目 A 例行演练：11 月这次” → “11 月这次”: the title repeats the situation's name. */
const about = (i: SituationInstance) => plainLine(i.title.startsWith(`${props.name}：`) ? i.title.slice(props.name.length + 1) : i.title, 120);
const windowText = (i: SituationInstance) => (i.closingRun ? "正在收尾" : new Date(i.windowUntil).getTime() < Date.now() ? "窗口到了，等收尾" : `窗口到 ${fmtTime(i.windowUntil)}`);

const busy = ref(false);
async function start() {
  const v = await promptDialog(`开始一回「${props.name}」`, {
    message: "写这一回是关于什么：对象、时间、在哪个群或文档。处理者从这句话开始查清这一回的范围。",
    fields: [{ id: "about", label: "这一回是关于什么", value: "", required: true, maxLength: 2000 }],
    okText: "开始",
  });
  if (!v?.about?.trim()) return;
  busy.value = true;
  try {
    const r = await post<{ instance: SituationInstance; runId: string | null }>(`/api/listen/${encodeURIComponent(props.contextId)}/start`, { about: v.about.trim() });
    toast(r.runId ? "已开始一回，处理者在看了" : "已开始一回", "ok");
    await load();
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
async function end(i: SituationInstance) {
  const v = await promptDialog(`结束这一回？`, {
    message: `「${about(i)}」。写一句小结会进经验；不写就用它最后的现状：${plainLine(i.current, 200) || "（还没有）"}`,
    fields: [{ id: "summary", label: "小结（可不填）", value: "", maxLength: 3000 }],
    okText: "结束",
  });
  if (v === null) return;
  try {
    await post(`/api/situation-instances/${encodeURIComponent(i.id)}/end`, v.summary?.trim() ? { summary: v.summary.trim() } : {});
    toast("这一回结束了", "ok");
    await load();
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
</script>

<template>
  <section class="rounds">
    <div class="bar row wrap">
      <span class="muted small grow">{{ list ? (going.length ? `进行中 ${going.length} 回` : "没有进行中的") + (ended.length ? ` · 结束了 ${ended.length} 回` : "") : "" }}</span>
      <button type="button" class="btn sm" :disabled="busy || !active" :title="active ? '' : '情境停用时不开新的一回'" @click="start"><Icon name="plus" :size="14" />手动开始一回</button>
    </div>
    <p v-if="error" class="err small" role="alert">{{ error }} <button type="button" class="btn ghost sm" @click="load">重试</button></p>
    <Skeleton v-else-if="!list" variant="list" :rows="3" />
    <template v-else>
      <p v-if="!list.length" class="muted empty-line">还没有开始过。认出来时会自动开一回；你也可以手动开始一回，写清这次是关于什么。</p>

      <ul v-if="going.length" class="going">
        <li v-for="i in going" :key="i.id" class="round">
          <div class="r-head">
            <span class="dot" aria-hidden="true" />
            <router-link :to="`/items/${i.itemId}`" class="r-title">{{ about(i) }}</router-link>
          </div>
          <div class="r-meta small muted">
            <span :title="fmtTime(i.startedAt)">{{ relTime(i.startedAt) }}开始</span>
            <span :class="{ warn: !!i.closingRun || new Date(i.windowUntil).getTime() < Date.now() }">{{ windowText(i) }}</span>
          </div>
          <div v-if="i.current" class="r-now"><span class="muted small">现状</span><RichText :text="i.current" :lines="3" :space="i.spaceId" /></div>
          <div class="r-acts row wrap">
            <router-link :to="`/items/${i.itemId}`" class="btn ghost sm">打开事项</router-link>
            <button type="button" class="btn ghost sm" @click="end(i)">结束</button>
          </div>
        </li>
      </ul>

      <div v-if="ended.length" class="ended">
        <h3 class="small muted">结束了的</h3>
        <ul>
          <li v-for="i in allEnded ? ended : ended.slice(0, ENDED_FIRST)" :key="i.id" class="done-row">
            <Icon name="check" :size="14" class="ok" />
            <span class="grow">
              <router-link :to="`/items/${i.itemId}`" class="d-title">{{ about(i) }}</router-link>
              <RichText v-if="i.summary" class="d-sum small" :text="i.summary" :lines="2" :space="i.spaceId" />
            </span>
            <span class="small muted when" :title="i.endedAt ? fmtTime(i.endedAt) : ''">{{ i.endedAt ? `结束 · ${fmtTime(i.endedAt, false)}` : "" }}</span>
          </li>
        </ul>
        <button v-if="!allEnded && ended.length > ENDED_FIRST" type="button" class="lnk small" @click="allEnded = true">再看 {{ ended.length - ENDED_FIRST }} 回</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.rounds {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.bar {
  gap: 8px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.empty-line {
  margin: 0;
}
.going,
.ended ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  min-width: 0;
}
.round {
  display: grid;
  gap: 4px;
  padding: 10px 12px 10px 14px;
  border: 1px solid var(--line);
  border-left: 3px solid color-mix(in srgb, var(--accent) 60%, var(--line));
  border-radius: 10px;
  min-width: 0;
}
.round + .round {
  margin-top: 8px;
}
.r-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}
.r-title {
  font-weight: 600;
  color: var(--ink);
  overflow-wrap: anywhere;
  min-width: 0;
}
.r-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
}
.r-meta .warn {
  color: var(--warn);
}
.r-now {
  display: grid;
  gap: 2px;
  font-size: 13.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.r-acts {
  gap: 6px;
}
.ended {
  display: grid;
  gap: 4px;
}
.ended h3 {
  margin: 4px 0 0;
  font-weight: 600;
}
.done-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 7px 0;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.done-row .ok {
  color: var(--ok);
  flex: none;
  margin-top: 3px;
}
.done-row .grow {
  display: grid;
  gap: 1px;
}
.d-title {
  color: var(--ink);
  font-size: 14px;
  overflow-wrap: anywhere;
}
.d-sum {
  color: var(--ink-2);
}
.when {
  flex: none;
  white-space: nowrap;
}
.lnk {
  justify-self: start;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}
.err {
  color: var(--danger);
  margin: 0;
}
@media (max-width: 560px) {
  .done-row {
    flex-wrap: wrap;
  }
  .when {
    flex-basis: 100%;
    padding-left: 22px;
  }
}
</style>
