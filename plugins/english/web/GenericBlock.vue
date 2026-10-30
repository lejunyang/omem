<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { renderBlock, type BlockView } from "omem-plugin-sdk";

/** A host block (form, chart) the tutor handed in, drawn by the SDK's renderer. */
const props = defineProps<{ block: BlockView; submit: (answers: Record<string, unknown>) => Promise<void> }>();
const el = ref<HTMLElement | null>(null);
const draw = () => el.value && renderBlock(el.value, props.block, { submit: props.submit });
onMounted(draw);
// Redraw when the block changes (handed in), not on every refresh: typed answers would be lost.
watch(() => `${props.block.status}:${JSON.stringify(props.block.result)}`, draw);
</script>

<template>
  <div ref="el" />
</template>
