<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { PickStartMode } from "../shared/pick-messages";
import PickComposer from "./PickComposer.vue";
import PickRecordDetail from "./PickRecordDetail.vue";
import { usePickBasket } from "./use-pick-basket";

const basket = usePickBasket();
const { items, loading, draft, draftLoaded, notice, needsPermission } = basket;
const expandedId = ref<string | null>(null);
const flashId = ref<string | null>(null);
const confirmClear = ref(false);
const confirmRemove = ref<string | null>(null);
const copyState = ref("");
const composer = ref<InstanceType<typeof PickComposer>>();

const records = computed(() => items.value.map((item) => item.record));
const citedCount = computed(() => new Set(draft.value.filter((segment) => segment.type === "ref").map((segment) => (segment as { id: string }).id)).size);
const hasDraft = computed(() => draft.value.some((segment) => segment.type === "ref" || segment.text.trim()));

const modes: Array<{ mode: PickStartMode; label: string }> = [
  { mode: "element", label: "元素" },
  { mode: "region", label: "区域" },
  { mode: "viewport", label: "可视区" },
  { mode: "page", label: "整页" }
];

function toggle(id: string): void {
  expandedId.value = expandedId.value === id ? null : id;
  confirmRemove.value = null;
}

function cite(id: string): void {
  composer.value?.insertRef(id);
}

async function focusRecord(id: string): Promise<void> {
  expandedId.value = id;
  flashId.value = id;
  await nextTick();
  document.querySelector(`[data-record="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  setTimeout(() => (flashId.value = null), 1200);
}

async function remove(id: string): Promise<void> {
  // 删除前在按钮上再确认一次，不弹系统对话框。
  if (confirmRemove.value !== id) {
    confirmRemove.value = id;
    return;
  }
  confirmRemove.value = null;
  expandedId.value = null;
  await basket.remove([id]);
}

async function clearAll(): Promise<void> {
  if (!confirmClear.value) {
    confirmClear.value = true;
    setTimeout(() => (confirmClear.value = false), 3000);
    return;
  }
  confirmClear.value = false;
  composer.value?.clear();
  await basket.clearAll();
}

async function copyMarkdown(): Promise<void> {
  await navigator.clipboard.writeText(basket.markdown());
  copyState.value = "已复制";
  setTimeout(() => (copyState.value = ""), 1800);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function time(value: number): string {
  const date = new Date(value);
  const today = new Date();
  const hm = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === today.toDateString() ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}
</script>

<template>
  <main class="basket">
    <header class="basket-header">
      <div class="basket-title">
        <strong>拾取篮</strong>
        <span v-if="items.length" class="muted">{{ items.length }} 条</span>
      </div>
      <div class="basket-start" role="group" aria-label="开始拾取">
        <button
          v-for="item in modes"
          :key="item.mode"
          class="button"
          type="button"
          :data-testid="`basket-start-${item.mode}`"
          @click="basket.start(item.mode)"
        >
          {{ item.label }}
        </button>
      </div>
    </header>
    <p v-if="notice" class="basket-notice">
      <span>{{ notice }}</span>
      <button v-if="needsPermission" class="button" type="button" @click="basket.grantAllSites()">授权所有网站</button>
    </p>

    <section class="basket-list" aria-label="记录">
      <div v-if="loading" class="basket-skeleton" aria-hidden="true"><i /><i /><i /></div>
      <div v-else-if="!items.length" class="basket-empty">
        <strong>还没有记录</strong>
        <p>在页面上选元素、框区域或截整页，「记下」后会出现在这里。快捷键 Alt+Shift+X 开始选元素。</p>
        <button class="button button-primary" type="button" @click="basket.start('element')">开始拾取</button>
      </div>
      <article
        v-for="item in items"
        v-else
        :key="item.record.id"
        class="record-card"
        :data-record="item.record.id"
        :class="{ 'is-open': expandedId === item.record.id, 'is-flash': flashId === item.record.id }"
      >
        <div class="record-row" role="button" tabindex="0" :aria-expanded="expandedId === item.record.id" @click="toggle(item.record.id)" @keydown.enter.space.prevent="toggle(item.record.id)">
          <img class="record-thumb" :src="item.thumbUrl" alt="" />
          <div class="record-meta">
            <div class="record-name"><b>#{{ item.record.seq }}</b><span :title="item.record.title">{{ item.record.title }}</span></div>
            <div class="record-sub muted">{{ host(item.record.pageUrl) }} · {{ time(item.record.createdAt) }}</div>
            <div v-if="item.record.note" class="record-note-preview">{{ item.record.note }}</div>
          </div>
          <button class="button button-ghost record-cite" type="button" title="引用到输入框" @click.stop="cite(item.record.id)">引用</button>
        </div>
        <PickRecordDetail
          v-if="expandedId === item.record.id"
          :record="item.record"
          @save-note="(note) => basket.saveNote(item.record.id, note)"
          @cite="cite(item.record.id)"
          @remove="remove(item.record.id)"
        />
        <p v-if="confirmRemove === item.record.id" class="record-confirm">再点一次「删除」确认，删除后不能恢复。</p>
      </article>
    </section>

    <footer class="composer">
      <PickComposer
        ref="composer"
        :segments="draft"
        :ready="draftLoaded"
        :records="records"
        @change="basket.setDraft"
        @focus-record="focusRecord"
      />
      <div class="composer-actions">
        <span class="muted">{{ citedCount ? `引用 ${citedCount} 条` : "" }}</span>
        <span class="grow" />
        <button v-if="items.length" class="button button-ghost" type="button" :class="{ 'button-danger': confirmClear }" @click="clearAll">
          {{ confirmClear ? "确认清空全部" : "清空" }}
        </button>
        <button class="button" type="button" :disabled="!hasDraft" data-testid="pick-copy-markdown" @click="copyMarkdown">{{ copyState || "复制为 Markdown" }}</button>
        <button class="button button-primary" type="button" disabled title="即将支持：整理后连同截图发给 omem">发给 omem</button>
      </div>
    </footer>
  </main>
</template>
