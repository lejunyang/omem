<script setup lang="ts">
import { computed } from "vue";
import { SKILL_LABEL, type Snapshot } from "./types";

/** Levels, the last 14 days and what to work on, from english_snapshot. */
const props = defineProps<{ snap: Snapshot | null }>();
const peak = computed(() => Math.max(1, ...(props.snap?.daily ?? []).map((d) => d.count)));
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const width = (rating: number) => `${Math.max(4, Math.min(100, ((rating - 600) / 900) * 100))}%`;
</script>

<template>
  <aside class="progress card" aria-label="学习情况">
    <template v-if="snap">
      <div class="row">
        <h3>学习情况</h3>
        <span class="spacer" />
        <span class="small muted">共 {{ snap.total }} 题 · 今天 {{ snap.today }}</span>
      </div>
      <ul class="skills">
        <li v-for="s in snap.skills" :key="s.skill" :title="`分数 ${s.rating}，近 7 天正确率 ${pct(s.last7)}，之前 ${pct(s.before)}`">
          <span class="name">{{ SKILL_LABEL[s.skill] ?? s.skill }}</span>
          <span class="bar"><i v-if="s.attempts" :style="{ width: width(s.rating) }" /></span>
          <span class="level">{{ s.attempts ? s.level : "—" }}</span>
        </li>
      </ul>
      <div>
        <p class="small muted">近 14 天</p>
        <div class="days" role="img" :aria-label="`近 14 天每天题数：${snap.daily.map((d) => d.count).join('、')}`">
          <span v-for="d in snap.daily" :key="d.date" class="day" :title="`${d.date}：${d.count} 题，正确率 ${pct(d.accuracy)}`">
            <i :style="{ height: `${(d.count / peak) * 100}%`, opacity: d.accuracy === null ? 0.25 : 0.35 + d.accuracy * 0.65 }" />
          </span>
        </div>
      </div>
      <div v-if="snap.weak.length">
        <p class="small muted">薄弱点</p>
        <p class="points">
          <span v-for="w in snap.weak.slice(0, 8)" :key="w.point" class="tag" :title="`见过 ${w.seen} 次，正确率 ${pct(w.accuracy)}`">{{ w.point.replace(/^[a-z]+:/, "") }}</span>
        </p>
      </div>
      <p v-if="snap.due.length" class="small muted">该复习 {{ snap.due.length }} 个知识点</p>
      <p v-if="!snap.total" class="small muted">做完第一组后，这里会显示各项水平和每天的练习量。</p>
    </template>
    <p v-else class="small muted">读取学习情况…</p>
  </aside>
</template>

<style scoped>
.progress {
  padding: 14px 16px;
  display: grid;
  gap: 12px;
  align-content: start;
}
h3 {
  font-size: 15px;
}
.skills {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.skills li {
  display: grid;
  grid-template-columns: 3em 1fr 2.2em;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--sunken);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
}
.level {
  text-align: right;
  font-weight: 600;
  color: var(--ink-2);
}
.days {
  display: grid;
  grid-template-columns: repeat(14, 1fr);
  gap: 3px;
  height: 44px;
  align-items: end;
  margin-top: 4px;
}
.day {
  height: 100%;
  display: flex;
  align-items: flex-end;
  background: var(--sunken);
  border-radius: 2px;
}
.day i {
  display: block;
  width: 100%;
  background: var(--accent);
  border-radius: 2px;
  min-height: 0;
}
.points {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
</style>
