<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { get } from "../api";
import Skeleton from "./Skeleton.vue";
type Plugin = { id: string; name: string; channels: { id: string; label: string; running: boolean; lastError: string | null }[] };
const plugins = ref<Plugin[] | null>(null), error = ref("");
let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  try { const data = await get<Plugin[]>("/api/plugins"); if (alive) { plugins.value = data.filter((p) => p.channels.length); error.value = ""; } }
  catch (e) { if (alive) error.value = (e as Error).message; }
  finally { if (alive) timer = setTimeout(load, 5000); }
}
onMounted(load);
onBeforeUnmount(() => { alive = false; clearTimeout(timer); });
</script>
<template>
  <div class="card pad stack plugin-channels">
    <strong>插件渠道</strong>
    <p v-if="error" class="muted" role="alert">{{ error }}</p>
    <Skeleton v-else-if="!plugins" :rows="2" />
    <p v-else-if="!plugins.length" class="muted small">还没有插件渠道。安装带渠道的插件、信任并启用后会出现在这里。</p>
    <template v-for="p in plugins ?? []" :key="p.id">
      <div v-for="c in p.channels" :key="c.id" class="stack">
        <div class="row wrap"><span>{{ c.label }}（插件 {{ p.name }}）</span><span class="badge" :class="{ ok: c.running && !c.lastError, warn: !!c.lastError }">{{ c.lastError ? "发送失败" : c.running ? "运行中" : "已停止" }}</span><RouterLink class="lnk" :to="`/settings?tab=plugins&plugin=${p.id}`">插件设置</RouterLink></div>
        <p v-if="c.lastError" class="muted small">{{ c.lastError }}</p>
      </div>
    </template>
  </div>
</template>
<style scoped>.plugin-channels { min-width: 0; overflow-wrap: anywhere; }</style>
