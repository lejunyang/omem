<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get } from "../api";
import { ACCEPT_LABEL, effectiveText, levelOf, withSource, type AcceptWork, type SourceChoice } from "../lib/accept-work";
import { fmtTime } from "../store";
import { useSettings } from "../views/settings/ctx";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * 设置 → 设备 → 接别的设备派来的活 (src/agents/peer-work.ts): whether a paired device may run a task-board
 * task here with this machine's data and logins (`node.acceptWork`), and the same per pairing
 * (`node.acceptWorkFrom`, keyed by the paired token's id). Only `node` is sent; a source set on its own
 * keeps its setting when the device's level changes.
 */
const { config, saveConfig } = useSettings();
type Paired = { id: string; label: string; createdAt: string; lastUsedAt: string | null };
const paired = ref<Paired[] | null>(null);
onMounted(async () => {
  paired.value = (await get<{ paired: Paired[] }>("/api/peers").catch(() => null))?.paired ?? [];
});

const node = computed(() => (config.value.node ?? {}) as { acceptWork?: AcceptWork; acceptWorkFrom?: Record<string, AcceptWork> });
const level = computed(() => levelOf(node.value.acceptWork));
const from = computed(() => node.value.acceptWorkFrom ?? {});
const LEVEL_HINT: Record<AcceptWork, string> = {
  off: "别的设备派来的任务一律拒绝；它们仍可以借这台的后端（资料和工具留在它们那边）",
  read: "对方的任务在这台用这台的资料和登录做调查，不改任何东西",
  write: "还能写任务所在空间的记忆、Wiki 页和事项；不改代码、不发消息",
};
const levels = (["off", "read", "write"] as const).map((v) => ({ value: v, label: ACCEPT_LABEL[v] }));
const sourceOptions: { value: SourceChoice; label: string }[] = [{ value: "inherit", label: "跟随" }, { value: "off", label: "不接" }, { value: "read", label: "只读" }, { value: "write", label: "可写" }];

function setLevel(v: AcceptWork) {
  void saveConfig({ node: { acceptWork: v } }, `接活改为：${ACCEPT_LABEL[v]}`);
}
function setSource(p: Paired, choice: SourceChoice) {
  void saveConfig({ node: { acceptWorkFrom: withSource(from.value, p.id, choice) } }, choice === "inherit" ? `${p.label} 改回跟随这台的设置` : `${p.label}：${ACCEPT_LABEL[choice]}`);
}
</script>

<template>
  <SetCard v-if="config" id="set-accept-work" title="接别的设备派来的活" :keys="['node']">
    <template #help>配对的设备可以把任务板上的一块交给这台跑：用这台的资料、目录和登录，结果交回去。只认配对令牌，不认任务里自报的身份。</template>
    <SetRow label="这台接不接" :hint="LEVEL_HINT[level]">
      <UiSegmented :model-value="level" size="sm" aria-label="接不接别的设备派来的活" :options="levels" @change="setLevel" />
    </SetRow>
    <div class="set-pad aw-list">
      <div class="aw-head">按来源单独设<span class="aw-sub">持有本机配对令牌的设备，没单独设的跟随上面</span></div>
      <p v-if="paired === null" class="aw-sub">正在读配对的设备…</p>
      <p v-else-if="!paired.length" class="aw-sub">还没有设备持有本机的配对令牌：在下面生成配对码，对方添加后会出现在这里。</p>
      <div v-for="p in paired" v-else :key="p.id" class="aw-row">
        <div class="aw-name">
          <span class="mono aw-label" :title="p.label">{{ p.label }}</span>
          <span class="aw-sub">{{ effectiveText(level, from[p.id]) }} · {{ p.lastUsedAt ? `最近使用 ${fmtTime(p.lastUsedAt)}` : "还没用过" }}</span>
        </div>
        <UiSegmented :model-value="from[p.id] ?? 'inherit'" size="sm" :aria-label="`${p.label} 派来的活`" :options="sourceOptions" @change="(v) => setSource(p, v)" />
      </div>
    </div>
  </SetCard>
</template>
