<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
import { OmDialog, OmButton, OmCitation, OmBadge, OmIcon, OmDisclosure } from "@omem/ui";
import { api, type Evidence } from "./api";
import ChatPane from "./ChatPane.vue";
import AssetImage from "./AssetImage.vue";
defineProps<{ profileId: string; model: string; effort: string }>();
const emit = defineEmits<{ saved: [] }>();
type Frame = { e: Evidence; tab: string; ask: boolean; scroll: number };
const frames = ref<Frame[]>([]);
const current = computed(() => frames.value.at(-1));
const error = ref("");
const loop = ref(-1);
const target = ref("");
let loading = false;
async function open(id: string) {
  if (loading) return;
  const i = frames.value.findIndex((f) => f.e.fragment.id === id);
  if (i >= 0) {
    loop.value = i;
    return;
  }
  loading = true;
  error.value = "";
  try {
    const e = await api<Evidence>("/evidence/" + id);
    if (current.value)
      current.value.scroll =
        document.querySelector(".om-dialog .dialog-scroll")?.scrollTop || 0;
    frames.value.push({ e, tab: "excerpt", ask: false, scroll: 0 });
    loop.value = -1;
    await nextTick();
    const el = document.querySelector(".om-dialog .dialog-scroll");
    if (el) el.scrollTop = 0;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading = false;
  }
}
async function back() {
  frames.value.pop();
  loop.value = -1;
  await nextTick();
  const el = document.querySelector(".om-dialog .dialog-scroll");
  if (el) el.scrollTop = current.value?.scroll || 0;
}
async function link() {
  if (!current.value || !target.value.trim()) return;
  try {
    await api("/relations", {
      from: current.value.e.fragment.id,
      to: target.value.trim(),
    });
    current.value.e = await api<Evidence>(
      "/evidence/" + current.value.e.fragment.id,
    );
    target.value = "";
    emit("saved");
  } catch (e) {
    error.value = String(e);
  }
}
defineExpose({ open });
</script>
<template>
  <OmDialog
    :open="!!current"
    :title="current?.e.revision.title || '证据'"
    :depth="frames.length"
    :side-open="current?.ask"
    @close="frames = []"
    @back="back"
    ><template v-if="current"
      ><nav class="path" aria-label="证据路径">
        <OmButton
          v-for="(f, i) in frames"
          :key="f.e.fragment.id"
          variant="ghost"
          @click="
            frames = frames.slice(0, i + 1);
            loop = -1;
          "
          >{{ i + 1 }} {{ f.e.revision.title }}</OmButton
        >
      </nav>
      <p v-if="loop >= 0" class="notice">
        已在第 {{ loop + 1 }} 层查看此材料。<OmButton
          @click="
            frames = frames.slice(0, loop + 1);
            loop = -1;
          "
          >回到该层</OmButton
        >
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="row">
        <OmBadge>{{ current.e.revision.source }}</OmBadge
        ><OmBadge :tone="current.e.revision.current ? 'neutral' : 'warning'"
          >v{{ current.e.revision.version }} ·
          {{ current.e.revision.current ? "现行版本" : "历史版本" }}</OmBadge
        >
      </div>
      <div class="tabs">
        <OmButton
          v-for="[key, label] in [
            ['excerpt', '引用片段'],
            ['context', '完整材料'],
            ['backlinks', '反向引用'],
          ]"
          :key="key"
          :variant="current.tab === key ? 'primary' : 'ghost'"
          @click="current.tab = key"
          >{{ label }}</OmButton
        >
      </div>
      <template v-if="current.tab === 'excerpt'"
        ><blockquote>{{ current.e.fragment.text }}</blockquote>
        <h3>这段内容引用了</h3>
        <p v-if="!current.e.outgoing.length" class="muted">
          暂未记录下级引用。
        </p>
        <div v-for="edge in current.e.outgoing" :key="edge.id" class="edge">
          <OmCitation
            :label="edge.title"
            :version="edge.version"
            @open="open(edge.targetId)"
          /><small>明确引用 · 不自动判定支持度</small>
        </div></template
      ><template v-else-if="current.tab === 'context'"
        ><p
          v-for="f in current.e.revision.fragments"
          :key="f.id"
          class="pre-wrap"
        >
          {{ f.text }}
        </p>
        <template v-for="(p, i) in current.e.revision.parts" :key="i"
          ><AssetImage
            v-if="p.type === 'image'"
            :id="p.assetId"
            :label="p.label" /></template></template
      ><template v-else
        ><p v-if="!current.e.backlinks.length">没有直接反向引用。</p>
        <div v-for="edge in current.e.backlinks" :key="edge.id" class="edge">
          <OmCitation :label="edge.title" @open="open(edge.targetId)" /></div
      ></template>
      <OmDisclosure class="add-ref" title="引用此片段 / 关联另一个片段">
        <label
          >当前片段 ID<input
            readonly
            :value="current.e.fragment.id"
            aria-label="当前片段 ID" /></label
        ><label
          >要引用的片段 ID<input
            v-model="target"
            placeholder="从另一个片段复制 ID" /></label
        ><OmButton @click="link">添加引用</OmButton>
      </OmDisclosure></template
    ><template #aside
      ><ChatPane
        v-for="f in frames.filter((frame) => frame.ask)"
        v-show="f === current && f.ask"
        :key="f.e.fragment.id"
        :focus="f.e.fragment"
        :profile-id="profileId"
        :model="model"
        :effort="effort"
        :path-ids="frames.map((x) => x.e.fragment.id)"
        @open="open"
        @saved="emit('saved')" /></template
    ><template #actions
      ><OmButton @click="back"
        ><OmIcon name="back" />{{
          frames.length > 1 ? "返回上一层" : "返回阅读"
        }}</OmButton
      ><OmButton
        variant="primary"
        @click="current && (current.ask = !current.ask)"
        >{{ current?.ask ? "收起追问" : "就这段追问" }}</OmButton
      ></template
    ></OmDialog
  >
  <p v-if="error && !current" class="error" role="alert">{{ error }}</p>
</template>
<style scoped>
.path {
  display: flex;
  overflow: auto;
  gap: 4px;
  white-space: nowrap;
  border-bottom: 1px solid var(--om-line);
  margin-bottom: 20px;
}
.row,
.tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 16px 0;
}
blockquote {
  background: var(--om-soft);
  padding: 24px;
  margin: 24px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 17px/2 var(--om-serif);
  border-radius: 6px;
}
.edge {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px 0;
  border-bottom: 1px solid var(--om-line);
}
.pre-wrap {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.add-ref {
  margin: 28px 0;
}
.add-ref label {
  margin-bottom: 12px;
}
.notice {
  background: #f6f2e8;
  padding: 12px;
}
.error {
  color: var(--om-danger);
}
.muted {
  color: var(--om-muted);
}
</style>
