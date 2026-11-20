<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import UiSelect from "./UiSelect.vue";

/**
 * “收尾” on a line's page (src/items/lifecycle.ts): watch it a while first, end it now, or drop it.
 * It only picks; the page asks about the items still open under it and sends PUT /api/work/:id/phase.
 */
const props = defineProps<{ title: string; watching: boolean }>();
const emit = defineEmits<{ close: []; pick: [phase: "watching" | "done" | "cancelled", days?: number] }>();
const days = ref("14");
const dayOptions = [{ value: "7", label: "7 天" }, { value: "14", label: "14 天" }, { value: "30", label: "30 天" }];
const panel = ref<HTMLElement>();
const opener = document.activeElement as HTMLElement | null;
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); emit("close"); }
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  void nextTick(() => panel.value?.querySelector<HTMLElement>(".opt")?.focus());
});
onBeforeUnmount(() => { window.removeEventListener("keydown", onKey); opener?.focus?.(); });
</script>

<template>
  <Teleport to="body">
    <div class="overlay" @mousedown.self="emit('close')">
      <div ref="panel" class="modal" role="dialog" aria-modal="true" aria-labelledby="work-phase-title">
        <header class="row"><strong id="work-phase-title">「{{ props.title }}」怎么收尾</strong><span class="spacer" /><button type="button" class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" /></button></header>
        <div class="opts">
          <div v-if="!props.watching" class="opt-row">
            <button type="button" class="opt" @click="emit('pick', 'watching', Number(days))">
              <Icon name="eye" :size="18" class="oi watch" />
              <span class="ob"><strong>先观察</strong><span class="small muted">上线了，再看一阵：照读群、照取指标；期满没有新问题自己结束，有问题就接着看。</span></span>
            </button>
            <UiSelect v-model="days" :options="dayOptions" size="sm" width="96px" aria-label="观察几天" />
          </div>
          <button type="button" class="opt" @click="emit('pick', 'done')">
            <Icon name="check" :size="18" class="oi done" />
            <span class="ob"><strong>现在结束</strong><span class="small muted">做完了：关注和指标停下，助手写一段收尾小结（做成了什么、上线后数字怎么样、还剩什么）。</span></span>
          </button>
          <button type="button" class="opt" @click="emit('pick', 'cancelled')">
            <Icon name="x" :size="18" class="oi drop" />
            <span class="ob"><strong>放弃这条线</strong><span class="small muted">不做了：同样停下关注和指标，记成取消。</span></span>
          </button>
        </div>
        <p class="muted small">结束以后在工作页下面的“已结束”里找得到，随时可以重新打开。</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 35; background: rgba(10, 12, 16, 0.25); display: flex; justify-content: center; align-items: flex-start; padding: 10vh 12px 12px; overflow: auto; }
.modal { width: min(520px, 100%); background: var(--panel); border-radius: 14px; border: 1px solid var(--line); box-shadow: var(--shadow-lg); padding: 16px 18px; display: grid; gap: 12px; }
.modal header strong { overflow-wrap: anywhere; min-width: 0; }
.opts { display: grid; gap: 8px; }
.opt-row { display: flex; gap: 8px; align-items: center; min-width: 0; }
.opt-row .opt { flex: 1; }
.opt {
  all: unset; box-sizing: border-box; cursor: pointer; display: flex; gap: 12px; align-items: flex-start; min-width: 0;
  padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel);
}
.opt:hover { border-color: var(--line-strong); background-image: linear-gradient(var(--hover), var(--hover)); }
.opt:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.oi { margin-top: 1px; flex: none; }
.oi.watch { color: var(--accent); }
.oi.done { color: var(--ok); }
.oi.drop { color: var(--muted); }
.ob { display: grid; gap: 3px; min-width: 0; }
.ob strong { font-size: 14.5px; }
.ob .small { line-height: 1.55; overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .opt-row { flex-wrap: wrap; }
}
</style>
