<script setup lang="ts" generic="V extends string | number | null">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";

/**
 * Select without the native control: a button that opens a listbox.
 * Keyboard: ↑/↓ (opens), Home/End, Enter/Space to choose, Esc to close, typing jumps to a label.
 */
export type SelectOption<T> = { value: T; label: string; hint?: string; disabled?: boolean; group?: string };

const props = withDefaults(
  defineProps<{
    modelValue: V;
    options: SelectOption<V>[];
    placeholder?: string;
    size?: "sm" | "md";
    disabled?: boolean;
    ariaLabel?: string;
    /** CSS width of the trigger; the list is at least as wide. */
    width?: string;
    /** Show a filter box once there are this many options. */
    searchAt?: number;
  }>(),
  { size: "md", placeholder: "请选择", searchAt: 12 },
);
const emit = defineEmits<{ "update:modelValue": [value: V]; change: [value: V] }>();

const open = ref(false);
const active = ref(-1);
const filter = ref("");
const trigger = ref<HTMLButtonElement | null>(null);
const list = ref<HTMLElement | null>(null);
const pos = ref({ top: 0, left: 0, width: 0, up: false, maxHeight: 280 });
const uid = `sel-${Math.random().toString(36).slice(2, 9)}`;

const current = computed(() => props.options.find((o) => o.value === props.modelValue));
const shown = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return f ? props.options.filter((o) => o.label.toLowerCase().includes(f) || (o.hint ?? "").toLowerCase().includes(f)) : props.options;
});
const searchable = computed(() => props.options.length >= props.searchAt);

function place() {
  const r = trigger.value?.getBoundingClientRect();
  if (!r) return;
  const below = window.innerHeight - r.bottom - 8;
  const above = r.top - 8;
  const up = below < 220 && above > below;
  const maxHeight = Math.max(140, Math.min(320, up ? above : below));
  const width = Math.max(r.width, 160);
  const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
  pos.value = { top: up ? r.top - 4 : r.bottom + 4, left, width, up, maxHeight };
}

async function show() {
  if (props.disabled || open.value) return;
  filter.value = "";
  place();
  open.value = true;
  active.value = Math.max(0, shown.value.findIndex((o) => o.value === props.modelValue));
  await nextTick();
  (list.value?.querySelector("input") as HTMLInputElement | null)?.focus();
  scrollActive();
}
function hide(refocus = true) {
  if (!open.value) return;
  open.value = false;
  if (refocus) trigger.value?.focus();
}
function choose(o: SelectOption<V> | undefined) {
  if (!o || o.disabled) return;
  if (o.value !== props.modelValue) {
    emit("update:modelValue", o.value);
    emit("change", o.value);
  }
  hide();
}
function move(d: number) {
  const n = shown.value.length;
  if (!n) return;
  let i = active.value;
  for (let k = 0; k < n; k++) {
    i = (i + d + n) % n;
    if (!shown.value[i].disabled) break;
  }
  active.value = i;
  scrollActive();
}
function scrollActive() {
  nextTick(() => list.value?.querySelector<HTMLElement>(`[data-i="${active.value}"]`)?.scrollIntoView({ block: "nearest" }));
}

let typed = "";
let typedAt = 0;
function onKey(e: KeyboardEvent) {
  if (props.disabled) return;
  if (!open.value) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      void show();
    }
    return;
  }
  if (e.key === "Escape" || e.key === "Tab") {
    // The list is open: Esc closes it, not the dialog around it.
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation());
    hide(e.key === "Escape");
  } else if (e.key === "ArrowDown") (e.preventDefault(), move(1));
  else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
  else if (e.key === "Home") (e.preventDefault(), (active.value = 0), scrollActive());
  else if (e.key === "End") (e.preventDefault(), (active.value = shown.value.length - 1), scrollActive());
  else if (e.key === "Enter" || (e.key === " " && !searchable.value)) (e.preventDefault(), choose(shown.value[active.value]));
  else if (!searchable.value && e.key.length === 1) {
    const at = Date.now();
    typed = at - typedAt > 700 ? e.key : typed + e.key;
    typedAt = at;
    const i = shown.value.findIndex((o) => o.label.toLowerCase().startsWith(typed.toLowerCase()));
    if (i >= 0) (active.value = i), scrollActive();
  }
}

