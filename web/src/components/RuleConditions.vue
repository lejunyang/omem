<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * Editing a rule's conditions as rows the owner can read: "群名 包含 报警". Two levels (a group of
 * rows, rows can be a sub-group); anything deeper is edited as JSON. The JSON language is the one
 * the host evaluates (src/rules/types.ts).
 */
type Leaf = { field: string; op: string; value: string | boolean | string[] };
export type Condition = Leaf | { all: Condition[] } | { any: Condition[] } | { not: Condition };
type Row = { kind: "leaf"; negate: boolean; field: string; op: string; value: string } | { kind: "group"; mode: "all" | "any"; rows: Row[] };

const props = defineProps<{ modelValue: Condition | null; fields: Record<string, string>; ops: readonly string[]; descriptions?: Record<string, string>; valueOptions?: Record<string, { value: string; label: string }[]>; boolFields?: string[]; fieldOps?: Record<string, string[]> }>();
const emit = defineEmits<{ "update:modelValue": [value: Condition | null] }>();

const OP_LABEL: Record<string, string> = { gte: "≥", lte: "≤", equals: "是", contains: "包含", startsWith: "开头是", endsWith: "结尾是", matches: "匹配正则", in: "是其中之一（逗号分隔）", is: "为" };
const BOOL_FIELDS = new Set(["message.mentionsOwner", "message.mentionsBot", "message.inTopic", "chat.hasOwnBot"]);
const isBool = (f: string) => BOOL_FIELDS.has(f) || !!props.boolFields?.includes(f);

const mode = ref<"all" | "any">("all");
const rows = ref<Row[]>([]);
const raw = ref("");
const rawMode = ref(false);
const rawError = ref("");

function leafRow(c: Condition, negate = false): Row | null {
  if ("not" in c) return "field" in c.not ? leafRow(c.not, !negate) : null;
  if ("field" in c) return { kind: "leaf", negate, field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value.map(v => props.valueOptions?.[c.field]?.find(o => o.value === v)?.label ?? v).join("，") : String(c.value) };
  return null;
}
function fromCondition(c: Condition | null): { mode: "all" | "any"; rows: Row[] } | null {
  if (!c) return { mode: "all", rows: [] };
  const top = "all" in c ? { mode: "all" as const, list: c.all } : "any" in c ? { mode: "any" as const, list: c.any } : { mode: "all" as const, list: [c] };
  const out: Row[] = [];
  for (const x of top.list) {
    const leaf = leafRow(x);
    if (leaf) out.push(leaf);
    else if ("all" in x || "any" in x) {
      const sub = "all" in x ? { mode: "all" as const, list: x.all } : { mode: "any" as const, list: (x as { any: Condition[] }).any };
      const subRows = sub.list.map((y) => leafRow(y));
      if (subRows.some((r) => !r)) return null;
      out.push({ kind: "group", mode: sub.mode, rows: subRows as Row[] });
    } else return null;
  }
  return { mode: top.mode, rows: out };
}
function toLeaf(r: Extract<Row, { kind: "leaf" }>): Condition {
  const key = (s: string) => props.valueOptions?.[r.field]?.find(o => o.label === s)?.value ?? s;
  const value = r.op === "is" ? r.value !== "false" : r.op === "in" ? r.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).map(key) : key(r.value);
  const leaf: Leaf = { field: r.field, op: r.op, value };
  return r.negate ? { not: leaf } : leaf;
}
function toCondition(): Condition | null {
  const list = rows.value
    .map((r) => (r.kind === "leaf" ? toLeaf(r) : r.rows.length ? ({ [r.mode]: r.rows.map((x) => toLeaf(x as Extract<Row, { kind: "leaf" }>)) } as Condition) : null))
    .filter((x): x is Condition => !!x);
  if (!list.length) return null;
  return mode.value === "all" ? { all: list } : { any: list };
}

