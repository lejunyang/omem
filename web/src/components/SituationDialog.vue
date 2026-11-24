<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { post } from "../api";
import { toast } from "../store";
import { SITUATION_WHAT, situationBody, situationForm, situationProblem, type ListenView, type SituationFormValue } from "../lib/listen";
import HelpText from "./HelpText.vue";
import Icon from "./Icon.vue";
import SituationForm from "./SituationForm.vue";

/**
 * A new 情境 (POST /api/listen, kind situation). `preset`: fields to start from (a proposal the owner
 * chose to edit first). Saving compiles “怎么认出来” into a rule, which takes the model a few seconds.
 */
const props = defineProps<{ preset?: Partial<SituationFormValue> }>();
const emit = defineEmits<{ close: []; created: [view: ListenView] }>();

const form = reactive<SituationFormValue>(situationForm(null, props.preset));
const missing = computed(() => situationProblem(form));
const busy = ref(false);
async function submit() {
  if (missing.value || busy.value) return;
  busy.value = true;
  try {
    const v = await post<ListenView>("/api/listen", situationBody(form));
    toast(`已建情境：${v.name}`, "ok");
    emit("created", v);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}

const box = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") (e.preventDefault(), emit("close"));
}
onMounted(async () => {
  returnFocus = document.activeElement as HTMLElement | null;
  await nextTick();
  box.value?.querySelector<HTMLElement>("input")?.focus();
});
onBeforeUnmount(() => returnFocus?.focus?.());
</script>

<template>
  <Teleport to="body">
    <div class="sd-scrim" @mousedown.self="emit('close')" @keydown="onKey">
      <form ref="box" class="sd-dialog" role="dialog" aria-modal="true" aria-labelledby="sd-title" @submit.prevent="submit">
        <div class="row">
          <h3 id="sd-title" class="spacer">新建情境</h3>
          <button type="button" class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="15" /></button>
        </div>
        <HelpText>{{ SITUATION_WHAT }} 这里写你在意什么和怎么认出来，不用写步骤。</HelpText>
        <SituationForm v-model="form" with-name />
        <div class="row wrap actions">
          <span v-if="busy" class="small muted spacer">正在把“怎么认出来”编成规则，要几秒…</span>
          <span v-else-if="missing" class="small muted spacer">{{ missing }}</span>
          <span v-else class="spacer" />
          <button type="button" class="btn" @click="emit('close')">取消</button>
          <button type="submit" class="btn primary" :disabled="!!missing || busy">{{ form.active ? "建好并启用" : "建好先不启用" }}</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.sd-scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(15, 17, 20, 0.36);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 6vh 16px 16px;
  overflow-y: auto;
}
.sd-dialog {
  width: min(620px, 100%);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  padding: 18px 20px;
  display: grid;
  gap: 14px;
  min-width: 0;
}
h3 {
  margin: 0;
  font-size: 16px;
}
.actions {
  gap: 8px;
}
@media (max-width: 560px) {
  .sd-dialog {
    padding: 16px;
  }
}
</style>
