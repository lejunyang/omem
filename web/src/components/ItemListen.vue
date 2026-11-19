<script setup lang="ts">
/**
 * An item's 「关注」 (事情型): the assistant follows the groups linked to this matter, notes what changed,
 * and — when replies are on — answers about it there. A flow turns one on by itself; the owner can turn
 * it on for any item (server: channels/listen-items.ts, POST /api/items/:id/listen).
 */
import { computed, onMounted, ref, watch } from "vue";
import { get, post } from "../api";
import UiCheckbox from "./UiCheckbox.vue";
import { toast } from "../store";

type View = { id: string; kind: string; itemId: string | null; status: string; groups: { id: string; name: string }[]; knobs: { reply: string }; byFlow?: boolean; stats: { cases: number } };
const props = defineProps<{ itemId: string; editable: boolean }>();
const ctx = ref<View | null>(null);
const available = ref(true);
const busy = ref(false);

async function load() {
  try {
    const all = await get<View[]>("/api/listen");
    ctx.value = all.find((c) => c.kind === "item" && c.itemId === props.itemId) ?? null;
  } catch {
    // Only the owner sees 关注.
    available.value = false;
  }
}
onMounted(load);
watch(() => props.itemId, load);

const on = computed(() => ctx.value?.status === "active");
const reply = computed(() => ({ none: "只看不回", draft: "回复先给你看", auto: "直接回复" })[ctx.value?.knobs.reply ?? "none"] ?? "");

async function toggle(v: boolean) {
  busy.value = true;
  try {
    const r = await post<View | { ok: true }>(`/api/items/${props.itemId}/listen`, { on: v });
    if ("id" in r) ctx.value = r;
    else await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="available" class="item-listen">
    <div class="row wrap">
      <UiCheckbox :model-value="on" switch size="sm" :disabled="!editable || busy" @change="toggle">关注这件事</UiCheckbox>
      <span v-if="ctx && on" class="muted small">
        {{ ctx.groups.length ? `看着 ${ctx.groups.length} 个群：${ctx.groups.map((g) => g.name).join("、")}` : "还没有关联的群" }} · {{ reply }}{{ ctx.byFlow ? " · 随流程开始" : "" }}
      </span>
      <span v-else class="muted small">打开后助手看着这件事关联的群，记下变了什么；需要时在那里回答和它有关的问题。</span>
      <span class="spacer" />
      <RouterLink v-if="ctx" class="small" :to="`/listen/${ctx.id}`">设置、案例和经验</RouterLink>
    </div>
  </section>
</template>

<style scoped>
.item-listen {
  margin: 12px 0;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.spacer {
  flex: 1;
}
</style>
