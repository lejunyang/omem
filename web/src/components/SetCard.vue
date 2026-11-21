<script setup lang="ts">
import { nextTick, onMounted, onUpdated, ref, watch } from "vue";
import HelpText from "./HelpText.vue";
import { useSetAccess } from "../lib/set-readonly";
import { settingsContext } from "../views/settings/ctx";

/**
 * A card of settings (styles.css `.set-card`): a 15px title, at most one line under it (the `help`
 * slot, a HelpText: the rest behind its ⓘ), then SetRow rows. `aside`: a badge or a button beside
 * the title. The page's contents column lists cards by their `.set-title`.
 *
 * `keys`: the configuration keys the card reads and writes (src/auth/settings-sections.ts). Someone who
 * may see none of them gets no card; someone who may only read gets the same card with its controls
 * out of reach and a small “只读” beside the title. No keys: shown and changeable as before.
 */
const props = defineProps<{ title: string; keys?: string[] }>();
const { access, readonly } = useSetAccess(() => props.keys);
const ctx = settingsContext();
const body = ref<HTMLElement>();
/** Lists and editors that are not a SetRow (`.set-pad`) are put out of reach the same way. */
function fence() {
  for (const el of body.value?.querySelectorAll<HTMLElement>(":scope > .set-pad") ?? []) {
    if (readonly.value) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }
}
onMounted(fence);
onUpdated(fence);
watch(readonly, () => void nextTick(fence));
</script>

<template>
  <section v-if="access.view" class="card set-card" :class="{ 'set-ro': readonly }">
    <header class="set-card-head">
      <div class="set-card-title">
        <h3 class="set-title">{{ title }}</h3>
        <span v-if="readonly && keys?.length" class="badge set-ro-badge" :title="access.ownerOnly ? `只有${ctx?.ownerName.value ?? '主人'}能改` : '你可以看，不能改'">{{ access.ownerOnly ? `只有${ctx?.ownerName.value ?? "主人"}能改` : "只读" }}</span>
        <slot name="aside" />
      </div>
      <HelpText v-if="$slots.help"><slot name="help" /></HelpText>
    </header>
    <div ref="body" class="set-card-body"><slot /></div>
  </section>
</template>
