<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { get, put } from "../api";
import { toast } from "../store";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/** A plugin's settings (docs/v2/plugins.md): one form for every plugin, built from its manifest. Saves each change. */
type Field = { key: string; label: string; description: string; type: "select" | "number" | "text" | "boolean"; options: (string | { value: string; label: string })[]; min?: number; max?: number; default: string | number | boolean };

const props = defineProps<{ plugin: string; title: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const fields = ref<Field[] | null>(null);
const values = ref<Record<string, string | number | boolean>>({});
const error = ref("");
const box = ref<HTMLElement | null>(null);
const returnTo = document.activeElement as HTMLElement | null;

const options = (f: Field) => f.options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));

async function save(key: string, value: unknown) {
  try {
    const r = await put<{ values: Record<string, string | number | boolean> }>(`/api/plugins/${props.plugin}/settings`, { [key]: value });
    values.value = r.values;
    toast("已保存", "ok");
    emit("saved");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
function close() {
  emit("close");
  returnTo?.focus?.();
}
const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();

onMounted(async () => {
  window.addEventListener("keydown", onKey);
  try {
    const r = await get<{ fields: Field[]; values: Record<string, string | number | boolean> }>(`/api/plugins/${props.plugin}/settings`);
    fields.value = r.fields;
    values.value = r.values;
  } catch (e) {
    error.value = (e as Error).message;
  }
  await nextTick();
  box.value?.querySelector<HTMLElement>("button, input")?.focus();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div class="overlay" @mousedown.self="close">
      <div ref="box" class="dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-settings-title">
        <header class="row">
          <h2 id="plugin-settings-title">{{ title }} · 设置</h2>
          <span class="spacer" />
          <button class="btn ghost sm icon" aria-label="关闭" @click="close"><Icon name="x" /></button>
        </header>
        <p v-if="error" class="err">{{ error }}</p>
        <Skeleton v-else-if="!fields" variant="text" :rows="4" />
        <p v-else-if="!fields.length" class="muted">这个插件没有设置项。</p>
        <div v-else class="stack">
          <div v-for="f in fields" :key="f.key" class="field">
            <template v-if="f.type === 'boolean'">
              <UiCheckbox :model-value="!!values[f.key]" switch @change="(v) => save(f.key, v)">{{ f.label }}</UiCheckbox>
            </template>
            <template v-else>
              <span>{{ f.label }}</span>
              <UiSelect v-if="f.type === 'select'" :model-value="String(values[f.key])" width="100%" :aria-label="f.label" :options="options(f)" @change="(v) => save(f.key, v)" />
              <input
                v-else
                class="input"
                :type="f.type === 'number' ? 'number' : 'text'"
                :min="f.min"
                :max="f.max"
                :value="values[f.key]"
                :aria-label="f.label"
                @change="save(f.key, ($event.target as HTMLInputElement).value)"
              />
            </template>
            <span v-if="f.description" class="muted small">{{ f.description }}</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 60;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
}
.dialog {
  width: min(520px, calc(100vw - 24px));
  max-height: 80vh;
  overflow-y: auto;
  background: var(--panel);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--line);
  padding: 16px 18px;
  display: grid;
  gap: 14px;
}
h2 {
  font-size: 16px;
}
.err {
  color: var(--danger);
}
</style>
