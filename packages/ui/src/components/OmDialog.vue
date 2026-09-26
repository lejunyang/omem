<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount } from "vue";
import OmButton from "./OmButton.vue";
import OmIcon from "./OmIcon.vue";
const props = defineProps<{
  open: boolean;
  title: string;
  depth?: number;
  sideOpen?: boolean;
}>();
const emit = defineEmits<{ close: []; back: [] }>();
const dialog = ref<HTMLDialogElement>();
let previous: HTMLElement | null = null;
watch(
  () => props.open,
  async (open) => {
    await nextTick();
    if (open && !dialog.value?.open) {
      previous = document.activeElement as HTMLElement;
      dialog.value?.showModal();
    } else if (!open && dialog.value?.open) {
      dialog.value.close();
      if (previous?.isConnected) previous.focus();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
  <dialog
    ref="dialog"
    class="om-dialog"
    :class="{ wide: sideOpen }"
    aria-labelledby="om-dialog-title"
    @cancel.prevent="emit('back')"
    @click="
      (e) => {
        if (e.target === dialog) emit('close');
      }
    "
  >
    <div class="dialog-inner">
      <header>
        <div>
          <small v-if="depth">证据路径 · 第 {{ depth }} 层</small>
          <h2 id="om-dialog-title">{{ title }}</h2>
        </div>
        <OmButton variant="ghost" aria-label="关闭全部" @click="emit('close')"
          ><OmIcon name="close"
        /></OmButton>
      </header>
      <div class="dialog-body">
        <div class="dialog-scroll"><slot /></div>
        <aside v-if="$slots.aside" v-show="sideOpen">
          <slot name="aside" />
        </aside>
      </div>
      <footer v-if="$slots.actions"><slot name="actions" /></footer>
    </div>
  </dialog>
</template>
<style scoped>
.om-dialog {
  padding: 0;
  border: 1px solid #bbb;
  border-radius: 12px;
  width: min(960px, calc(100vw - 64px));
  height: min(820px, calc(100dvh - 80px));
  max-width: none;
  max-height: none;
  background: var(--om-panel);
  color: var(--om-ink);
  box-shadow: 0 24px 80px #0003;
}
.om-dialog::backdrop {
  background: #17171777;
  backdrop-filter: blur(2px);
}
.dialog-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 20px 28px;
  border-bottom: 1px solid var(--om-line);
}
h2 {
  font-size: 24px;
  margin: 5px 0;
}
.dialog-scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: 24px 28px;
}
footer {
  border-top: 1px solid var(--om-line);
  padding: 14px 28px;
  display: flex;
  gap: 8px;
  align-items: center;
}
@media (max-width: 700px) {
  .om-dialog {
    width: 100%;
    height: 100dvh;
    margin: 0;
    border: 0;
    border-radius: 0;
  }
  header,
  .dialog-scroll {
    padding: 18px;
  }
  h2 {
    font-size: 22px;
  }
  footer {
    padding: 12px 18px;
  }
}
.om-dialog.wide {
  width: min(1160px, calc(100vw - 64px));
}
.dialog-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.dialog-body > .dialog-scroll {
  min-width: 0;
}
.dialog-body > aside {
  width: 330px;
  flex-shrink: 0;
  border-left: 1px solid var(--om-line);
  overflow: auto;
}
@media (max-width: 700px) {
  .om-dialog.wide {
    width: 100vw;
  }
  .dialog-body {
    flex-direction: column;
    overflow: auto;
  }
  .wide .dialog-scroll {
    flex: none;
    max-height: 48dvh;
    min-height: 180px;
  }
  .dialog-body > aside {
    width: 100%;
    height: 65dvh;
    min-height: 500px;
    border-left: 0;
    border-top: 1px solid var(--om-line);
  }
}
</style>
