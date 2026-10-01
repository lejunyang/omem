<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { OmButton, OmDialog, OmIcon } from "@omem/ui";
import { knowledgeApi } from "./api";
export type MaterialOption = {
  key: string;
  title: string;
  path: string | null;
  revisionId: string;
};
const props = defineProps<{
  open: boolean;
  prefix: string;
  materials: MaterialOption[];
  topicPath: string[];
  running: boolean;
}>();
const emit = defineEmits<{ submitted: []; close: [] }>();
const title = ref(""),
  goal = ref(""),
  reader = ref("希望了解这个主题的人"),
  filter = ref(""),
  selected = ref<string[]>([]),
  error = ref(""),
  sending = ref(false);
const materialSearch = ref<HTMLInputElement>(),
  titleInput = ref<HTMLInputElement>();
const step = ref(1),
  limit = ref(40),
  onlySelected = ref(false);
watch(
  () => step.value,
  async () => {
    await nextTick();
    const input = step.value === 1 ? materialSearch.value : titleInput.value;
    input?.closest(".dialog-scroll")?.scrollTo({ top: 0 });
    input?.focus({ preventScroll: true });
  },
);
const candidates = computed(() =>
  props.materials.filter(
    (m) =>
      (!onlySelected.value || selected.value.includes(m.revisionId)) &&
      (m.title + " " + (m.path ?? ""))
        .toLowerCase()
        .includes(filter.value.trim().toLowerCase()),
  ),
);
watch([filter, onlySelected], () => {
  limit.value = 40;
});
watch(
  () => props.open,
  (open) => {
    if (open) step.value = 1;
  },
);
async function submit() {
  sending.value = true;
  error.value = "";
  try {
    await knowledgeApi(props.prefix, "/pages", {
      method: "POST",
      body: JSON.stringify({
        revisionIds: selected.value,
        brief: {
          key: "article:" + crypto.randomUUID(),
          title: title.value.trim(),
          order: 0,
          kind: "explanation",
          reader: reader.value.trim(),
          goal: goal.value.trim(),
          scenario: goal.value.trim(),
          questions: [goal.value.trim()],
          entryPaths: [],
          ...(props.topicPath.length ? { topicPath: props.topicPath } : {}),
        },
      }),
    });
    selected.value = [];
    title.value = "";
    goal.value = "";
    filter.value = "";
    onlySelected.value = false;
    emit("submitted");
    emit("close");
  } catch (e) {
    error.value = String(e);
  } finally {
    sending.value = false;
  }
}
</script>
<template>
  <OmDialog
    :open="open"
    title="整理成文章"
    @close="emit('close')"
    @back="emit('close')"
  >
    <div class="composer">
      <ol class="steps" aria-label="整理步骤">
        <li
          :class="{ active: step === 1 }"
          :aria-current="step === 1 ? 'step' : undefined"
        >
          <span>1</span>选择材料
        </li>
        <li
          :class="{ active: step === 2 }"
          :aria-current="step === 2 ? 'step' : undefined"
        >
          <span>2</span>说明阅读目标
        </li>
      </ol>
      <section v-if="step === 1" class="material-step">
        <div class="step-heading">
          <h3>这篇文章基于哪些材料？</h3>
          <p>选择相关文档、代码或记录，AI 会结合它们调查并撰写。</p>
        </div>
        <div class="material-toolbar">
          <label class="filter-field"
            ><span>查找材料</span
            ><input
              ref="materialSearch"
              v-model="filter"
              aria-label="筛选整理材料"
              placeholder="输入标题或路径" /></label
          ><button
            class="selection-filter"
            :class="{ selected: onlySelected }"
            :aria-pressed="onlySelected"
            @click="onlySelected = !onlySelected"
          >
            已选 {{ selected.length }} 项
          </button>
        </div>
        <div class="material-options" aria-label="可选材料">
          <label
            v-for="m in candidates.slice(0, limit)"
            :key="m.revisionId"
            class="material-option"
            :class="{ checked: selected.includes(m.revisionId) }"
            ><input
              v-model="selected"
              type="checkbox"
              :value="m.revisionId" /><span
              ><strong>{{ m.title }}</strong
              ><small v-if="m.path && m.path !== m.title">{{
                m.path
              }}</small></span
            ><OmIcon v-if="selected.includes(m.revisionId)" name="check"
          /></label>
          <p v-if="!candidates.length" class="empty-materials">
            {{
              onlySelected
                ? "还没有选中匹配的材料"
                : "没有匹配的材料，试试其他名称"
            }}
          </p>
          <OmButton
            v-if="candidates.length > limit"
            variant="ghost"
            @click="limit += 40"
            >继续显示（还有 {{ candidates.length - limit }} 项）</OmButton
          >
        </div>
        <p class="material-count">
          {{ candidates.length }} 项{{ onlySelected ? "已选材料" : "可选材料" }}
          · 可跨分类选择
        </p>
      </section>
      <form
        v-else
        id="article-composer-form"
        class="purpose-step"
        @submit.prevent="submit"
      >
        <div class="step-heading">
          <h3>希望读完后弄懂什么？</h3>
          <p>具体的问题和使用场景，可以帮助文章讲得更清楚。</p>
        </div>
        <label
          >文章主题<input
            ref="titleInput"
            v-model="title"
            required
            maxlength="240"
            placeholder="例如：听不懂英语连读时如何练习"
        /></label>
        <label
          >想弄懂什么<textarea
            v-model="goal"
            required
            maxlength="1600"
            rows="4"
            placeholder="希望解决的问题，以及准备怎样使用这些知识"
          />
        </label>
        <label
          >写给谁看<input v-model="reader" required maxlength="240"
        /></label>
        <div class="scope-note">
          <OmIcon name="book" />
          <p>
            基于 <strong>{{ selected.length }} 项材料</strong>整理{{
              topicPath.length
                ? "，保存到「" + topicPath.join(" / ") + "」"
                : "，按内容归类"
            }}。<br /><span>AI 会调查、撰写并复核，完成后可在知识库阅读。</span>
          </p>
        </div>
        <p v-if="error" class="submit-error" role="alert">{{ error }}</p>
      </form>
    </div>
    <template #actions>
      <div class="composer-actions">
        <span>{{
          step === 1
            ? "已选 " + selected.length + " 项材料"
            : "第 2 步，共 2 步"
        }}</span>
        <div>
          <OmButton v-if="step === 1" variant="ghost" @click="emit('close')"
            >取消</OmButton
          ><OmButton
            v-else
            variant="secondary"
            :disabled="sending"
            @click="step = 1"
            >上一步</OmButton
          ><OmButton
            v-if="step === 1"
            variant="primary"
            :disabled="!selected.length || running"
            @click="step = 2"
            >下一步<OmIcon name="arrow" /></OmButton
          ><OmButton
            v-else
            variant="primary"
            type="submit"
            form="article-composer-form"
            :disabled="running || !selected.length"
            :loading="sending"
            >开始整理</OmButton
          >
        </div>
      </div>
    </template>
  </OmDialog>
