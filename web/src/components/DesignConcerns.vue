<script setup lang="ts">
import Markdown from "./Markdown.vue";
import { refAction } from "../lib/refs";
import { LEVEL_CLS, LEVEL_LABELS, STATE_LABELS, type Concern, type ConcernState } from "../lib/designs";

/**
 * A design's concerns (on one decision or on the whole design): level, text, where, grounds and state.
 * `editable`: the current version, where each can be marked resolved / not taken / reopened.
 */
defineProps<{ concerns: Concern[]; editable: boolean; space: string; runId?: string }>();
const emit = defineEmits<{ mark: [concern: Concern, state: ConcernState] }>();
const byText = (by?: string) => (!by ? "" : by === "owner" ? "你" : by);
</script>

<template>
  <div class="concerns">
    <div v-for="c in concerns" :key="c.id" class="concern" :class="{ closed: c.state !== 'open' }">
      <div class="row wrap ch">
        <span class="badge" :class="LEVEL_CLS[c.level]">{{ LEVEL_LABELS[c.level] }}</span>
        <span class="mono muted small">{{ c.id }}</span>
        <span v-if="c.state !== 'open'" class="badge">{{ STATE_LABELS[c.state] }}<template v-if="c.by"> · {{ byText(c.by) }}</template></span>
        <span class="spacer" />
        <template v-if="editable">
          <template v-if="c.state === 'open'">
            <button class="lnk small" @click="emit('mark', c, 'resolved')">已解决</button>
            <button class="lnk small" @click="emit('mark', c, 'dropped')">不采纳</button>
          </template>
          <button v-else class="lnk small" @click="emit('mark', c, 'open')">重新打开</button>
        </template>
      </div>
      <Markdown class="small" :source="c.text" :space="space" :run-id="runId" />
      <div v-if="c.where?.length || c.refs?.length" class="small muted where">
        <template v-if="c.where?.length">位置：<template v-for="(w, i) in c.where" :key="w"><a v-if="refAction(w, runId)" href="#" class="mono" @click.prevent="refAction(w, runId)!()">{{ w }}</a><span v-else class="mono">{{ w }}</span>{{ i < c.where.length - 1 ? "、" : "" }}</template></template>
        <template v-if="c.refs?.length"><span v-if="c.where?.length"> · </span>依据：<template v-for="(r, i) in c.refs" :key="r"><a v-if="refAction(r, runId)" href="#" class="mono" @click.prevent="refAction(r, runId)!()">{{ r }}</a><span v-else class="mono">{{ r }}</span>{{ i < c.refs.length - 1 ? "、" : "" }}</template></template>
      </div>
      <p v-if="c.note" class="small muted note">说明：{{ c.note }}</p>
    </div>
  </div>
</template>

<style scoped>
.concerns { display: grid; gap: 8px; min-width: 0; }
.concern { display: grid; gap: 4px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.concern.closed { opacity: 0.65; }
.ch { gap: 6px; }
.where { overflow-wrap: anywhere; }
.note { margin: 0; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; }
</style>
