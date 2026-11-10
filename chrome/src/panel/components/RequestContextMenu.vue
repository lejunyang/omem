<script setup lang="ts">
import { useInjectedPanelContext } from "../use-panel-context";

const { contextMenu, copyActions, copyFromContextMenu, createMockFromContextMenu } = useInjectedPanelContext();
</script>

<template>
  <div
    v-if="contextMenu.visible"
    class="context-menu"
    :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
    @click.stop
  >
    <button
      v-for="action in copyActions"
      :key="action.value"
      type="button"
      @click="copyFromContextMenu(action.value)"
    >
      {{ action.label }}
    </button>
    <hr />
    <button type="button" @click="createMockFromContextMenu('replace-headers')">Mock：替换响应头</button>
    <button type="button" @click="createMockFromContextMenu('replace-body')">Mock：替换响应体</button>
    <button type="button" @click="createMockFromContextMenu('script')">Mock：JS 修改响应</button>
  </div>
</template>
