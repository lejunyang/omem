<script setup lang="ts">
import { computed, ref } from "vue";
import MaterialLink from "./MaterialLink.vue";
import type { Lesson } from "./types";

/**
 * A day's lesson on the start page: its theme, the expressions it teaches (each with where it came
 * from), and two ways in — the questions (drawn at once, no model wait) and the speaking scene.
 */
const props = defineProps<{ lesson: Lesson; today: string; busy: boolean; voiceReady: boolean }>();
defineEmits<{ quiz: []; speaking: [] }>();

const SHOWN = 5;
const all = ref(false);
const shown = computed(() => (all.value ? props.lesson.expressions : props.lesson.expressions.slice(0, SHOWN)));
const day = computed(() => (props.lesson.date === props.today ? "今日学习" : `${props.lesson.date.slice(5).replace("-", " 月 ")} 日的学习`));
</script>

<template>
  <section class="lesson card" :aria-label="`${day}：${lesson.theme}`">
    <header class="head">
      <span class="kicker small">{{ day }}</span>
      <h2>{{ lesson.theme }}</h2>
    </header>
    <ul class="expr">
      <li v-for="(e, i) in shown" :key="i">
        <span class="en">{{ e.en }}</span>
        <span class="zh muted">{{ e.zh }}</span>
        <MaterialLink v-if="e.material" class="from" :material="e.material" />
      </li>
    </ul>
    <button v-if="lesson.expressions.length > SHOWN" type="button" class="more small" :aria-expanded="all" @click="all = !all">{{ all ? "收起" : `还有 ${lesson.expressions.length - SHOWN} 个说法` }}</button>
    <div class="ways">
      <div class="way">
        <button class="btn primary sm" type="button" :disabled="busy" @click="$emit('quiz')">做这组题</button>
        <span class="small muted">{{ lesson.items }} 题，练上面这些说法</span>
      </div>
      <div class="way">
        <button class="btn sm" type="button" :disabled="busy || !voiceReady" :title="voiceReady ? undefined : '语音模型还没配好'" @click="$emit('speaking')">练口语</button>
        <span class="small muted scene">{{ lesson.speaking.scene }}<template v-if="lesson.speaking.material"> · <MaterialLink :material="lesson.speaking.material" /></template></span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.lesson {
  padding: 18px 20px;
  display: grid;
  gap: 12px;
  border-left: 3px solid var(--accent);
}
.head {
  display: grid;
  gap: 2px;
}
.kicker {
  color: var(--accent);
  font-weight: 600;
  letter-spacing: 0.02em;
}
.head h2 {
  font-size: 18px;
  overflow-wrap: anywhere;
}
.expr {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.expr li {
  display: grid;
  gap: 1px;
  min-width: 0;
  padding-left: 10px;
  border-left: 2px solid var(--line);
}
.en {
  font-family: var(--serif);
  font-size: 15.5px;
  overflow-wrap: anywhere;
}
.zh {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.from {
  font-size: 12px;
}
.more {
  justify-self: start;
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
}
.ways {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 24px;
}
.way {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.scene {
  overflow-wrap: anywhere;
}
</style>
