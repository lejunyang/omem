<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { put } from "../api";
import Icon from "./Icon.vue";
import Markdown from "./Markdown.vue";
import { fmtTime, toast } from "../store";
import { changeTone, changeTypeLabel, nextKindLabel, nextStatusLabel, originLabel, otherRefs, refsMarkdown, type ChangeLite, type NextLite } from "../lib/work";

/**
 * One key change or one next step, opened from a timeline on the side: what it is, why, what it
 * risks and what comes next, the sources it came from (citations open over it), and what the owner
 * can do with it — 对我没用 for a change (it leaves the timeline; the follow-up learns from it),
 * 就这么做 / 不用 for a next step. Esc closes it (after an open citation), focus goes back.
 */
const props = defineProps<{ change?: ChangeLite | null; next?: NextLite | null; lineTitle?: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const panel = ref<HTMLElement>();
const opener = document.activeElement as HTMLElement | null;
const busy = ref(false);

function onKey(e: KeyboardEvent) {
  // An open citation over the sheet takes Esc first (it prevents the default).
  if (e.key === "Escape" && !e.defaultPrevented) {
    e.preventDefault();
    emit("close");
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  void nextTick(() => panel.value?.focus());
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  opener?.focus?.();
});

const c = computed(() => props.change ?? null);
const n = computed(() => props.next ?? null);
const refs = computed(() => (c.value?.refs ?? n.value?.refs ?? []));
const cited = computed(() => refsMarkdown(refs.value));
/** References that are not citations: an item or a run by its title, linked; anything unknown as text. */
const others = computed(() => otherRefs(refs.value, c.value?.refTargets ?? n.value?.refTargets));

async function noise(on: boolean) {
  if (!c.value) return;
  busy.value = true;
  try {
    await put(`/api/item-changes/${c.value.id}/noise`, { noise: on });
    toast(on ? "已从时间线拿掉，以后少记这类" : "已放回时间线", "ok");
    emit("changed");
    emit("close");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
async function decide(status: "doing" | "declined" | "done") {
  if (!n.value) return;
  busy.value = true;
  try {
    const r = await put<NextLite>(`/api/item-next/${n.value.id}`, { status });
    if (status === "doing") toast("已开始做这一步，做完在这条线的会话里告诉你", "ok", r.runId ? `#/runs/${r.runId}` : undefined);
    else toast(status === "declined" ? "不做这一步，以后少提这类" : "记为做完", "ok");
    emit("changed");
    emit("close");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="scrim" @click="emit('close')" />
    <aside ref="panel" class="sheet" role="dialog" :aria-label="c ? `变化：${c.summary}` : `下一步：${n?.text ?? ''}`" tabindex="-1">
      <header>
        <template v-if="c">
          <span class="tag" :class="changeTone(c.type)">{{ changeTypeLabel[c.type] ?? c.type }}</span>
          <span class="muted small">{{ originLabel[c.origin] ?? c.origin }} · {{ fmtTime(c.at) }}</span>
        </template>
        <template v-else-if="n">
          <span class="tag next">下一步 · {{ nextKindLabel[n.kind] }}</span>
          <span class="muted small">{{ nextStatusLabel[n.status] }} · {{ fmtTime(n.createdAt) }} 提的</span>
        </template>
        <span class="spacer" />
        <button class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="16" /></button>
      </header>

      <div class="body">
        <template v-if="c">
          <h2>{{ c.summary }}</h2>
          <p class="where small muted">
            <router-link :to="`/work/${c.itemId}`" @click="emit('close')">{{ c.itemTitle }}</router-link>
            <template v-if="c.lineId !== c.itemId"> · 在「<router-link :to="`/work/${c.lineId}`" @click="emit('close')">{{ c.lineTitle }}</router-link>」下</template>
          </p>
          <p v-if="c.status === 'asked'" class="asked small">这条变化在等你定：在工作页的“需要你处理”或飞书卡片上选并进、另开还是不用管。</p>
          <section v-if="c.detail"><h3>原因</h3><Markdown :source="c.detail" class="prose" /></section>
          <section v-if="c.risk" class="risk"><h3>风险</h3><p>{{ c.risk }}</p></section>
          <section v-if="c.next"><h3>下一步</h3><p>{{ c.next }}</p></section>
        </template>
        <template v-else-if="n">
          <h2>{{ n.text }}</h2>
          <p v-if="lineTitle" class="where small muted">工作线「<router-link :to="`/work/${n.itemId}`" @click="emit('close')">{{ lineTitle }}</router-link>」</p>
          <section v-if="n.why"><h3>为什么</h3><Markdown :source="n.why" class="prose" /></section>
          <p v-if="n.status === 'doing' && n.runId" class="small"><router-link :to="`/runs/${n.runId}`" @click="emit('close')">看正在做的运行</router-link></p>
        </template>
        <section v-if="refs.length" class="sources">
          <h3>来源</h3>
          <Markdown v-if="cited" :source="cited" class="prose refs" />
          <p v-if="others.length" class="others small">
            <template v-for="o in others" :key="o.r">
              <a v-if="o.link" :href="o.link" :title="o.title" @click="emit('close')">{{ o.label }}</a>
              <span v-else class="mono muted" :title="o.title">{{ o.label }}</span>
            </template>
          </p>
        </section>
      </div>

      <footer v-if="c || n" class="row wrap">
        <template v-if="c">
          <button v-if="!c.noise" class="btn sm" :disabled="busy" @click="noise(true)">对我没用</button>
          <button v-else class="btn sm" :disabled="busy" @click="noise(false)">放回时间线</button>
          <span class="muted small">对我没用的变化从时间线拿掉，以后少记这类。</span>
        </template>
        <template v-else-if="n">
          <template v-if="n.status === 'open' || n.status === 'declined'">
            <button class="btn sm primary" :disabled="busy" @click="decide('doing')">就这么做</button>
            <button v-if="n.status === 'open'" class="btn sm" :disabled="busy" @click="decide('declined')">不用</button>
            <span class="muted small">就这么做：助手在这条线上起一轮去做；不用：以后少提这类。</span>
          </template>
          <template v-else-if="n.status === 'doing'">
            <button class="btn sm" :disabled="busy" @click="decide('done')">记为做完</button>
          </template>
        </template>
      </footer>
    </aside>
  </Teleport>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; background: rgba(10, 12, 16, 0.18); z-index: 38; }
.sheet {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(480px, 100vw);
  background: var(--panel);
  border-left: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  z-index: 39;
  display: flex;
  flex-direction: column;
  outline: none;
}
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 18px; border-bottom: 1px solid var(--line); min-height: 52px; }
.tag { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 999px; background: var(--sunken); color: var(--ink-2); }
.tag.warn { background: var(--warn-soft); color: var(--warn); }
.tag.accent { background: var(--accent-soft); color: var(--accent); }
.tag.ok { background: var(--ok-soft); color: var(--ok); }
.tag.next { border: 1px dashed var(--line-strong); background: none; }
.body { flex: 1; overflow: auto; padding: 18px 20px; display: grid; gap: 16px; align-content: start; grid-template-columns: minmax(0, 1fr); }
h2 { font-family: var(--serif); font-size: 20px; line-height: 1.45; margin: 0; overflow-wrap: anywhere; }
.where { margin: -8px 0 0; overflow-wrap: anywhere; }
h3 { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 4px; }
section p { margin: 0; line-height: 1.7; overflow-wrap: anywhere; }
.risk p { color: var(--warn); }
.asked { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--warn-soft); color: var(--ink-2); }
.refs :deep(p) { margin: 0; }
.others { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 6px 0 0; }
footer { border-top: 1px solid var(--line); padding: 12px 18px; gap: 8px; }
footer .muted { flex: 1 1 200px; min-width: 0; }
</style>
