<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { PickRecord } from "../shared/pick";

const props = defineProps<{ record: PickRecord }>();
const emit = defineEmits<{ saveNote: [note: string]; remove: []; cite: [] }>();

const imageUrl = ref("");
const note = ref(props.record.note);
const copied = ref("");

watch(
  () => props.record,
  (record) => {
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
    imageUrl.value = URL.createObjectURL(record.image);
    note.value = record.note;
  },
  { immediate: true }
);
onBeforeUnmount(() => URL.revokeObjectURL(imageUrl.value));

function saveNote(): void {
  if (note.value !== props.record.note) emit("saveNote", note.value);
}

async function copyImage(): Promise<void> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [props.record.image.type || "image/png"]: props.record.image })]);
    copied.value = "已复制图片";
  } catch {
    copied.value = "复制失败，可以下载后使用";
  }
  setTimeout(() => (copied.value = ""), 2000);
}

function download(): void {
  const link = document.createElement("a");
  link.href = imageUrl.value;
  link.download = `拾取-${props.record.seq}.png`;
  link.click();
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
</script>

<template>
  <div class="record-detail">
    <a class="record-image" :href="imageUrl" target="_blank" rel="noreferrer" title="在新标签页查看原图">
      <img :src="imageUrl" :alt="record.title" />
    </a>
    <p v-if="record.notice" class="record-notice">{{ record.notice }}</p>
    <textarea
      v-model="note"
      class="filter-input record-note"
      rows="2"
      placeholder="补充说明（会随记录一起导出）"
      @blur="saveNote"
    />
    <section v-for="(element, index) in record.elements" :key="index" class="record-element">
      <header>
        <span class="record-element-tag">{{ index === 0 ? "主元素" : `次元素 ${index}` }}</span>
        <code>{{ element.selector }}</code>
        <span class="muted">{{ Math.round(element.rect.width) }} × {{ Math.round(element.rect.height) }}</span>
      </header>
      <p v-if="element.text" class="record-element-text">「{{ element.text }}」</p>
      <dl v-for="group in index === 0 ? element.styles : []" :key="group.title">
        <dt class="group-title">{{ group.title }}</dt>
        <template v-for="item in group.items" :key="item.label">
          <dt>{{ item.label }}</dt>
          <dd><i v-if="item.color" class="swatch" :style="{ background: item.color }" />{{ item.value }}</dd>
        </template>
      </dl>
    </section>
    <ul v-if="record.spacings.length" class="record-spacings">
      <li v-for="spacing in record.spacings" :key="spacing.to">
        到 <code>{{ record.elements[spacing.to]?.selector }}</code>
        <b>{{ spacing.label }}</b>
      </li>
    </ul>
    <p class="record-source">
      <a :href="record.pageUrl" target="_blank" rel="noreferrer" :title="record.pageUrl">{{ record.pageTitle || host(record.pageUrl) }}</a>
      <span>{{ new Date(record.createdAt).toLocaleString() }}</span>
    </p>
    <div class="record-actions">
      <button class="button" type="button" @click="emit('cite')">引用到输入框</button>
      <button class="button" type="button" @click="copyImage">复制图片</button>
      <button class="button" type="button" @click="download">下载</button>
      <span class="grow muted">{{ copied }}</span>
      <button class="button button-danger" type="button" @click="emit('remove')">删除</button>
    </div>
  </div>
</template>
