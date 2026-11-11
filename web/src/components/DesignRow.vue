<script setup lang="ts">
import { countParts, ORIGIN_LABELS, STATUS_CLS, statusText, type DesignSummary } from "../lib/designs";
import { relTime, state } from "../store";

/** One design in a list (an item's designs, the list page): title, origin, status, counts, when. */
const props = defineProps<{ design: DesignSummary; item?: { id: string; title: string } | null; showSpace?: boolean }>();
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
const parts = () => countParts(props.design.counts);
</script>

<template>
  <router-link :to="`/design/${design.id}`" class="drow">
    <span class="t ellipsis" :title="design.title">{{ design.title }}</span>
    <span class="row wrap small meta">
      <span class="badge">{{ ORIGIN_LABELS[design.origin] }}<template v-if="design.author"> · {{ design.author }}</template></span>
      <span class="badge" :class="STATUS_CLS[design.status]">{{ statusText(design) }}</span>
      <template v-if="design.revision">
        <span>{{ parts().head }}</span>
        <span v-for="l in parts().levels" :key="l.level" class="badge" :class="l.cls">{{ l.label }} {{ l.n }}</span>
      </template>
      <span class="muted">{{ showSpace ? `${spaceName(design.spaceId)} · ` : "" }}{{ relTime(design.updatedAt) }}更新</span>
      <span v-if="item" class="muted ellipsis it" :title="item.title">事项：{{ item.title }}</span>
    </span>
  </router-link>
</template>

<style scoped>
.drow { display: grid; gap: 4px; padding: 8px 10px; border-radius: 8px; color: inherit; min-width: 0; }
.drow:hover { background: var(--hover); text-decoration: none; }
.t { font-weight: 550; min-width: 0; }
.meta { gap: 4px 8px; }
.it { max-width: 260px; }
</style>
