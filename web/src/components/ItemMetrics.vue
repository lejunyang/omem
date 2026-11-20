<script setup lang="ts">
/**
 * An item's metrics and reports: the same board as the data page's 工作数据 (components/MetricsBoard),
 * for this item and the items under it — a figure opens its chart, why it exists and how it is read,
 * proposals are kept, changed or dropped here too. Hidden while the item has none.
 */
import { ref } from "vue";
import MetricsBoard from "./MetricsBoard.vue";

defineProps<{ itemId: string }>();
const count = ref(0);
</script>

<template>
  <section v-show="count" class="item-metrics">
    <h3>数据</h3>
    <MetricsBoard scope="work" :item="itemId" @count="count = $event" />
  </section>
</template>

<style scoped>
.item-metrics {
  margin: 12px 0;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.item-metrics h3 {
  margin: 0;
  font-size: 14px;
}
</style>