let syncing = false;
watch(
  () => props.modelValue,
  (c) => {
    if (syncing) return;
    const parsed = fromCondition(c);
    raw.value = JSON.stringify(c, null, 2);
    rawError.value = "";
    if (!parsed) {
      rawMode.value = true;
      return;
    }
    mode.value = parsed.mode;
    rows.value = parsed.rows;
  },
  { immediate: true },
);
function push() {
  syncing = true;
  const c = toCondition();
  raw.value = JSON.stringify(c, null, 2);
  emit("update:modelValue", c);
  queueMicrotask(() => (syncing = false));
}
function applyRaw() {
  try {
    const c = raw.value.trim() ? (JSON.parse(raw.value) as Condition) : null;
    rawError.value = "";
    emit("update:modelValue", c);
  } catch (e) {
    rawError.value = (e as Error).message;
  }
}

const fieldOptions = computed(() => Object.entries(props.fields).map(([value, label]) => ({ value, label })));
const opOptions = (field: string) => (isBool(field) ? [{ value: "is", label: "为" }] : props.ops.filter((o) => o !== "is" && (props.fieldOps?.[field] ? props.fieldOps[field].includes(o) : (!props.valueOptions?.[field] || ["equals", "in"].includes(o)) && !["gte", "lte"].includes(o))).map((o) => ({ value: o, label: OP_LABEL[o] ?? o })));
function newLeaf(): Row {
  const field = Object.keys(props.fields)[0] ?? "chat.name";
  const op = props.valueOptions?.[field] ? "equals" : opOptions(field).some((o) => o.value === "contains") ? "contains" : opOptions(field)[0]?.value ?? "contains";
  return { kind: "leaf", negate: false, field, op, value: op === "is" ? "true" : "" };
}
function addRow(target: Row[] = rows.value) {
  target.push(newLeaf());
  push();
}
function addGroup() {
  rows.value.push({ kind: "group", mode: "any", rows: [newLeaf()] });
  push();
}
function remove(list: Row[], i: number) {
  list.splice(i, 1);
  push();
}
function onOp(r: Extract<Row, { kind: "leaf" }>) {
  const options = props.valueOptions?.[r.field];
  if (options) r.value = r.op === "in" ? (options.find(o => o.value === r.value)?.label ?? r.value) : (options.find(o => o.value === r.value || o.label === r.value)?.value ?? "");
  push();
}
function onField(r: Extract<Row, { kind: "leaf" }>, f: string) {
  r.field = f;
  const allowed = opOptions(f).map((o) => o.value);
  if (isBool(f)) (r.op = "is"), (r.value = "true");
  else if (props.valueOptions?.[f]) (r.op = "equals"), (r.value = "");
  else if (!allowed.includes(r.op)) (r.op = allowed[0]), (r.value = "");
  push();
}
</script>

