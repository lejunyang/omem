<script setup lang="ts">
import { computed, ref, useId } from "vue";
import OmIcon from "./OmIcon.vue";
const props = withDefaults(
  defineProps<{
    title: string;
    open?: boolean;
    defaultOpen?: boolean;
    titleAction?: boolean;
  }>(),
  { open: undefined, defaultOpen: false, titleAction: false },
);
const emit = defineEmits<{ "update:open": [open: boolean]; select: [] }>();
const localOpen = ref(props.defaultOpen),
  panelId = useId();
const expanded = computed(() => props.open ?? localOpen.value);
function toggle() {
  localOpen.value = !expanded.value;
  emit("update:open", localOpen.value);
}
</script>
<template>
  <div class="om-disclosure" :class="{ expanded, selectable: titleAction }">
    <div class="disclosure-heading">
      <button
        v-if="titleAction"
        class="disclosure-toggle"
        type="button"
        :aria-label="(expanded ? '收起' : '展开') + title"
        :aria-expanded="expanded"
        :aria-controls="panelId"
        @click="toggle"
      >
        <OmIcon name="arrow" class="disclosure-arrow" />
      </button>
      <button
        class="disclosure-title"
        type="button"
        :aria-expanded="titleAction ? undefined : expanded"
        :aria-controls="titleAction ? undefined : panelId"
        @click="titleAction ? emit('select') : toggle()"
      >
        <OmIcon
          v-if="!titleAction"
          name="arrow"
          class="disclosure-arrow"
        /><span class="disclosure-label"
          ><slot name="title">{{ title }}</slot></span
        ><span v-if="$slots.meta" class="disclosure-meta"
          ><slot name="meta"
        /></span>
      </button>
    </div>
    <div v-show="expanded" :id="panelId" class="disclosure-content">
      <slot />
    </div>
  </div>
</template>
<style scoped>
.om-disclosure {
  min-width: 0;
}
.om-disclosure + .om-disclosure {
  margin-top: 12px;
}
.disclosure-heading {
  display: flex;
  align-items: stretch;
  border-radius: 6px;
}
.disclosure-heading:hover {
  background: var(--om-soft);
}
.disclosure-toggle,
.disclosure-title {
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  min-height: 44px;
  border-radius: 6px;
}
.disclosure-toggle {
  display: grid;
  place-items: center;
  flex: 0 0 44px;
}
.disclosure-title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 10px 8px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.6;
}
.selectable .disclosure-title {
  padding-left: 0;
  font-weight: 600;
}
.disclosure-arrow {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--om-muted);
  transition: transform 0.15s;
}
.expanded > .disclosure-heading .disclosure-arrow {
  transform: rotate(90deg);
}
.disclosure-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.disclosure-meta {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 400;
  color: var(--om-muted);
}
.disclosure-content {
  padding-top: 8px;
}
.selectable > .disclosure-content {
  padding-top: 0;
}
@media (prefers-reduced-motion: reduce) {
  .disclosure-arrow {
    transition: none;
  }
}
</style>
