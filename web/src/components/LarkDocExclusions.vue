<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, put } from "../api";
import { toast } from "../store";
import UiCheckbox from "./UiCheckbox.vue";

/**
 * Which Feishu documents omem leaves out when it keeps them on its own (src/channels/lark-doc-filter.ts):
 * one's personal document library as a switch, and single documents, knowledge-base pages (with what is
 * under them), whole knowledge bases or cloud-space folders by link. Everyone edits their own list:
 * members on the account page, the owner in 设置 → 采集 → 飞书文档.
 */
type Rule = { kind: "doc" | "wiki" | "space" | "folder"; token: string; url: string; title?: string };
type Capture = { on: boolean; skipLibrary: boolean; exclude: Rule[] };
const props = defineProps<{ disabled?: boolean }>();
const c = ref<Capture | null>(null);
const link = ref("");
const busy = ref(false);
const KIND: Record<Rule["kind"], string> = { doc: "文档", wiki: "知识库页面及其子页面", space: "整个知识库", folder: "文件夹" };

async function save(patch: { skipLibrary?: boolean; add?: string; remove?: string }, note: string) {
  busy.value = true;
  try {
    c.value = (await put<{ capture: Capture }>("/api/lark/doc-capture", patch)).capture;
    toast(note, "ok");
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  } finally {
    busy.value = false;
  }
}
async function add() {
  const url = link.value.trim();
  if (url && (await save({ add: url }, "已排除"))) link.value = "";
}
onMounted(async () => {
  c.value = (await get<{ capture: Capture }>("/api/lark/doc-capture").catch(() => ({ capture: null }))).capture;
});
</script>

<template>
  <div v-if="c" class="stack tight doc-ex" :class="{ off: props.disabled }">
    <div class="row wrap line">
      <div class="stack tight grow">
        <span>不读我的个人文档库</span>
        <span class="muted small">飞书“我的文档库”（个人知识库）里的文档不存进 omem</span>
      </div>
      <UiCheckbox :model-value="c.skipLibrary" switch size="sm" :disabled="busy || props.disabled" aria-label="不读我的个人文档库" @change="(v) => save({ skipLibrary: v }, v ? '个人文档库不再读取' : '个人文档库也会读取')" />
    </div>
    <div class="stack tight line">
      <span>另外排除</span>
      <span class="muted small">贴文档、知识库页面（连同下面的子页面）、知识库首页或云空间文件夹的链接。它们和从别的文档链过去的都不再自动存进 omem；已经存进来的不会删，你自己让助手读的照常读。</span>
      <form class="row wrap add" @submit.prevent="add">
        <input v-model="link" class="input grow" type="url" placeholder="https://tenant.larkoffice.com/wiki/…" aria-label="要排除的飞书链接" :disabled="busy || props.disabled" />
        <button class="btn sm" type="submit" :disabled="busy || props.disabled || !link.trim()">排除</button>
      </form>
      <div v-for="r in c.exclude" :key="r.kind + r.token" class="row wrap rule">
        <span class="badge">{{ KIND[r.kind] }}</span>
        <a class="grow ellipsis small" :href="r.url" target="_blank" rel="noopener" :title="r.url">{{ r.title || r.url }}</a>
        <button class="btn ghost sm" :disabled="busy" @click="save({ remove: r.token }, '已恢复读取')">移除</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.doc-ex.off {
  opacity: 0.6;
}
.line {
  border-top: 1px solid var(--line);
  padding-top: 6px;
  gap: 8px;
  min-width: 0;
}
.grow {
  flex: 1;
  min-width: 0;
}
.add {
  gap: 6px;
}
.add .input {
  min-width: 200px;
}
.rule {
  gap: 8px;
  min-width: 0;
}
</style>