function onDoc(e: MouseEvent) {
  const t = e.target as Node;
  if (!trigger.value?.contains(t) && !list.value?.contains(t)) hide(false);
}
const onWin = () => open.value && place();
watch(open, (v) => {
  if (v) {
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
  } else {
    document.removeEventListener("mousedown", onDoc, true);
    window.removeEventListener("resize", onWin);
    window.removeEventListener("scroll", onWin, true);
  }
});
watch(filter, () => (active.value = shown.value.length ? 0 : -1));
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDoc, true);
  window.removeEventListener("resize", onWin);
  window.removeEventListener("scroll", onWin, true);
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="ui-select"
    :class="[size, { open, empty: !current, disabled }]"
    :style="width ? { width } : undefined"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="uid"
    :aria-label="ariaLabel"
    :aria-activedescendant="open && active >= 0 ? `${uid}-${active}` : undefined"
    :disabled="disabled"
    @click="open ? hide() : show()"
    @keydown="onKey"
  >
    <span class="value ellipsis">{{ current?.label ?? placeholder }}</span>
    <Icon name="down" :size="14" class="chev" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="list"
      class="ui-select-pop"
      :class="{ up: pos.up }"
      :style="{ top: `${pos.top}px`, left: `${pos.left}px`, minWidth: `${pos.width}px`, maxHeight: `${pos.maxHeight}px` }"
      @keydown="onKey"
    >
      <div v-if="searchable" class="filter"><Icon name="search" :size="14" /><input v-model="filter" placeholder="筛选" :aria-label="`筛选${ariaLabel ?? ''}`" /></div>
      <ul :id="uid" role="listbox" :aria-label="ariaLabel">
        <template v-for="(o, i) in shown" :key="String(o.value)">
          <li v-if="o.group && o.group !== shown[i - 1]?.group" class="group" role="presentation">{{ o.group }}</li>
          <li
            :id="`${uid}-${i}`"
            :data-i="i"
            role="option"
            :aria-selected="o.value === modelValue"
            :aria-disabled="o.disabled || undefined"
            class="opt"
            :class="{ active: i === active, selected: o.value === modelValue, disabled: o.disabled }"
            @mousemove="active = i"
            @mousedown.prevent
            @click="choose(o)"
          >
            <span class="check"><Icon v-if="o.value === modelValue" name="check" :size="14" /></span>
            <span class="label">{{ o.label }}<span v-if="o.hint" class="hint">{{ o.hint }}</span></span>
          </li>
        </template>
        <li v-if="!shown.length" class="none">没有匹配的选项</li>
      </ul>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-select {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 10px 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.ui-select.sm {
  height: 30px;
  font-size: 13px;
  padding: 0 8px 0 9px;
}
.ui-select:hover {
  border-color: var(--muted);
}
.ui-select:focus-visible,
.ui-select.open {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.ui-select.empty .value {
  color: var(--muted);
}
.ui-select.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.value {
  flex: 1;
  min-width: 0;
}
.chev {
  color: var(--muted);
  flex: none;
  transition: transform 0.15s;
}
.open .chev {
  transform: rotate(180deg);
}
</style>

<style>
/* Teleported to body: not scoped. */
.ui-select-pop {
  position: fixed;
  z-index: 200;
  display: flex;
  flex-direction: column;
  max-width: min(420px, calc(100vw - 16px));
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  overflow: hidden;
  animation: ui-pop 0.12s ease-out;
}
.ui-select-pop.up {
  transform: translateY(-100%);
  animation-name: ui-pop-up;
}
.ui-select-pop ul {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
}
.ui-select-pop .filter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
}
.ui-select-pop .filter input {
  flex: 1;
  border: 0;
  outline: 0;
  background: none;
  color: var(--ink);
  padding: 4px 0;
  font: inherit;
}
.ui-select-pop .opt {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 6px 6px;
  border-radius: 6px;
  cursor: pointer;
  line-height: 1.45;
}
.ui-select-pop .opt.active {
  background: var(--hover);
}
.ui-select-pop .opt.selected {
  color: var(--accent);
  font-weight: 550;
}
.ui-select-pop .opt.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ui-select-pop .check {
  width: 16px;
  flex: none;
  display: inline-flex;
  align-items: center;
}
.ui-select-pop .label {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ui-select-pop .hint {
  font-size: 12px;
  color: var(--muted);
  font-weight: 400;
}
.ui-select-pop .group {
  padding: 8px 10px 2px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.04em;
}
.ui-select-pop .none {
  padding: 10px;
  color: var(--muted);
  font-size: 13px;
}
@keyframes ui-pop {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}
@keyframes ui-pop-up {
  from {
    opacity: 0;
    transform: translateY(calc(-100% + 3px));
  }
}
</style>
