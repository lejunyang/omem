<script setup lang="ts">
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";
import { computed, nextTick, ref, watch } from "vue";
import { api, post } from "../api";
import { state, toast } from "../store";
import Icon from "./Icon.vue";

const text = ref("");
const title = ref("");
const space = ref(state.space);
const ingest = ref(true);
const busy = ref(false);
const files = ref<File[]>([]);
const dragging = ref(false);
const area = ref<HTMLTextAreaElement>();
const isUrl = computed(() => /^https?:\/\/\S+$/.test(text.value.trim()));

watch(
  () => state.capture,
  async (open) => {
    if (open) {
      space.value = state.space;
      await nextTick();
      area.value?.focus();
    }
  },
);

function onDrop(e: DragEvent) {
  dragging.value = false;
  files.value.push(...Array.from(e.dataTransfer?.files ?? []));
}
function onPick(e: Event) {
  files.value.push(...Array.from((e.target as HTMLInputElement).files ?? []));
}

async function save() {
  busy.value = true;
  try {
    if (files.value.length) {
      const form = new FormData();
      for (const f of files.value) form.append("file", f, f.name);
      const r = await api<{ results: { name: string; error?: string }[] }>(`/api/sources/upload?space=${space.value}`, { method: "POST", body: form });
      const failed = r.results.filter((x) => x.error);
      toast(failed.length ? `${r.results.length - failed.length} 个文件已保存，${failed.length} 个失败：${failed[0].error}` : `已保存 ${r.results.length} 个文件`, failed.length ? "error" : "ok");
    }
    if (text.value.trim()) {
      if (isUrl.value) await post("/api/sources/url", { space: space.value, url: text.value.trim(), ingest: ingest.value });
      else await post("/api/sources/text", { space: space.value, title: title.value || undefined, text: text.value, ingest: ingest.value });
      toast(ingest.value ? "已保存，助理正在整理" : "已保存", "ok");
    }
    text.value = title.value = "";
    files.value = [];
    state.capture = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") state.capture = false;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
}
</script>

<template>
  <div v-if="state.capture" class="overlay" @mousedown.self="state.capture = false" @keydown="onKey">
    <div class="dialog" role="dialog" aria-labelledby="cap-title" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
      <header class="row">
        <h2 id="cap-title">保存材料</h2>
        <span class="spacer" />
        <button class="btn ghost sm icon" title="关闭" @click="state.capture = false"><Icon name="x" /></button>
      </header>
      <input v-if="!isUrl" v-model="title" class="input" placeholder="标题（可选）" />
      <textarea ref="area" v-model="text" class="textarea" rows="8" placeholder="粘贴笔记、聊天记录、约定，或一个网址 / 飞书文档链接。也可以把文件拖进来。" />
      <div v-if="files.length" class="files">
        <span v-for="(f, i) in files" :key="i" class="badge">{{ f.name }} <button class="x" @click="files.splice(i, 1)">×</button></span>
      </div>
      <div class="row wrap">
        <label class="btn sm"><Icon name="upload" :size="15" />选择文件<input type="file" multiple hidden @change="onPick" /></label>
        <UiSelect v-model="space" size="sm" width="160px" aria-label="保存到空间" :options="state.spaces.map((s) => ({ value: s.id, label: s.name }))" />
        <UiCheckbox v-model="ingest" size="sm" class="small">让助理整理（更新记忆与事项）</UiCheckbox>
        <span class="spacer" />
        <button class="btn primary" :disabled="busy || (!text.trim() && !files.length)" @click="save">{{ busy ? "保存中…" : "保存" }} <kbd>Ctrl ↵</kbd></button>
      </div>
    </div>
  </div>
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
  width: min(640px, calc(100vw - 24px));
  background: var(--panel);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--line);
  padding: 16px 18px;
  display: grid;
  gap: 12px;
}
.dialog.dragging {
  outline: 2px dashed var(--accent);
}
h2 {
  font-size: 16px;
}
.files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.x {
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--muted);
}
.btn kbd {
  border-color: rgba(255, 255, 255, 0.3);
  color: inherit;
  opacity: 0.7;
}
</style>
