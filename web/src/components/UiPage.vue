<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, post } from "../api";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";

/**
 * An interactive page an agent wrote (`ui_page`, docs/v2/interactive-ui.md): a srcdoc frame with
 * `sandbox="allow-scripts"` only, so it runs with an opaque origin, and a policy in its document
 * that allows nothing from the network. It talks to us through `window.omem` (src/agents/ui-pages.ts):
 * we answer only messages from this frame, send it the theme, take its height, keep its draft and,
 * when it belongs to an open question, send its answer.
 */
const props = defineProps<{ pageId: string; version?: number; height?: number; askId?: string; canSubmit?: boolean; draft?: unknown }>();
const emit = defineEmits<{ answered: [] }>();
type Page = { id: string; version: number; versions: number[]; title: string; createdAt: string; document: string };
const page = ref<Page | null>(null);
const error = ref("");
const shown = ref<number | undefined>(props.version);
const frame = ref<HTMLIFrameElement | null>(null);
const frameHeight = ref(props.height ?? 320);
const full = ref(false);
const router = useRouter();

async function load() {
  error.value = "";
  try {
    page.value = await get<Page>(`/api/ui/pages/${encodeURIComponent(props.pageId)}${shown.value ? `?version=${shown.value}` : ""}`);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
void load();
watch(shown, load);
const index = computed(() => (page.value ? page.value.versions.indexOf(page.value.version) : -1));
const step = (d: number) => page.value && (shown.value = page.value.versions[index.value + d]);

/** The tokens the page borrows, as this page resolves them now (light or dark). */
const TOKENS = ["--bg", "--panel", "--ink", "--ink-2", "--muted", "--line", "--line-strong", "--accent", "--danger", "--ok", "--warn", "--sans", "--serif", "--mono"];
function theme() {
  const cs = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(TOKENS.map((t) => [t, cs.getPropertyValue(t).trim()]).filter(([, v]) => v));
  const dark = document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  return { omemUi: 1, type: "theme", theme: dark ? "dark" : "light", tokens };
}
const send = (m: Record<string, unknown>) => frame.value?.contentWindow?.postMessage({ omemUi: 1, ...m }, "*");

let draftTimer: ReturnType<typeof setTimeout> | null = null;
async function onMessage(e: MessageEvent) {
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const d = e.data as { omemUi?: number; type?: string; [k: string]: unknown };
  if (!d || d.omemUi !== 1) return;
  if (d.type === "ready") {
    send(theme());
    send({ type: "init", init: { draft: props.draft ?? null, canSubmit: !!(props.askId && props.canSubmit) } });
  } else if (d.type === "height" && typeof d.height === "number") {
    frameHeight.value = Math.max(80, Math.min(4000, Math.ceil(d.height)));
  } else if (d.type === "submit") {
    if (!props.askId || !props.canSubmit) return send({ type: "result", id: d.id, ok: false, error: "这个页面只用来看，不能提交" });
    try {
      const value = d.value && typeof d.value === "object" && !Array.isArray(d.value) ? d.value : { value: d.value };
      await post(`/api/asks/${props.askId}/answer`, { value, ...(typeof d.summary === "string" && d.summary.trim() ? { text: d.summary.trim().slice(0, 4000) } : {}) });
      send({ type: "result", id: d.id, ok: true });
      emit("answered");
    } catch (err) {
      send({ type: "result", id: d.id, ok: false, error: (err as Error).message });
    }
  } else if (d.type === "draft" && props.askId && props.canSubmit) {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => void post(`/api/asks/${props.askId}/draft`, { draft: d.value }).catch(() => {}), 600);
  } else if (d.type === "open" && typeof d.link === "string" && d.link.startsWith("#/")) {
    // Only omem's own pages: a page cannot send the person anywhere else.
    void router.push(d.link.slice(1));
  }
}
const themeWatch = new MutationObserver(() => send(theme()));
const scheme = matchMedia("(prefers-color-scheme: dark)");
const onScheme = () => send(theme());
const onKey = (e: KeyboardEvent) => e.key === "Escape" && full.value && (full.value = false);
onMounted(() => {
  addEventListener("message", onMessage);
  addEventListener("keydown", onKey);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  scheme.addEventListener("change", onScheme);
});
onBeforeUnmount(() => {
  removeEventListener("message", onMessage);
  removeEventListener("keydown", onKey);
  themeWatch.disconnect();
  scheme.removeEventListener("change", onScheme);
  if (draftTimer) clearTimeout(draftTimer);
});
const inline = computed(() => (full.value ? undefined : `${Math.min(frameHeight.value, 640)}px`));
</script>

<template>
  <section class="ui-page" :class="{ full }" :aria-label="page?.title || '交互页'">
    <header class="bar">
      <span class="title">{{ page?.title || "交互页" }}</span>
      <span v-if="page && page.versions.length > 1" class="versions small muted">
        <button class="btn ghost sm icon" :disabled="index <= 0" aria-label="上一版" @click="step(-1)"><Icon name="left" :size="14" /></button>
        第 {{ page.version }} 版，共 {{ page.versions.length }} 版
        <button class="btn ghost sm icon" :disabled="index >= page.versions.length - 1" aria-label="下一版" @click="step(1)"><Icon name="right" :size="14" /></button>
      </span>
      <span class="spacer" />
      <button class="btn ghost sm" :aria-pressed="full" @click="full = !full">{{ full ? "退出全屏" : "全屏" }}</button>
    </header>
    <p v-if="error" class="muted small pad">{{ error }}</p>
    <Skeleton v-else-if="!page" :rows="3" />
    <iframe
      v-else
      ref="frame"
      :key="`${page.id}:${page.version}`"
      class="frame"
      :style="{ height: inline }"
      :srcdoc="page.document"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      :title="page.title"
    />
  </section>
</template>

<style scoped>
.ui-page {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ui-page.full {
  position: fixed;
  inset: 12px;
  z-index: 60;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--line);
  min-width: 0;
}
.title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.versions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.frame {
  display: block;
  width: 100%;
  border: 0;
  background: transparent;
}
.full .frame {
  flex: 1;
}
.pad {
  padding: 12px;
}
</style>
