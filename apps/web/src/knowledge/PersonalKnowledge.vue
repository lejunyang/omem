<script setup lang="ts">
import { OmTrailDrawer, useEvidenceTrail } from "@omem/ui";
import KnowledgeHome from "./KnowledgeHome.vue";
import KnowledgeFrame from "./KnowledgeFrame.vue";
const { frames, current, open, loopAt, trigger, active, push, back, jump, close } = useEvidenceTrail();
</script>
<template>
  <section class="library-page"><KnowledgeHome prefix="/api/knowledge" @navigate="push" /></section>
  <OmTrailDrawer :open="open" :frames="frames" :current="current" :loop-at="loopAt" :return-focus-to="trigger" @close="close" @back="back" @jump="jump" @dismiss-loop="loopAt = null">
    <KnowledgeFrame v-if="active" :frame="active" prefix="/api/knowledge" @navigate="push" @loaded="active.title = $event" />
  </OmTrailDrawer>
</template>
