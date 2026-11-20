<script setup lang="ts">
import FlowBoard from "../components/FlowBoard.vue";
import FlowTabs from "../components/FlowTabs.vue";

/**
 * The flow board on a page of its own: what members see under 流程 (the owner has it as the work
 * page's 按阶段, views/Work.vue, where the nav takes them).
 */
</script>

<template>
  <div class="page board-page">
    <header class="head">
      <div class="row wrap title-row"><h1>流程</h1><FlowTabs /></div>
      <p class="muted">在走流程的事项，按现在走到哪一段分列，点开看每一件的经过和等你的。</p>
    </header>
    <FlowBoard />
  </div>
</template>

<style scoped>
.head h1 { margin: 0; }
.title-row { gap: 14px; margin-bottom: 4px; }
.head p { margin: 0 0 14px; }
</style>