<template>
  <div class="conds">
    <div class="row head">
      <template v-if="!rawMode">
        <UiSegmented v-model="mode" size="sm" :options="[{ value: 'all', label: '全部满足' }, { value: 'any', label: '满足任一' }]" aria-label="组合方式" @change="push" />
        <span class="spacer" />
      </template>
      <span v-else class="muted small grow">条件嵌套较深，用 JSON 编辑</span>
      <button class="btn ghost sm" type="button" @click="rawMode = !rawMode">{{ rawMode ? "逐条编辑" : "JSON" }}</button>
    </div>

    <template v-if="!rawMode">
      <template v-for="(r, i) in rows" :key="i">
        <div v-if="r.kind === 'leaf'" class="cond">
          <UiCheckbox v-model="r.negate" size="sm" aria-label="取反" @change="push">不</UiCheckbox>
          <UiSelect :model-value="r.field" size="sm" width="150px" :options="fieldOptions" aria-label="字段" @change="(v) => onField(r, v as string)" />
          <UiSelect v-model="r.op" size="sm" width="132px" :options="opOptions(r.field)" aria-label="运算" @change="onOp(r)" />
          <UiSelect v-if="r.op === 'is'" v-model="r.value" size="sm" width="90px" :options="[{ value: 'true', label: '是' }, { value: 'false', label: '否' }]" aria-label="值" @change="push" />
          <div v-else-if="valueOptions?.[r.field] && r.op === 'equals'" class="grow"><UiSelect v-model="r.value" size="sm" :options="valueOptions[r.field]" aria-label="值" @change="push" /></div>
          <input v-else v-model="r.value" class="input sm grow" :placeholder="r.op === 'in' ? '小王，小李' : '值'" @change="push" />
          <button class="btn ghost sm icon" type="button" title="删除这一条" @click="remove(rows, i)"><Icon name="x" :size="13" /></button>
          <small v-if="descriptions?.[r.field]" class="muted field-help">{{ descriptions[r.field] }}</small>
        </div>
        <div v-else class="group">
          <div class="row">
            <UiSegmented v-model="r.mode" size="sm" :options="[{ value: 'any', label: '满足任一' }, { value: 'all', label: '全部满足' }]" aria-label="子组合" @change="push" />
            <span class="spacer" />
            <button class="btn ghost sm" type="button" @click="addRow(r.rows)"><Icon name="plus" :size="12" />一条</button>
            <button class="btn ghost sm icon" type="button" title="删除这一组" @click="remove(rows, i)"><Icon name="x" :size="13" /></button>
          </div>
          <div v-for="(x, j) in r.rows" :key="j" class="cond">
            <template v-if="x.kind === 'leaf'">
              <UiCheckbox v-model="x.negate" size="sm" aria-label="取反" @change="push">不</UiCheckbox>
              <UiSelect :model-value="x.field" size="sm" width="150px" :options="fieldOptions" aria-label="字段" @change="(v) => onField(x, v as string)" />
              <UiSelect v-model="x.op" size="sm" width="132px" :options="opOptions(x.field)" aria-label="运算" @change="onOp(x)" />
              <UiSelect v-if="x.op === 'is'" v-model="x.value" size="sm" width="90px" :options="[{ value: 'true', label: '是' }, { value: 'false', label: '否' }]" aria-label="值" @change="push" />
              <div v-else-if="valueOptions?.[x.field] && x.op === 'equals'" class="grow"><UiSelect v-model="x.value" size="sm" :options="valueOptions[x.field]" aria-label="值" @change="push" /></div>
              <input v-else v-model="x.value" class="input sm grow" :placeholder="x.op === 'in' ? '小王，小李' : '值'" @change="push" />
              <button class="btn ghost sm icon" type="button" title="删除这一条" @click="remove(r.rows, j)"><Icon name="x" :size="13" /></button>
              <small v-if="descriptions?.[x.field]" class="muted field-help">{{ descriptions[x.field] }}</small>
            </template>
          </div>
        </div>
      </template>
      <p v-if="!rows.length" class="muted small">还没有条件。</p>
      <div class="row adds">
        <button class="btn ghost sm" type="button" @click="addRow()"><Icon name="plus" :size="12" />条件</button>
        <button class="btn ghost sm" type="button" @click="addGroup"><Icon name="plus" :size="12" />一组“或”</button>
      </div>
    </template>
    <template v-else>
      <textarea v-model="raw" class="input mono json" rows="10" spellcheck="false" aria-label="条件 JSON" @change="applyRaw" />
      <small v-if="rawError" class="error">{{ rawError }}</small>
    </template>
  </div>
</template>

<style scoped>
.conds {
  display: grid;
  gap: 8px;
}
.head {
  gap: 8px;
}
.cond {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
}
.group {
  border-left: 2px solid var(--line);
  padding-left: 10px;
  display: grid;
  gap: 6px;
}
.adds {
  gap: 6px;
}
.grow {
  flex: 1;
  min-width: 120px;
}
.field-help { flex-basis: 100%; line-height: 1.6; }
.json {
  font-size: 12px;
}
.error {
  color: var(--danger);
}
</style>
