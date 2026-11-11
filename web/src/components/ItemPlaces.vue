<script setup lang="ts">
import Icon from "./Icon.vue";
import { openCitation, relTime } from "../store";

/**
 * Where one piece of work goes on (src/items/places.ts): the conversations and group chats linked to the
 * item, each with its latest activity and the last thing said or summarized there, and the runs working
 * on it right now. Links are materials (conversation / chat source): they are removed in 材料.
 */
export type Place = { kind: "conversation" | "source"; ref: string; title: string; lastAt: string | null; summary: string };
export type ItemRun = { id: string; kind: string; title: string; status: string; startedAt: string | null; conclusion: string; via: "item" | "place" };
defineProps<{ places: Place[]; runs: ItemRun[] }>();
</script>

<template>
  <div v-if="places.length || runs.length" class="places">
    <div class="section-title">在这些会话里进行</div>
    <div v-for="p in places" :key="`${p.kind}:${p.ref}`" class="p">
      <div class="prow">
        <Icon :name="p.kind === 'conversation' ? 'chat' : 'user'" :size="13" class="muted" />
        <router-link v-if="p.kind === 'conversation'" :to="`/ask/${p.ref}`" class="t ellipsis" :title="p.title">{{ p.title }}</router-link>
        <a v-else href="#" class="t ellipsis" :title="p.title" @click.prevent="openCitation({ kind: 'source', id: p.ref }, true)">{{ p.title }}</a>
        <span v-if="p.lastAt" class="muted small when">{{ relTime(p.lastAt) }}</span>
      </div>
      <div v-if="p.summary" class="muted small clamp">{{ p.summary }}</div>
    </div>
    <div v-if="runs.length" class="muted small gt">正在进行的运行</div>
    <div v-for="r in runs" :key="r.id" class="p">
      <div class="prow">
        <span class="badge" :class="r.status === 'running' ? 'accent' : ''">{{ r.status === "running" ? "进行中" : "排队中" }}</span>
        <router-link :to="`/runs/${r.id}`" class="t ellipsis" :title="r.title">{{ r.title }}</router-link>
        <span v-if="r.startedAt" class="muted small when">{{ relTime(r.startedAt) }}开始</span>
      </div>
      <div v-if="r.conclusion" class="muted small clamp">{{ r.conclusion }}</div>
    </div>
  </div>
</template>

<style scoped>
.places { display: grid; gap: 6px; }
.p { display: grid; gap: 2px; padding: 2px 0; min-width: 0; }
.prow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.t { flex: 1; min-width: 0; }
.when { flex: none; }
.gt { margin-top: 4px; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
