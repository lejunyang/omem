<script setup lang="ts">
import { ref } from "vue";
import { checkPath, tilde } from "../lib/sandbox";
import Icon from "./Icon.vue";
import MonoLine from "./MonoLine.vue";

/**
 * One of the sandbox's two lists of directories (设置 → 安全 → 运行的沙箱): one line a directory with a
 * button to take it away, and a line to add one. Each change is saved at once (`save` sends the whole
 * list); when the server refuses it, its words stay under the line that was changed, not in a toast.
 */
const props = defineProps<{ items: string[]; home: string | null; label: string; placeholder: string; save: (next: string[]) => Promise<string | null> }>();
const draft = ref("");
const addError = ref("");
const busy = ref(false);
/** A refused removal, by path. */
const rowError = ref<Record<string, string>>({});

async function add() {
  const r = checkPath(draft.value, props.items, props.home);
  if ("error" in r) return void (addError.value = r.error);
  busy.value = true;
  const error = await props.save([...props.items, r.value]);
  busy.value = false;
  addError.value = error ?? "";
  if (!error) draft.value = "";
}
async function remove(path: string) {
  busy.value = true;
  const error = await props.save(props.items.filter((p) => p !== path));
  busy.value = false;
  rowError.value = { ...rowError.value, [path]: error ?? "" };
}
</script>

<template>
  <div class="sbx-paths">
    <ul v-if="items.length" class="sbx-list" :aria-label="label">
      <li v-for="p in items" :key="p" class="sbx-item">
        <div class="sbx-line">
          <MonoLine :text="tilde(p, home)" />
          <button type="button" class="btn ghost sm icon" :disabled="busy" :aria-label="`从${label}去掉 ${tilde(p, home)}`" title="去掉" @click="remove(p)"><Icon name="x" :size="13" /></button>
        </div>
        <p v-if="rowError[p]" class="sbx-err" role="alert">{{ rowError[p] }}</p>
      </li>
    </ul>
    <form class="sbx-add" @submit.prevent="add">
      <div class="sbx-line">
        <input v-model="draft" class="input sm mono" :placeholder="placeholder" :aria-label="`加到${label}`" :aria-invalid="!!addError || undefined" spellcheck="false" maxlength="1024" @input="addError = ''" />
        <button class="btn ghost sm" type="submit" :disabled="busy || !draft.trim()"><Icon name="plus" :size="13" />加入</button>
      </div>
      <p v-if="addError" class="sbx-err" role="alert">{{ addError }}</p>
    </form>
  </div>
</template>
