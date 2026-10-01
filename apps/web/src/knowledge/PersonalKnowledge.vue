<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { OmTrailDrawer, useEvidenceTrail, parseHash, writeHash, MAX_TRAIL } from "@omem/ui";
import KnowledgeHome from "./KnowledgeHome.vue";
import KnowledgeFrame from "./KnowledgeFrame.vue";
const selectedKey = ref(sessionStorage.getItem("omem-knowledge-page") || "");
const linkNotice = ref("");
function saveRoute() {
  if (frames.value.length > MAX_TRAIL) { linkNotice.value = "引用路径过长，当前阅读不受影响，但链接暂不保存完整路径。"; return; }
  linkNotice.value = "";
  if (!selectedKey.value) { history.replaceState(null, "", "#/knowledge"); return; }
  const hash = writeHash({ view: {name:"module", module:selectedKey.value}, trail:frames.value }).replace("#/module/", "#/knowledge/");
  history.replaceState(null, "", hash);
}
const { frames, current, open, loopAt, trigger, active, push, back, jump, close } = useEvidenceTrail(saveRoute);
function select(key: string) { selectedKey.value = key; saveRoute(); }
function restoreRoute() {
  if (!location.hash.startsWith("#/knowledge/")) return;
  const route = parseHash(location.hash.replace("#/knowledge/", "#/module/"));
  if (route.view.name === "module") selectedKey.value = route.view.module;
  frames.value = route.trail.filter(f => ["knowledge", "citation", "source"].includes(f.kind)).map(f => ({...f,title:"正在读取引用…"}));
  current.value = Math.max(0, frames.value.length - 1); open.value = frames.value.length > 0;
}
restoreRoute();
onMounted(() => window.addEventListener("hashchange", restoreRoute));
onBeforeUnmount(() => window.removeEventListener("hashchange", restoreRoute));
</script>
<template>
  <section class="library-page"><p v-if="linkNotice" role="status">{{ linkNotice }}</p><KnowledgeHome prefix="/api/knowledge" :selected-key="selectedKey" @select="select" @navigate="push" /></section>
  <OmTrailDrawer :open="open" :frames="frames" :current="current" :loop-at="loopAt" :return-focus-to="trigger" @close="close" @back="back" @jump="jump" @dismiss-loop="loopAt = null">
    <KeepAlive v-if="open"><KnowledgeFrame v-if="active" :key="active.kind + active.id" :frame="active" prefix="/api/knowledge" @navigate="push" @loaded="(title, id) => { const frame = frames.find(f => f.id === id); if (frame) frame.title = title; }" /></KeepAlive>
  </OmTrailDrawer>
</template>
