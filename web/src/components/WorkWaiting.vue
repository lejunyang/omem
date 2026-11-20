<script setup lang="ts">
import { computed, ref } from "vue";
import { post, type Ask } from "../api";
import AskCard from "./AskCard.vue";
import Icon from "./Icon.vue";
import { itemKindLabel, relTime, toast } from "../store";
import { duration } from "../lib/flow";
import { changeTone, changeTypeLabel, type ChangeLite, type GateLite, type ItemLite } from "../lib/work";

/**
 * Everything waiting for the owner, in one place (GET /api/work `waiting`): questions and approvals,
 * flow stages at a gate or on the owner's own step, changes not settled yet, items the assistant made
 * on its own, and reply drafts waiting in Feishu. Each is answered where it stands.
 */
export type Waiting = { total: number; asks: Ask[]; gates: GateLite[]; candidates: ItemLite[]; changes: ChangeLite[]; drafts: number };
const props = defineProps<{ waiting: Waiting }>();
const emit = defineEmits<{ changed: []; change: [c: ChangeLite] }>();
const askIds = computed(() => new Set(props.waiting.asks.map((a) => a.id)));
/** A gate whose card is already among the questions is answered there. */
const gates = computed(() => props.waiting.gates.filter((g) => !g.askId || !askIds.value.has(g.askId)));
/** Changes with a pending card are answered on the card (item-follow); the rest are listed. */
const changes = computed(() => (props.waiting.asks.some((a) => a.handler === "item-follow") ? [] : props.waiting.changes));
const deciding = ref<string | null>(null);
async function decide(i: ItemLite, keep: boolean) {
  deciding.value = i.id;
  try {
    await post(`/api/items/${i.id}/candidate`, { keep });
    toast(keep ? `已留下「${i.title}」` : `不要了「${i.title}」`, "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    deciding.value = null;
  }
}
async function dismiss(a: Ask) {
  await post(`/api/asks/${a.id}/dismiss`, {}).catch(() => null);
  emit("changed");
}
const nothing = computed(() => !props.waiting.asks.length && !gates.value.length && !changes.value.length && !props.waiting.candidates.length && !props.waiting.drafts);
</script>

<template>
  <section id="work-waiting" class="waiting" aria-labelledby="waiting-title">
    <h2 id="waiting-title" class="head">
      <span>需要你处理</span>
      <span v-if="waiting.total" class="pill">共 {{ waiting.total }} 条</span>
    </h2>
    <div v-if="nothing" class="calm"><Icon name="check" :size="16" /><span>没有等你的。问题、流程关卡、没定的变化和候选事项会出现在这里。</span></div>

    <div v-for="a in waiting.asks" :key="a.id" class="ask">
      <AskCard :ask="a" @answered="emit('changed')" />
      <div class="row small">
        <router-link v-if="a.conversationId" :to="`/ask/${a.conversationId}`" class="muted">打开对话</router-link>
        <button v-if="!a.handler" type="button" class="lnk small muted" @click="dismiss(a)">不用了</button>
      </div>
    </div>

    <div v-if="gates.length" class="group">
      <h3>流程里等你的</h3>
      <router-link v-for="g in gates" :key="`${g.itemId}-${g.stage.id}`" :to="`/work/${g.itemId}`" class="li">
        <Icon :name="g.stage.state === 'blocked' ? 'alert' : 'flag'" :size="15" class="warn" />
        <span class="grow"><span class="t">{{ g.title }}</span><span class="m">{{ g.flowName }} · {{ g.stage.name }} · {{ g.stage.state === "blocked" ? "卡住" : "等你" }} {{ duration(g.since) }}</span></span>
      </router-link>
    </div>

    <div v-if="changes.length" class="group">
      <h3>没定的变化</h3>
      <button v-for="c in changes" :key="c.id" type="button" class="li" @click="emit('change', c)">
        <span class="dot" :class="changeTone(c.type)" />
        <span class="grow"><span class="t">{{ c.summary }}</span><span class="m">{{ changeTypeLabel[c.type] ?? c.type }} · {{ c.lineTitle }} · {{ relTime(c.at) }}</span></span>
      </button>
    </div>

    <div v-if="waiting.candidates.length" class="group">
      <h3>可能要跟的</h3>
      <div v-for="i in waiting.candidates" :key="i.id" class="cand">
        <router-link :to="`/items/${i.id}`" class="t">{{ i.title }}</router-link>
        <span class="m">{{ itemKindLabel[i.kind] ?? i.kind }} · {{ relTime(i.updatedAt) }}</span>
        <span class="row acts">
          <button class="btn sm" :disabled="deciding === i.id" @click="decide(i, true)">留下</button>
          <button class="btn sm ghost" :disabled="deciding === i.id" @click="decide(i, false)">不要</button>
        </span>
      </div>
    </div>

    <p v-if="waiting.drafts" class="drafts small"><Icon name="send" :size="14" />{{ waiting.drafts }} 条回复草稿在飞书里等你点发送</p>
  </section>
</template>

<style scoped>
.waiting { display: grid; gap: 12px; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.head { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 650; }
.pill { font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--warn-soft); color: var(--warn); }
.calm { display: flex; gap: 8px; align-items: flex-start; color: var(--muted); font-size: 13px; }
.calm :deep(svg) { color: var(--ok); flex: none; margin-top: 2px; }
.ask { display: grid; gap: 4px; min-width: 0; }
.group { display: grid; gap: 2px; min-width: 0; }
h3 { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: var(--muted); margin: 4px 0 2px; }
.li { all: unset; box-sizing: border-box; display: flex; gap: 8px; align-items: flex-start; padding: 7px 8px; margin: 0 -8px; border-radius: 8px; cursor: pointer; color: inherit; min-width: 0; text-decoration: none; }
.li:hover { background: var(--hover); text-decoration: none; }
.li:focus-visible { outline: 2px solid var(--accent); }
.li :deep(svg) { flex: none; margin-top: 2px; }
.grow { flex: 1; min-width: 0; display: grid; gap: 1px; }
.t { font-size: 13.5px; line-height: 1.45; color: var(--ink); overflow-wrap: anywhere; }
.m { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.warn { color: var(--warn); }
.dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; border: 2px solid var(--muted); }
.dot.warn { border-color: var(--warn); }
.dot.accent { border-color: var(--accent); }
.dot.ok { border-color: var(--ok); }
.cand { display: grid; gap: 2px; padding: 6px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.cand:last-child { border-bottom: 0; }
.acts { gap: 6px; margin-top: 4px; }
.drafts { display: flex; gap: 6px; align-items: center; color: var(--ink-2); margin: 0; }
</style>
