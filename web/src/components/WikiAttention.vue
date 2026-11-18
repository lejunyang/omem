<script setup lang="ts">
import { computed, ref } from "vue";
import { relTime } from "../store";
import Icon from "./Icon.vue";

/**
 * The Wiki's "originals changed" dialog, opened from the sidebar: which pages cite an original that
 * changed since they were written, what the automatic check is doing, and a way to check now (all or one).
 */
export type StalePage = { slug: string; sources: { id: string; uri: string; title: string; kind: string; deleted: boolean }[] };
export type Upkeep = { auto: boolean; lastCheck: { id: string; status: string; at: string; auto: boolean } | null; waiting: number; appendOnly: number; running: boolean; nextAt: string | null };

const props = defineProps<{ space: string; pages: StalePage[]; titles: Record<string, string>; upkeep: Upkeep | null }>();
const emit = defineEmits<{ check: [slugs: string[]]; close: [] }>();

const all = ref(false);
const shown = computed(() => (all.value ? props.pages : props.pages.slice(0, 30)));
const name = (s: StalePage["sources"][number]) => (s.title && s.title !== s.uri ? s.title : s.uri.replace(/^https?:\/\//, "").replace(/\/$/, ""));
const status = computed(() => {
  const u = props.upkeep;
  if (!u) return "";
  if (u.running) return "正在检查";
  if (!u.auto) return "自动检查已关闭（在设置 → 空间里打开）";
  const parts = ["自动检查已开"];
  if (u.lastCheck) parts.push(`上次 ${relTime(u.lastCheck.at)}${u.lastCheck.auto ? "" : "（手动）"}`);
  if (u.waiting) parts.push(`${u.waiting} 页等待检查（原件稳定半小时后，同一页一天最多一次）`);
  if (u.appendOnly) parts.push(`${u.appendOnly} 页只是聊天又有了新消息，不自动检查`);
  if (!u.waiting && !u.appendOnly) parts.push("没有页面在等待");
  return parts.join(" · ");
});
const failed = computed(() => props.upkeep?.lastCheck?.status === "failed");
</script>

<template>
  <div class="modal-overlay" @mousedown.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal wide" role="dialog" aria-modal="true" aria-label="引用的原件已变化">
      <header class="row">
        <strong class="nowrap">原件已变化</strong>
        <span class="muted small">{{ pages.length }} 页引用的原件在写作后变了</span>
        <span class="spacer" />
        <button class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" /></button>
      </header>
      <div class="row wrap bar">
        <span class="muted small st">{{ status }}<template v-if="failed">；上次检查失败了</template></span>
        <span class="spacer" />
        <router-link v-if="upkeep?.lastCheck" :to="`/runs/${upkeep.lastCheck.id}`" class="btn ghost sm" @click="emit('close')">上次检查</router-link>
        <button class="btn sm" :disabled="upkeep?.running || !pages.length" @click="emit('check', [])"><Icon name="refresh" :size="14" />现在检查全部</button>
      </div>
      <p v-if="!pages.length" class="muted">没有页面的原件变化。</p>
      <ul v-else class="list">
        <li v-for="p in shown" :key="p.slug" class="item">
          <div class="main">
            <router-link :to="`/wiki/${space}/${p.slug}`" class="ttl" @click="emit('close')">{{ titles[p.slug] || p.slug }}</router-link>
            <span class="muted small clip"
              >{{ p.sources.some((s) => s.deleted) ? "原件已删除或有变化：" : "变化的原件：" }}{{ p.sources.slice(0, 2).map(name).join("、") }}<template v-if="p.sources.length > 2"> 等 {{ p.sources.length }} 份</template></span
            >
          </div>
          <button class="btn ghost sm" :disabled="upkeep?.running" @click="emit('check', [p.slug])">检查</button>
        </li>
        <li v-if="pages.length > shown.length" class="more"><button class="btn ghost sm" @click="all = true">显示全部 {{ pages.length }} 页</button></li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 55;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 8vh;
}
.modal {
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 16px 18px;
}
.wide {
  width: min(760px, calc(100vw - 24px));
  max-height: 84vh;
  overflow-y: auto;
  display: grid;
  gap: 12px;
  align-content: start;
}
@media (max-width: 600px) {
  .modal-overlay {
    padding-top: 12px;
  }
}
header,
.bar {
  gap: 8px;
  min-width: 0;
}
.st {
  min-width: 0;
  overflow-wrap: anywhere;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.item {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  padding: 6px 0;
  border-top: 1px solid var(--line);
}
.main {
  display: grid;
  min-width: 0;
}
.ttl {
  font-weight: 550;
  overflow-wrap: anywhere;
}
.clip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.more {
  padding-top: 4px;
}
</style>
