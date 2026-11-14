<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { get, post } from "../api";
import UiCheckbox from "./UiCheckbox.vue";
import Skeleton from "./Skeleton.vue";
import HelpText from "./HelpText.vue";
import VirtualList from "./VirtualList.vue";

type Kind = "agents" | "skills" | "rules" | "mcp" | "spaces";
type Choices = Record<Kind, { id: string; name: string }[]>;
const kinds: { key: Kind; label: string }[] = [{ key: "spaces", label: "空间" }, { key: "agents", label: "Agent 档案" }, { key: "skills", label: "技能" }, { key: "rules", label: "规则" }, { key: "mcp", label: "MCP 服务" }];
const opened = ref(false), loading = ref(false), busy = ref(false), error = ref("");
const choices = ref<Choices | null>(null);
const selected = ref<Record<Kind, string[]>>({ spaces: [], agents: [], skills: [], rules: [], mcp: [] });
const id = ref(""), name = ref(""), description = ref("");
const result = ref<{ dir: string; warnings: string[] } | null>(null);
const trigger = ref<HTMLButtonElement | null>(null), first = ref<HTMLInputElement | null>(null);
let seq = 0;
async function open() {
  opened.value = true; loading.value = true; error.value = "";
  const request = ++seq;
  await nextTick(); first.value?.focus();
  try { const data = await get<Choices>("/api/plugins/pack"); if (request === seq) choices.value = data; }
  catch (e) { if (request === seq) error.value = (e as Error).message; }
  finally { if (request === seq) loading.value = false; }
}
function close() { if (busy.value) return; opened.value = false; ++seq; trigger.value?.focus(); }
function select(kind: Kind, value: string, on: boolean) { selected.value[kind] = on ? [...selected.value[kind], value] : selected.value[kind].filter((n) => n !== value); }
async function pack() {
  busy.value = true; error.value = ""; result.value = null;
  try { result.value = await post("/api/plugins/pack", { id: id.value, name: name.value, description: description.value, ...selected.value }); }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
const keydown = (e: KeyboardEvent) => { if (e.key === "Escape" && opened.value) close(); };
onMounted(() => window.addEventListener("keydown", keydown));
onBeforeUnmount(() => { ++seq; window.removeEventListener("keydown", keydown); });
</script>

<template>
  <div class="card pad stack pack">
    <div class="row wrap"><strong>打成场景包</strong><span class="spacer" /><button ref="trigger" class="btn sm" :aria-expanded="opened" @click="opened ? close() : open()">{{ opened ? "收起" : "打成场景包" }}</button></div>
    <HelpText>把已有空间、档案、技能、规则和 MCP 定义打成场景包。空间只带名称、类型、说明和技能挂载，不带内容；个人和代码仓库空间不能打包。技能含完整资源，规则停用；MCP 密钥值不导出，其他文本中有已存密钥或用户目录绝对路径时拒绝写入。</HelpText>
    <form v-if="opened" class="stack" @submit.prevent="pack">
      <label class="field"><span>id（小写字母和数字，2–24 字符）</span><input ref="first" v-model="id" class="input" required pattern="[a-z][a-z0-9]{1,23}" /></label>
      <label class="field"><span>名字</span><input v-model="name" class="input" required /></label>
      <label class="field"><span>说明</span><textarea v-model="description" class="textarea" rows="2" /></label>
      <Skeleton v-if="loading" :rows="4" />
      <div v-else-if="choices" class="choices">
        <fieldset v-for="kind in kinds" :key="kind.key" class="stack">
          <legend>{{ kind.label }}</legend>
          <p v-if="!choices[kind.key].length" class="muted small">还没有{{ kind.label }}。</p>
          <div class="check-list">
            <VirtualList v-if="choices[kind.key].length > 200" :items="choices[kind.key]" :item-key="(item) => item.id" :estimate="32">
              <template #default="{ item }"><UiCheckbox :aria-label="item.name" :model-value="selected[kind.key].includes(item.id)" @change="(v) => select(kind.key, item.id, v)">{{ item.name }}</UiCheckbox></template>
            </VirtualList>
            <template v-else><UiCheckbox v-for="item in choices[kind.key]" :key="item.id" :aria-label="item.name" :model-value="selected[kind.key].includes(item.id)" @change="(v) => select(kind.key, item.id, v)">{{ item.name }}</UiCheckbox></template>
          </div>
        </fieldset>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="row wrap"><button class="btn primary" type="submit" :disabled="busy || loading || !choices">{{ busy ? "正在打包…" : "写入场景包" }}</button><span class="hint">写到服务器的数据目录 plugins-out/&lt;id&gt;/，已有目录不会覆盖。</span></div>
      <div v-if="result" class="stack" role="status"><strong>已写入</strong><p class="mono">{{ result.dir }}</p><p v-for="warning in result.warnings" :key="warning" class="hint">{{ warning }}</p></div>
    </form>
  </div>
</template>

<style scoped>
.pack { min-width: 0; overflow-wrap: anywhere; }
.choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
fieldset { min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 12px; }
legend { padding: 0 5px; }
.check-list { display: grid; gap: 8px; max-height: 280px; overflow: auto; }
.error { color: var(--danger); white-space: pre-wrap; }
</style>
