<script setup lang="ts">
/** A review fragment (decision / research / requirement) shown in the trail.
 * Renders the fragment text as sanitized Markdown, then lists its relations.
 * `implemented_by` / `required_by` / `tested_for` edges are the REVERSE path
 * from a rule/decision back to code: clicking one drills into that file. */
import { ref, watch, onMounted } from "vue";
import { OmPanel, OmBadge, OmButton, OmEmpty, OmMarkdown, OmStatusLine } from "@omem/ui";
import {
  reviewFragment,
  reviewFragmentRelations,
  type ReviewFragmentDetail,
  type ReviewRelation,
  type CodeFile,
} from "../review-api";
import { fileByPath } from "./modules";

const props = defineProps<{ fragmentId: string; fileMap?: Map<string, CodeFile> }>();
const emit = defineEmits<{
  drill: [
    target:
      | { type: "file"; fileId: string; line?: number }
      | { type: "fragment"; fragmentId: string; title?: string },
  ];
}>();

const detail = ref<ReviewFragmentDetail | null>(null);
const relations = ref<ReviewRelation[]>([]);
const loading = ref(true);
const loadError = ref("");

const REVERSE = new Set(["implemented_by", "required_by", "tested_for"]);
const POSITIVE = new Set(["implements", "decided_by", "researched_by", "tested_by", "requires"]);

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const [d, r] = await Promise.all([
      reviewFragment(props.fragmentId),
      reviewFragmentRelations(props.fragmentId).catch(() => ({ fragmentId: props.fragmentId, relations: [] as ReviewRelation[] })),
    ]);
    detail.value = d;
    relations.value = r.relations;
  } catch (e) {
    loadError.value = String(e);
  } finally {
    loading.value = false;
  }
}
watch(() => props.fragmentId, () => void load());
onMounted(() => void load());

function reverseRelations() {
  return relations.value.filter((r) => REVERSE.has(r.relationType));
}
function forwardRelations() {
  return relations.value.filter((r) => POSITIVE.has(r.relationType));
}
function otherRelations() {
  return relations.value.filter((r) => !REVERSE.has(r.relationType) && !POSITIVE.has(r.relationType));
}

function tone(r: ReviewRelation) {
  if (r.relationStatus === "confirmed") return "success" as const;
  if (r.relationStatus === "candidate") return "warning" as const;
  return "neutral" as const;
}

/** Human label for a relation type; never shows the raw enum. */
const REL_WORD: Record<string, string> = {
  implements: "实现", implemented_by: "被实现", requires: "依赖", required_by: "被依赖",
  decided_by: "决策依据", decides: "决策", researched_by: "调研依据", researches: "调研",
  tested_by: "测试覆盖", tested_for: "覆盖测试", candidate_for: "候选",
};
function relWord(t: string) {
  return REL_WORD[t] || "关联";
}

function openRelation(r: ReviewRelation) {
  // If the other side is a code file (implemented_by points at a runtime/test
  // file), drill into the code file frame — not just another doc fragment.
  if (r.other?.filePath && props.fileMap) {
    const cf = fileByPath(props.fileMap, r.other.filePath);
    if (cf) {
      emit("drill", { type: "file", fileId: cf.fileId });
      return;
    }
  }
  if (r.other?.fragmentId) emit("drill", { type: "fragment", fragmentId: r.other.fragmentId });
}
</script>

<template>
  <div class="fragment-frame">
    <div v-if="loadError" class="error-banner" role="alert">
      片段加载失败：{{ loadError }}
      <OmButton variant="ghost" @click="load">重试</OmButton>
    </div>
    <div v-if="loading" class="muted">正在加载片段…</div>
    <template v-else-if="detail">
      <small class="muted">{{ detail.revision.title }}</small>
      <OmStatusLine kind="raw" sourceNote="仓库文档原文 · 不可变" />
      <OmMarkdown :source="detail.text" />

      <h4>这条决策影响了哪些代码 <small>{{ reverseRelations().length }}</small></h4>
      <p class="muted small">反向追踪：哪些实现/测试由这条规则驱动。</p>
      <OmEmpty v-if="!reverseRelations().length" title="尚未登记到任何代码"
        description="可在 docs/repo-review/associations.json 补充实现边。" />
      <OmPanel
        v-for="r in reverseRelations()"
        :key="r.id"
        class="stack relation"
        @click="openRelation(r)"
      >
        <div class="row" style="margin-top:0">
          <OmBadge :tone="tone(r)">{{ relWord(r.relationType) }}</OmBadge>
          <small v-if="r.other?.filePath" class="path">{{ r.other.filePath }}</small>
        </div>
        <p v-if="r.other?.text" class="excerpt">{{ r.other.text.slice(0, 200) }}</p>
        <small v-if="r.evidence" class="muted">{{ r.evidence }}</small>
      </OmPanel>

      <h4>继续指向 <small>{{ forwardRelations().length }}</small></h4>
      <OmPanel
        v-for="r in forwardRelations()"
        :key="r.id"
        class="stack relation"
        @click="openRelation(r)"
      >
        <div class="row" style="margin-top:0">
          <OmBadge :tone="tone(r)">{{ relWord(r.relationType) }}</OmBadge>
        </div>
        <p v-if="r.other?.text" class="excerpt">{{ r.other.text.slice(0, 160) }}</p>
        <small v-if="r.evidence" class="muted">{{ r.evidence }}</small>
      </OmPanel>
    </template>
  </div>
</template>

<style scoped>
.fragment-frame { display:flex; flex-direction:column; gap:8px; }
.muted { color: var(--om-secondary); }
.small { font-size:12px; }
.path { font-family: ui-monospace, Consolas, monospace; font-size:11px; }
.stack { margin-bottom:8px; cursor:pointer; }
.excerpt { margin:6px 0; font-size:13px; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.error-banner { border:1px solid #eccaca; background:#fff0f0; color:var(--om-danger); padding:10px 12px; border-radius:6px; display:flex; gap:10px; align-items:center; }
h4 { margin:14px 0 4px; }
</style>
