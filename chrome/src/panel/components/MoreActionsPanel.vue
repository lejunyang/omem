<script setup lang="ts">
import { useInjectedPanelContext } from "../use-panel-context";

const { clearRecords, exportHar, loadExistingHar, showMoreActions } = useInjectedPanelContext();
</script>

<template>
  <section v-if="showMoreActions" class="action-panel">
    <div class="action-panel-text">
      <strong>更多操作</strong>
      <span>低频调试操作：导出当前 HAR、重新读取 DevTools HAR、清空当前面板记录。</span>
    </div>
    <div class="action-panel-actions">
      <button class="button" type="button" @click="exportHar">导出 HAR</button>
      <button class="button" type="button" @click="loadExistingHar">刷新 HAR</button>
      <button class="button button-danger" type="button" @click="clearRecords">清空</button>
    </div>
  </section>
</template>