</template>
<style scoped>
.composer {
  max-width: 780px;
  margin: 0 auto;
}
.steps {
  display: flex;
  gap: 28px;
  list-style: none;
  padding: 0 0 22px;
  margin: 0 0 24px;
  border-bottom: 1px solid var(--om-line);
  color: var(--om-muted);
  font-size: 13px;
}
.steps li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.steps li.active {
  color: var(--om-ink);
  font-weight: 600;
}
.steps li > span {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--om-line);
  border-radius: 50%;
  font-size: 12px;
}
.steps li.active > span {
  background: var(--om-ink);
  border-color: var(--om-ink);
  color: white;
}
.step-heading {
  margin-bottom: 24px;
}
.step-heading h3 {
  font-size: 20px;
  line-height: 1.5;
  margin: 0 0 8px;
}
.step-heading p {
  color: var(--om-muted);
  margin: 0;
  font-size: 13px;
}
.material-toolbar {
  display: flex;
  align-items: end;
  gap: 12px;
  margin-bottom: 16px;
}
.filter-field {
  flex: 1;
  min-width: 0;
}
.filter-field span {
  font-size: 12px;
  color: var(--om-secondary);
}
.filter-field input {
  width: 100%;
  min-height: 44px;
}
.selection-filter {
  flex-shrink: 0;
  min-height: 44px;
  border: 1px solid var(--om-line);
  background: white;
  padding: 8px 14px;
  border-radius: 6px;
  color: var(--om-secondary);
}
.selection-filter.selected {
  background: var(--om-soft);
  border-color: var(--om-muted);
  color: var(--om-ink);
}
.material-options {
  border: 1px solid var(--om-line);
  border-radius: 8px;
  max-height: 320px;
  overflow: auto;
  overscroll-behavior: contain;
}
.material-option {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  min-height: 60px;
  padding: 12px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--om-line);
}
.material-option:last-child {
  border-bottom: 0;
}
.material-option:hover {
  background: var(--om-paper);
}
.material-option.checked {
  background: var(--om-soft);
}
.material-option input {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  margin: 0;
  accent-color: var(--om-ink);
}
.material-option > span {
  flex: 1;
  min-width: 0;
}
.material-option strong {
  display: block;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.material-option small {
  display: block;
  font-size: 12px;
  margin-top: 3px;
  overflow-wrap: anywhere;
}
.material-option svg {
  flex-shrink: 0;
  color: var(--om-secondary);
}
.material-count {
  font-size: 12px;
  color: var(--om-muted);
  margin: 12px 0 0;
}
.empty-materials {
  padding: 24px;
  text-align: center;
  color: var(--om-muted);
}
.purpose-step {
  display: grid;
  gap: 20px;
}
.purpose-step .step-heading {
  margin-bottom: 0;
}
.purpose-step input,
.purpose-step textarea {
  width: 100%;
  min-height: 44px;
}
.scope-note {
  display: flex;
  align-items: start;
  gap: 12px;
  background: var(--om-paper);
  border-radius: 8px;
  padding: 16px;
}
.scope-note svg {
  flex-shrink: 0;
  margin-top: 4px;
}
.scope-note p {
  margin: 0;
  font-size: 13px;
}
.scope-note span {
  color: var(--om-muted);
}
.submit-error {
  color: var(--om-danger);
  margin: 0;
}
.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
}
.composer-actions > span {
  color: var(--om-muted);
  font-size: 12px;
}
.composer-actions > div {
  display: flex;
  gap: 12px;
}
@media (max-width: 700px) {
  .steps {
    gap: 20px;
    margin-bottom: 20px;
  }
  .step-heading h3 {
    font-size: 18px;
  }
  .material-option {
    padding: 12px;
  }
  .material-options {
    max-height: 42dvh;
  }
  .composer-actions {
    gap: 8px;
  }
  .composer-actions > div {
    gap: 8px;
  }
}
</style>
