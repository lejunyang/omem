<script setup lang="ts">
/**
 * Placeholder shown while data loads, shaped like what is coming (list rows, chat messages,
 * cards or a block of text), so loading never looks like "there is nothing here".
 */
withDefaults(defineProps<{ rows?: number; variant?: "list" | "chat" | "cards" | "text" | "lines" }>(), { rows: 5, variant: "list" });
const widths = [92, 76, 84, 64, 88, 70, 80, 58];
</script>

<template>
  <div class="sk" :class="variant" role="status" aria-live="polite" aria-label="加载中">
    <template v-if="variant === 'chat'">
      <div v-for="i in rows" :key="i" class="chat-row">
        <span class="dot" />
        <div class="col">
          <span class="bar" style="width: 90px; height: 10px" />
          <span class="bar" :style="{ width: `${widths[i % widths.length]}%` }" />
          <span v-if="i % 2" class="bar" :style="{ width: `${widths[(i + 3) % widths.length] - 20}%` }" />
        </div>
      </div>
    </template>
    <template v-else-if="variant === 'cards'">
      <div v-for="i in rows" :key="i" class="card-sk">
        <span class="bar" style="width: 40%; height: 12px" />
        <span class="bar" :style="{ width: `${widths[i % widths.length]}%` }" />
      </div>
    </template>
    <template v-else-if="variant === 'text'">
      <span class="bar" style="width: 46%; height: 18px; margin-bottom: 10px" />
      <span v-for="i in rows" :key="i" class="bar" :style="{ width: `${widths[i % widths.length]}%` }" />
    </template>
    <template v-else-if="variant === 'lines'">
      <span v-for="i in rows" :key="i" class="bar thin" :style="{ width: `${widths[i % widths.length]}%` }" />
    </template>
    <template v-else>
      <div v-for="i in rows" :key="i" class="list-row">
        <span class="bar" :style="{ width: `${widths[i % widths.length] - 10}%` }" />
        <span class="bar thin" :style="{ width: `${widths[(i + 2) % widths.length] - 30}%` }" />
      </div>
    </template>
    <span class="sr">加载中</span>
  </div>
</template>

<style scoped>
.sk {
  display: grid;
  gap: 12px;
  padding: 6px 0;
}
.bar {
  display: block;
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--sunken) 0%, var(--hover) 40%, var(--sunken) 80%);
  background-size: 300% 100%;
  animation: sk 1.3s ease-in-out infinite;
}
.bar.thin {
  height: 9px;
}
.list-row,
.card-sk {
  display: grid;
  gap: 7px;
  padding: 6px 4px;
}
.card-sk {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 16px;
  background: var(--panel);
}
.chat-row {
  display: flex;
  gap: 10px;
}
.dot {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex: none;
  background: var(--sunken);
}
.col {
  flex: 1;
  display: grid;
  gap: 7px;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
@keyframes sk {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: 0 0;
  }
}
</style>
