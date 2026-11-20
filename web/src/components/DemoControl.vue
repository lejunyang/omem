<script setup lang="ts">
/**
 * 「演示」on a 关注 or an item (server: remote/demos.ts): the owner shows how this kind of thing is
 * handled instead of explaining it. Start here, then pick and record in the Chrome extension or just
 * work in Feishu; stopping hands the timeline to the assistant (skill-from-demo), which turns it into
 * lessons here or a skill. One demonstration at a time: one going on elsewhere is shown and can be
 * stopped from here too. Only the owner sees it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { get, post } from "../api";
import { promptDialog } from "../lib/dialog";
import { toast } from "../store";
import Icon from "./Icon.vue";

type Demo = {
  id: string;
  conversationId: string;
  goal: string;
  context: { id: string; name: string } | null;
  item: { id: string; title: string } | null;
  status: "active" | "stopped";
  startedAt: string;
  entries: { recording: number; pick: number; lark: number; remote: number };
};
const props = defineProps<{ contextId?: string; itemId?: string; name: string }>();

const current = ref<Demo | null>(null);
const available = ref(false);
const busy = ref(false);
const stopping = ref(false);
const now = ref(Date.now());
let clock = 0;

async function load() {
  try {
    current.value = (await get<{ current: Demo | null }>("/api/demos")).current;
    available.value = true;
  } catch {
    // Only the owner demonstrates.
    available.value = false;
  }
}
onMounted(() => {
  void load();
  clock = window.setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => clearInterval(clock));
watch(() => [props.contextId, props.itemId], load);

const here = computed(() => !!current.value && ((!!props.contextId && current.value.context?.id === props.contextId) || (!!props.itemId && current.value.item?.id === props.itemId)));
const elsewhere = computed(() => {
  const d = current.value;
  if (!d || here.value) return "";
  return d.context ? `关注「${d.context.name}」` : d.item ? `事项「${d.item.title}」` : "";
});
const elapsed = computed(() => {
  const s = current.value ? Math.max(0, Math.floor((now.value - Date.parse(current.value.startedAt)) / 1000)) : 0;
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
});
const counts = computed(() => {
  const e = current.value?.entries;
  if (!e) return "";
  const parts = [e.recording + e.remote ? `录制 ${e.recording + e.remote}` : "", e.pick ? `拾取 ${e.pick}` : "", e.lark ? `飞书 ${e.lark} 段` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "还没有记下东西";
});
/** Linked to something (here or elsewhere): lessons first; otherwise a skill. */
const choices = computed(() => {
  const d = current.value;
  const linked = !!(d?.context || d?.item);
  return [
    ...(linked ? [{ value: "lessons", label: "整理成经验" }] : []),
    { value: "skill", label: "整理成技能" },
    { value: "none", label: "只结束" },
  ] as { value: "lessons" | "skill" | "none"; label: string }[];
});

async function start() {
  const goal = await promptDialog("开始演示", {
    message: `把「${props.name}」里的一类事做给助手看：开始后在 Chrome 扩展里拾取、录制，或者直接在飞书里照常处理；结束时助手把这一段整理成经验或技能，先跟你确认。`,
    placeholder: "要教什么，例如：有人报退款失败时怎么查",
    okText: "开始",
  });
  if (!goal?.trim()) return;
  busy.value = true;
  try {
    current.value = await post<Demo>("/api/demos", { goal, ...(props.contextId ? { contextId: props.contextId } : {}), ...(props.itemId ? { itemId: props.itemId } : {}) });
    toast("开始演示了：拾取、录制和你在飞书里发的消息都会记进来");
  } catch (e) {
    toast((e as Error).message, "error");
    await load();
  } finally {
    busy.value = false;
  }
}

async function stop(organize: "lessons" | "skill" | "none") {
  const d = current.value;
  if (!d) return;
  busy.value = true;
  try {
    await post(`/api/demos/${encodeURIComponent(d.id)}/stop`, { organize });
    current.value = null;
    stopping.value = false;
    toast(organize === "none" ? "演示结束了" : "演示结束了，助手在整理，会先跟你确认");
  } catch (e) {
    toast((e as Error).message, "error");
    await load();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="available" class="demo-control row wrap small" :class="{ live: current }">
    <template v-if="current">
      <span class="dot" aria-hidden="true" />
      <strong>演示中</strong>
      <span class="goal" :title="current.goal">{{ current.goal }}</span>
      <span v-if="elsewhere" class="muted">（{{ elsewhere }}）</span>
      <span class="muted mono">{{ elapsed }}</span>
      <span class="muted">· {{ counts }}</span>
      <span class="spacer" />
      <router-link :to="`/ask/${current.conversationId}`">对话</router-link>
      <template v-if="stopping">
        <button v-for="(c, i) in choices" :key="c.value" type="button" class="btn sm" :class="i === 0 ? 'accent' : 'ghost'" :disabled="busy" @click="stop(c.value)">{{ c.label }}</button>
        <button type="button" class="btn ghost sm" :disabled="busy" @click="stopping = false">接着演示</button>
      </template>
      <button v-else type="button" class="btn sm" @click="stopping = true">结束演示</button>
    </template>
    <template v-else>
      <button type="button" class="btn ghost sm" :disabled="busy" title="把这类事做给助手看，结束时整理成经验或技能" @click="start"><Icon name="play" :size="13" />开始演示</button>
      <span class="muted">做一遍给助手看，比写说明快</span>
    </template>
  </div>
</template>

<style scoped>
.demo-control {
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.demo-control.live {
  padding: 6px 10px;
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
}
.demo-control.live strong {
  color: var(--accent);
}
.goal {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.mono {
  font-variant-numeric: tabular-nums;
}
.spacer {
  flex: 1;
}
</style>
