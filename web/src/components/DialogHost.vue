<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { closeDialog, dialogs } from "../lib/dialog";

const box = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
const top = () => dialogs.stack[dialogs.stack.length - 1];
const d = computed(() => top());
const cancel = () => d.value && closeDialog(d.value.id, d.value.kind === "confirm" ? false : null);
const valid = computed(() => !d.value?.fields?.some((f) => f.required && !f.value.trim()));
const ok = () => d.value && valid.value && closeDialog(d.value.id, d.value.kind === "confirm" ? true : d.value.fields ? Object.fromEntries(d.value.fields.map((f) => [f.id, f.value.trim()])) : (d.value.text ?? ""));

watch(
  () => dialogs.stack.length,
  async (len, prev) => {
    if (len > (prev ?? 0)) {
      returnFocus = document.activeElement as HTMLElement | null;
      await nextTick();
      const input = box.value?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
      if (input) (input.focus(), input.select());
      else box.value?.querySelector<HTMLButtonElement>("button.ok")?.focus();
    } else if (!len) returnFocus?.focus?.();
  },
);

function onKey(e: KeyboardEvent) {
  if (!d.value) return;
  if (e.key === "Escape") (e.preventDefault(), cancel());
  else if (e.key === "Enter" && d.value.kind === "prompt" && !d.value.fields) (e.preventDefault(), ok());
  else if (e.key === "Tab") {
    // Keep focus inside the dialog.
    const els = [...(box.value?.querySelectorAll<HTMLElement>("input, textarea, button:not(:disabled)") ?? [])];
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : i === els.length - 1 ? 0 : i + 1;
    e.preventDefault();
    els[next].focus();
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="d" class="dlg-scrim" @mousedown.self="cancel" @keydown="onKey">
      <div ref="box" class="dlg" role="alertdialog" aria-modal="true" :aria-labelledby="`dlg-${d.id}`" :aria-describedby="d.message ? `dlg-msg-${d.id}` : undefined">
        <div class="content">
          <h3 :id="`dlg-${d.id}`">{{ d.title }}</h3>
          <p v-if="d.message" :id="`dlg-msg-${d.id}`" class="msg">{{ d.message }}</p>
          <template v-if="d.fields">
            <label v-for="f in d.fields" :key="f.id" class="field">
              <span>{{ f.label }}</span>
              <textarea v-model="f.value" class="textarea" rows="3" :required="f.required" :maxlength="f.maxLength" />
            </label>
          </template>
          <input v-else-if="d.kind === 'prompt'" v-model="d.text" class="input" :placeholder="d.placeholder" />
        </div>
        <div class="row actions">
          <span class="spacer" />
          <button class="btn" @click="cancel">取消</button>
          <button class="btn ok" :disabled="!valid" :class="d.danger ? 'danger-fill' : 'primary'" @click="ok">{{ d.okText }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dlg-scrim {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: rgba(15, 17, 20, 0.36);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 18vh 16px 16px;
  animation: dlg-fade 0.12s ease-out;
}
.dlg {
  width: min(440px, 100%);
  min-width: 0;
  max-height: 100%;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  padding: 18px 20px 16px;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 12px;
}
.content {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-wrap: anywhere;
  display: grid;
  gap: 12px;
}
h3 {
  font-size: 16px;
  font-weight: 650;
}
.msg {
  margin: -4px 0 0;
  color: var(--ink-2);
  white-space: pre-wrap;
}
.actions {
  margin-top: 4px;
}
@keyframes dlg-fade {
  from {
    opacity: 0;
  }
}
</style>
