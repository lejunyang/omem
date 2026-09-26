<script setup lang="ts">
import { ref } from "vue";
import OmButton from "./OmButton.vue";
import OmIcon from "./OmIcon.vue";
const nav = ref(false);
const assist = ref(false);
</script>
<template>
  <div class="om-shell">
    <header class="om-top">
      <OmButton
        class="nav-toggle"
        variant="ghost"
        aria-label="导航"
        @click="nav = !nav"
        ><OmIcon name="menu" /></OmButton
      ><a href="#" class="om-brand" @click.prevent
        ><OmIcon name="layers" :size="26" /><b>omem.</b
        ><span>有来处的记忆</span></a
      >
      <div class="top-slot"><slot name="top" /></div>
      <OmButton
        v-if="$slots.assistant"
        class="assistant-toggle"
        variant="ghost"
        @click="assist = !assist"
        >追问</OmButton
      >
    </header>
    <div class="shell-body">
      <aside class="om-nav" :class="{ shown: nav }" @click="nav = false">
        <slot name="navigation" />
      </aside>
      <main><slot /></main>
      <aside
        v-if="$slots.assistant"
        class="om-assistant"
        :class="{ shown: assist }"
      >
        <slot name="assistant" />
      </aside>
    </div>
  </div>
</template>
<style scoped>
.om-shell {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.om-top {
  height: 70px;
  flex-shrink: 0;
  background: #171717;
  color: white;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 24px;
}
.om-brand {
  display: flex;
  gap: 12px;
  align-items: center;
  text-decoration: none;
  flex-shrink: 0;
}
.om-brand b {
  font:
    30px Georgia,
    serif;
}
.om-brand span {
  font-size: 11px;
  color: #bbb;
}
.top-slot {
  flex: 1;
  min-width: 0;
}
.shell-body {
  display: flex;
  min-height: 0;
  flex: 1;
}
.om-nav {
  width: 240px;
  flex-shrink: 0;
  background: #f4f4f4;
  border-right: 1px solid var(--om-line);
  padding: 24px 16px;
  overflow: auto;
}
main {
  flex: 1;
  min-width: 0;
  overflow: auto;
}
.om-assistant {
  width: 330px;
  flex-shrink: 0;
  border-left: 1px solid var(--om-line);
  background: #fff;
  overflow: auto;
}
.nav-toggle,
.assistant-toggle {
  display: none !important;
}
@media (max-width: 1100px) {
  .om-assistant {
    display: none;
  }
  .assistant-toggle {
    display: inline-flex !important;
    color: white;
  }
  .om-assistant.shown {
    display: block;
    position: fixed;
    right: 0;
    top: 70px;
    bottom: 0;
    z-index: 30;
    box-shadow: -10px 0 35px #0002;
  }
}
@media (max-width: 700px) {
  .om-top {
    height: 60px;
    padding: 0 10px;
    gap: 8px;
  }
  .om-brand span {
    display: none;
  }
  .om-brand b {
    font-size: 24px;
  }
  .om-brand svg {
    display: none;
  }
  .nav-toggle {
    display: inline-flex !important;
    color: white;
  }
  .om-nav {
    display: none;
  }
  .om-nav.shown {
    display: block;
    position: fixed;
    left: 0;
    top: 60px;
    bottom: 0;
    z-index: 40;
    box-shadow: 10px 0 35px #0002;
  }
  .om-assistant.shown {
    top: 60px;
    width: min(100vw, 360px);
  }
  .top-slot {
    overflow: hidden;
  }
}
</style>
