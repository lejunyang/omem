<script setup lang="ts">
import HelpText from "./HelpText.vue";

/**
 * A card of settings (styles.css `.set-card`): a 15px title, at most one line under it (the `help`
 * slot, a HelpText: the rest behind its ⓘ), then SetRow rows. `aside`: a badge or a button beside
 * the title. The page's contents column lists cards by their `.set-title`.
 */
defineProps<{ title: string }>();
</script>

<template>
  <section class="card set-card">
    <header class="set-card-head">
      <div class="set-card-title"><h3 class="set-title">{{ title }}</h3><slot name="aside" /></div>
      <HelpText v-if="$slots.help"><slot name="help" /></HelpText>
    </header>
    <div class="set-card-body"><slot /></div>
  </section>
</template>
