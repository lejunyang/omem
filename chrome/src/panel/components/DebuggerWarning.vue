<script setup lang="ts">
import { useInjectedPanelContext } from "../use-panel-context";

const { clearDebuggerWarning, debuggerWarning } = useInjectedPanelContext();
</script>

<template>
  <section v-if="debuggerWarning" class="action-panel debugger-warning">
    <div class="action-panel-text">
      <strong>Debugger 功能不可用</strong>
      <span>{{ debuggerWarning }}</span>
    </div>
    <button class="button" type="button" @click="clearDebuggerWarning">知道了</button>
  </section>
</template>
