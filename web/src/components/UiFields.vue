<script setup lang="ts">
import { computed } from "vue";
import { fieldVisible, type UiField } from "omem-plugin-sdk/blocks";
import UiCheckbox from "./UiCheckbox.vue";
import UiDateTime from "./UiDateTime.vue";

/**
 * A question's fields (ask_user `fields`, docs/v2/interactive-ui.md) with omem's own controls.
 * `values` is filled in place; the server checks it again when the answer is sent.
 */
const props = defineProps<{ fields: UiField[]; values: Record<string, unknown>; idPrefix: string }>();
const shown = computed(() => props.fields.filter((f) => fieldVisible(f, props.values)));
const fid = (f: UiField) => `${props.idPrefix}-${f.id}`;

const optionsOf = (f: UiField) => (f.type === "choice" ? f.options : ["1", "2", "3", "4", "5"]);
const list = (f: UiField) => (props.values[f.id] as string[] | undefined) ?? [];
function toggle(f: UiField, o: string) {
  const s = new Set(list(f));
  s.has(o) ? s.delete(o) : s.add(o);
  props.values[f.id] = (f as { options: string[] }).options.filter((x) => s.has(x));
}
type Check = Record<string, { choice?: string; note?: string }>;
const checks = (f: UiField) => ((props.values[f.id] ??= {}) as Check);
const setCheck = (f: UiField, item: string, patch: { choice?: string; note?: string }) => {
  const m = checks(f);
  m[item] = { ...m[item], ...patch };
};
/** A date field keeps the local day; the picker gives a moment. */
const localDay = (iso: string | null) => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const asMoment = (day: unknown) => (typeof day === "string" && day ? new Date(`${day}T09:00:00`).toISOString() : null);
</script>

<template>
  <div class="ui-fields">
    <div v-for="f in shown" :key="f.id" class="field" role="group" :aria-labelledby="fid(f)">
      <span :id="fid(f)" class="label">{{ f.label }}<span v-if="f.required" class="req" aria-hidden="true">*</span></span>
      <span v-if="f.help" class="muted small">{{ f.help }}</span>
      <input v-if="f.type === 'text'" class="input" :value="values[f.id] ?? ''" :placeholder="f.placeholder" :aria-labelledby="fid(f)" @input="values[f.id] = ($event.target as HTMLInputElement).value" />
      <textarea v-else-if="f.type === 'textarea'" class="textarea" rows="3" :value="(values[f.id] as string) ?? ''" :placeholder="f.placeholder" :aria-labelledby="fid(f)" @input="values[f.id] = ($event.target as HTMLTextAreaElement).value" />
      <input v-else-if="f.type === 'number'" class="input num" type="number" :value="values[f.id] ?? ''" :min="f.min" :max="f.max" :aria-labelledby="fid(f)" @input="values[f.id] = ($event.target as HTMLInputElement).value" />
      <div v-else-if="f.type === 'choice' || f.type === 'scale'" class="options" role="radiogroup" :aria-labelledby="fid(f)">
        <button
          v-for="o in optionsOf(f)"
          :key="o"
          type="button"
          role="radio"
          class="btn sm opt"
          :aria-checked="String(values[f.id] ?? '') === o"
          @click="values[f.id] = f.type === 'scale' ? Number(o) : o"
        >{{ o }}</button>
      </div>
      <div v-else-if="f.type === 'multi'" class="options" role="group" :aria-labelledby="fid(f)">
        <button v-for="o in f.options" :key="o" type="button" class="btn sm opt" :aria-pressed="list(f).includes(o)" @click="toggle(f, o)">{{ o }}</button>
      </div>
      <UiDateTime v-else-if="f.type === 'datetime'" :model-value="(values[f.id] as string) ?? null" :aria-label="f.label" @update:model-value="(v) => (values[f.id] = v ?? undefined)" />
      <UiDateTime v-else-if="f.type === 'date'" :model-value="asMoment(values[f.id])" :aria-label="f.label" @update:model-value="(v) => (values[f.id] = localDay(v))" />
      <UiCheckbox v-else-if="f.type === 'toggle'" :model-value="!!values[f.id]" switch :aria-label="f.label" @update:model-value="(v) => (values[f.id] = !!v)" />
      <div v-else-if="f.type === 'pick'" class="cards" role="radiogroup" :aria-labelledby="fid(f)">
        <button v-for="c in f.items" :key="c.id" type="button" role="radio" class="pcard" :aria-checked="values[f.id] === c.id" @click="values[f.id] = c.id">
          <span class="label">{{ c.title }}</span>
          <span v-if="c.summary" class="summary">{{ c.summary }}</span>
          <ul v-if="c.pros?.length" aria-label="优点"><li v-for="p in c.pros" :key="p" class="pro">{{ p }}</li></ul>
          <ul v-if="c.cons?.length" aria-label="代价"><li v-for="p in c.cons" :key="p" class="con">{{ p }}</li></ul>
        </button>
      </div>
      <div v-else-if="f.type === 'checklist'" class="checklist">
        <div v-for="it in f.items" :key="it.id" class="check">
          <span>{{ it.title }}</span>
          <span v-if="it.detail" class="muted small pre">{{ it.detail }}</span>
          <div class="options" role="radiogroup" :aria-label="it.title">
            <button v-for="c in f.choices" :key="c" type="button" role="radio" class="btn sm opt" :aria-checked="checks(f)[it.id]?.choice === c" @click="setCheck(f, it.id, { choice: c })">{{ c }}</button>
          </div>
          <input v-if="f.note" class="input" placeholder="备注（可不填）" :aria-label="`${it.title} 的备注`" :value="checks(f)[it.id]?.note ?? ''" @input="setCheck(f, it.id, { note: ($event.target as HTMLInputElement).value })" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ui-fields {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.field {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.label {
  font-weight: 550;
  overflow-wrap: anywhere;
}
.req {
  color: var(--danger);
  margin-left: 2px;
}
.num {
  max-width: 200px;
}
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.opt {
  border-radius: 999px;
  font-weight: 400;
}
.opt[aria-pressed="true"],
.opt[aria-checked="true"],
.opt[aria-pressed="true"]:hover,
.opt[aria-checked="true"]:hover {
  border-color: var(--ink);
  background: var(--ink);
  color: var(--bg);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.pcard {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  gap: 6px;
  align-content: start;
  min-width: 0;
  background: var(--panel);
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.pcard:hover {
  border-color: var(--line-strong);
}
.pcard[aria-checked="true"] {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.pcard ul {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
}
.summary {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pro {
  color: var(--ink-2);
}
.con {
  color: var(--muted);
}
.checklist {
  display: grid;
}
.check {
  display: grid;
  gap: 6px;
  border-bottom: 1px solid var(--line);
  padding: 8px 0;
  min-width: 0;
}
.check:last-child {
  border-bottom: 0;
}
.pre {
  white-space: pre-wrap;
}
</style>
