<script setup lang="ts">
import { toast } from "../store";

/** A long technical string (path, command line, id) on one line: the whole of it on hover, and a copy button. */
const props = defineProps<{ text: string; copy?: boolean }>();
async function copyText() {
  try {
    await navigator.clipboard.writeText(props.text);
    toast("已复制", "ok");
  } catch {
    toast("复制失败，请手动选中复制", "error");
  }
}
</script>

<template>
  <span class="mono-line">
    <code :title="text">{{ text }}</code>
    <button v-if="copy" type="button" class="btn ghost sm" :aria-label="`复制 ${text}`" @click.stop="copyText">复制</button>
  </span>
</template>
