<script setup lang="ts">
import { computed, ref } from "vue";
import { relTime } from "../store";
import Icon from "./Icon.vue";

/**
 * The Wiki's "originals changed" notice, at the top of the page where it is seen: how many pages
 * cite an original that changed since they were written, which, what the automatic check is doing,
 * and a way to check now (all of them or one).
 */
export type StalePage = { slug: string; sources: { id: string; uri: string; title: string; kind: string; deleted: boolean }[] };
export type Upkeep = { auto: boolean; lastCheck: { id: string; status: string; at: string; auto: boolean } | null; waiting: number; appendOnly: number; running: boolean; nextAt: string | null };

const props = defineProps<{ space: string; pages: StalePage[]; titles: Record<string, string>; upkeep: Upkeep | null; expanded?: boolean }>();
const emit = defineEmits<{ check: [slugs: string[]] }>();

const open = ref(props.expanded ?? false);
const all = ref(false);
const shown = computed(() => (all.value ? props.pages : props.pages.slice(0, 6)));
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
  <section v-if="pages.length" class="attn" role="status" aria-label="引用的原件已变化">
    <header class="row wrap">
      <Icon name="alert" :size="16" class="ico" />
      <strong>{{ pages.length }} 页引用的原件已变化</strong>
      <span class="muted small st">{{ status }}<template v-if="failed">；上次检查失败了</template></span>
      <span class="spacer" />
      <router-link v-if="upkeep?.lastCheck" :to="`/runs/${upkeep.lastCheck.id}`" class="btn ghost sm">上次检查</router-link>
      <button class="btn sm" :disabled="upkeep?.running" @click="emit('check', [])"><Icon name="refresh" :size="14" />现在检查全部</button>
      <button class="btn ghost sm" :aria-expanded="open" @click="open = !open">{{ open ? "收起" : "查看页面" }}</button>
    </header>
    <ul v-if="open" class="list">
      <li v-for="p in shown" :key="p.slug" class="item">
        <div class="main">
          <router-link :to="`/wiki/${space}/${p.slug}`" class="ttl">{{ titles[p.slug] || p.slug }}</router-link>
          <span class="muted small clip"
            >{{ p.sources.some((s) => s.deleted) ? "原件已删除或有变化：" : "变化的原件：" }}{{ p.sources.slice(0, 2).map(name).join("、") }}<template v-if="p.sources.length > 2"> 等 {{ p.sources.length }} 份</template></span
          >
        </div>
        <button class="btn ghost sm" :disabled="upkeep?.running" @click="emit('check', [p.slug])">检查</button>
      </li>
      <li v-if="pages.length > shown.length" class="more"><button class="btn ghost sm" @click="all = true">显示全部 {{ pages.length }} 页</button></li>
    </ul>
  </section>
</template>

<style scoped>
.attn {
  border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
  background: var(--warn-soft);
  border-radius: var(--radius);
  padding: 8px 12px;
  margin: 0 auto 18px;
  max-width: 760px;
  display: grid;
  gap: 6px;
}
header {
  gap: 8px;
  min-width: 0;
}
.ico {
  color: var(--warn);
  flex: none;
}
.st {
  min-width: 0;
  overflow-wrap: anywhere;
}
.list {
  list-style: none;
  margin: 0;
  padding: 6px 0 0;
  display: grid;
  gap: 2px;
  border-top: 1px solid color-mix(in srgb, var(--warn) 25%, var(--line));
}
.item {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
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
