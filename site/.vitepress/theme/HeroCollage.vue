<script setup lang="ts">
import { withBase } from "vitepress";

/**
 * The home hero's picture: three screenshots around one another (answers with citations in front,
 * memory and sources behind), each with a light and a dark version from scripts/doc-screens.ts.
 */
const cards = [
  { src: "memory", alt: "记忆：按目录分层，带来源和版本", cls: "at-back" },
  { src: "ask-citations", alt: "问答：引用贴在论断旁边", cls: "at-main" },
  { src: "sources", alt: "原件：按空间列出的文档、聊天和代码", cls: "at-front" },
];
const url = (name: string) => withBase(`/screens/${name}.png`);
</script>

<template>
  <div class="hero-collage">
    <figure v-for="c in cards" :key="c.src" class="card" :class="c.cls">
      <img class="light-only" :src="url(c.src)" :alt="c.alt" />
      <img class="dark-only" :src="url(`${c.src}-dark`)" :alt="c.alt" />
    </figure>
  </div>
</template>

<style scoped>
.hero-collage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 12;
}
.card {
  position: absolute;
  margin: 0;
  border: 1px solid var(--om-line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--om-panel);
  box-shadow: 0 10px 40px rgba(20, 20, 20, 0.14);
  animation: drift 9s ease-in-out infinite alternate;
}
/* Behind, up and to the right. */
.at-back {
  width: 58%;
  top: 0;
  right: 0;
  transform: rotate(3deg);
  --r: 3deg;
  opacity: 0.92;
  animation-delay: -3s;
}
/* The answer, in the middle. */
.at-main {
  width: 72%;
  top: 20%;
  left: 8%;
  z-index: 1;
  --r: 0deg;
}
/* In front, down and to the left. */
.at-front {
  width: 50%;
  bottom: 0;
  left: 0;
  z-index: 2;
  transform: rotate(-3deg);
  --r: -3deg;
  animation-delay: -6s;
}
@keyframes drift {
  from { transform: translateY(0) rotate(var(--r)); }
  to { transform: translateY(-8px) rotate(var(--r)); }
}
@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
}
</style>

<style>
/* Light or dark screenshots follow the site's theme (unscoped: it keys on html.dark). */
.hero-collage .card img {
  display: block;
  width: 100%;
}
.hero-collage img.dark-only,
.dark .hero-collage img.light-only {
  display: none;
}
.dark .hero-collage img.dark-only {
  display: block;
}
.dark .hero-collage .card {
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
}
</style>
