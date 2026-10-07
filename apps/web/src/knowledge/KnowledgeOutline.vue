<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  OmBadge,
  OmButton,
  OmCheckbox,
  OmDialog,
  OmDisclosure,
  OmEmpty,
  OmSelect,
} from "@omem/ui";
import ContextPicker from "../ContextPicker.vue";
import type { MaterialContext } from "../../../../packages/contracts/src/contexts";
import type {
  KnowledgeOutlineDraft,
  KnowledgeOutlinePage,
  KnowledgeOutlineView,
} from "../../../../packages/contracts/src/knowledge-outline";
import type { MaterialOption } from "./ArticleComposer.vue";
import { knowledgeApi, type PlannedPage } from "./api";
import {
  mergeOutlinePages,
  moveOutlineRoot,
  outlineLines,
  outlinePath,
} from "./outline-editing";

const props = defineProps<{
  open: boolean;
  prefix: string;
  materials: MaterialOption[];
  contexts: MaterialContext[];
  plans: PlannedPage[];
  topicPath: string[];
  draftId?: string;
}>();
const emit = defineEmits<{
  close: [];
  updated: [];
  applied: [];
  read: [key: string];
}>();
const current = ref<KnowledgeOutlineDraft>(),
  saved = ref(""),
  drafts = ref<KnowledgeOutlineDraft[]>([]);
const mode = ref<"list" | "edit">("list"),
  step = ref(1),
  selectedPageKey = ref("");
const available = ref(true);
const pageStatuses = ref<KnowledgeOutlineView["pageStatuses"]>([]);
const busy = ref(false),
  loading = ref(false),
  error = ref(""),
  notice = ref("");
const conflicting = ref(false);
const closeRequested = ref(false),
  filter = ref(""),
  materialLimit = ref(40),
  onlySelected = ref(false);
const addExisting = ref(""),
  mergeTarget = ref(""),
  showDirectory = ref(true);
let timer: ReturnType<typeof setInterval> | undefined;
const editable = (draft: KnowledgeOutlineDraft) => ({
  title: draft.title,
  goal: draft.goal,
  reader: draft.reader,
  topicPath: draft.topicPath,
  materialKeys: draft.materialKeys,
  contextIds: draft.contextIds,
  pages: draft.pages,
});
const dirty = computed(
  () =>
    !!current.value && JSON.stringify(editable(current.value)) !== saved.value,
);
const planning = computed(() => current.value?.state === "planning");
const confirmed = computed(() => current.value?.state === "applied");
const locked = computed(() => planning.value || confirmed.value);
const selectedPage = computed(() =>
  current.value?.pages.find((page) => page.id === selectedPageKey.value),
);
const scopeMaterials = computed(() =>
  props.materials.filter(
    (material) =>
      current.value?.materialKeys.includes(material.key) ||
      material.contextIds?.some((id) => current.value?.contextIds.includes(id)),
  ),
);
const materialCandidates = computed(() =>
  props.materials.filter(
    (material) =>
      (!onlySelected.value || inScope(material)) &&
      (material.title + " " + (material.path ?? ""))
        .toLowerCase()
        .includes(filter.value.trim().toLowerCase()),
  ),
);
const selectedContexts = computed(() =>
  props.contexts.filter((context) =>
    current.value?.contextIds.includes(context.id),
  ),
);
const existingPlans = computed(() =>
  props.plans.filter(
    (page) =>
      page.plan &&
      ["article", "reference"].includes(page.role) &&
      page.plan.workflow !== "requirement-followup" &&
      !current.value?.pages.some(
        (draftPage) => draftPage.existingKey === page.key,
      ),
  ),
);
const canPlan = computed(
  () =>
    !!current.value?.title.trim() &&
    !!current.value?.goal.trim() &&
    !!current.value?.reader.trim() &&
    scopeMaterials.value.length > 0,
);
const pageProblems = computed(() =>
  (current.value?.pages ?? []).flatMap((page, index) => {
    const missing = [
      !page.title.trim() && "标题",
      !page.goal.trim() && "阅读目标",
      !page.reader.trim() && "读者",
      !page.questions.some((question) => question.trim()) && "要回答的问题",
      !page.materialKeys?.length && !page.contextIds?.length && "材料范围",
    ].filter(Boolean);
    if (page.questions.length > 12)
      missing.push("问题过多，请精简到 12 个以内");
    return missing.length
      ? [
          `第 ${index + 1} 页${page.title ? "「" + page.title + "」" : ""}：请补充${missing.join("、")}`,
        ]
      : [];
  }),
);
const canApply = computed(
  () =>
    available.value &&
    canPlan.value &&
    !!current.value?.pages.length &&
    !pageProblems.value.length &&
    !locked.value,
);
const stateLabel = (state: KnowledgeOutlineDraft["state"]) =>
  ({
    editing: "未确认",
    planning: "正在调查目录",
    ready: "待确认目录",
    failed: "目录调查未完成",
    applied: "目录已确认",
  })[state];
const time = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "";
function inContext(material: MaterialOption) {
  return (
    material.contextIds?.some((id) => current.value?.contextIds.includes(id)) ??
    false
  );
}
function inScope(material: MaterialOption) {
  return (
    current.value?.materialKeys.includes(material.key) || inContext(material)
  );
}
function chooseMaterial(material: MaterialOption, checked: boolean) {
  if (!current.value) return;
  current.value.materialKeys = checked
    ? [...new Set([...current.value.materialKeys, material.key])]
    : current.value.materialKeys.filter((key) => key !== material.key);
}
function chooseContexts(ids: string[]) {
  if (!current.value) return;
  current.value.contextIds = ids;
  current.value.materialKeys = current.value.materialKeys.filter(
    (key) =>
      !props.materials.some(
        (material) => material.key === key && inContext(material),
      ),
  );
}
function changeRootPath(value: string) {
  if (!current.value || locked.value) return;
  const next = outlinePath(value);
  current.value.pages = moveOutlineRoot(
    current.value.pages,
    current.value.topicPath,
    next,
  );
  current.value.topicPath = next;
  notice.value =
    "整体目录位置已调整，原有子目录保留；单独放在其他分类的页面保持原位置。";
}
function failure(caught: unknown) {
  const message = String(caught).replace(/^Error:\s*/, "");
  conflicting.value =
    message.includes("其他窗口更新") || message.includes("CONFLICT");
  error.value = conflicting.value
    ? "这份草案已在别处更新。当前修改仍保留；可以复制本地内容，或放弃本地修改并重新载入服务器版本。"
    : message;
}
async function reloadServerDraft() {
  if (!current.value?.id) return;
  busy.value = true;
  try {
    accept(
      await knowledgeApi<KnowledgeOutlineView>(
        props.prefix,
        "/outlines/" + encodeURIComponent(current.value.id),
      ),
    );
    conflicting.value = false;
    error.value = "";
    closeRequested.value = false;
    notice.value = "已载入服务器上的草案。";
  } catch (caught) {
    failure(caught);
  } finally {
    busy.value = false;
  }
}
function accept(draft: KnowledgeOutlineDraft | KnowledgeOutlineView) {
  if ("pageStatuses" in draft) pageStatuses.value = draft.pageStatuses;
  else if (draft.state !== "applied") pageStatuses.value = [];
  current.value = structuredClone(draft);
  saved.value = JSON.stringify(editable(draft));
  selectedPageKey.value = draft.pages.some(
    (page) => page.id === selectedPageKey.value,
  )
    ? selectedPageKey.value
    : (draft.pages[0]?.id ?? "");
}
async function loadDrafts() {
  const result = await knowledgeApi<{
    drafts: KnowledgeOutlineDraft[];
    available: boolean;
  }>(props.prefix, "/outlines");
  drafts.value = result.drafts;
  available.value = result.available;
}
async function openDraft(id: string) {
  if (dirty.value) {
    error.value = "当前目录有未保存修改。请先保存草案，再打开其他目录。";
    return;
  }
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    accept(
      await knowledgeApi<KnowledgeOutlineView>(
        props.prefix,
        "/outlines/" + encodeURIComponent(id),
      ),
    );
    mode.value = "edit";
    step.value = current.value!.pages.length || planning.value ? 3 : 1;
  } catch (caught) {
    failure(caught);
  } finally {
    busy.value = false;
  }
}
function newDraft() {
  if (dirty.value) {
    error.value = "请先保存当前草案，再新建其他目录。";
    return;
  }
  current.value = {
    id: "",
    version: 0,
    title: "",
    goal: "",
    reader: "第一次了解这个主题的人",
    topicPath: [...props.topicPath],
    materialKeys: [],
    contextIds: [],
    pages: [],
    state: "editing",
    rationale: "",
    gaps: [],
    error: null,
    jobId: null,
    appliedPages: [],
    createdAt: "",
    updatedAt: "",
  };
  saved.value = JSON.stringify(editable(current.value));
  mode.value = "edit";
  step.value = 1;
  selectedPageKey.value = "";
  error.value = "";
  conflicting.value = false;
  notice.value = "";
  filter.value = "";
  onlySelected.value = false;
}
async function saveDraft() {
  if (!current.value) return false;
  busy.value = true;
  error.value = "";
  try {
    const draft = current.value;
    const result = await knowledgeApi<KnowledgeOutlineDraft>(
      props.prefix,
      draft.id ? "/outlines/" + encodeURIComponent(draft.id) : "/outlines",
      {
        method: draft.id ? "PUT" : "POST",
        body: JSON.stringify(
          draft.id
            ? { version: draft.version, draft: editable(draft) }
            : editable(draft),
        ),
      },
    );
    accept(result);
    await loadDrafts();
    emit("updated");
    notice.value = "草案已保存。确认目录后才会开始写作。";
    return true;
  } catch (caught) {
    failure(caught);
    return false;
  } finally {
    busy.value = false;
  }
}
async function propose() {
  if (!canPlan.value || locked.value || !available.value) return;
  if (!(await saveDraft()) || !current.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    accept(
      await knowledgeApi<KnowledgeOutlineDraft>(
        props.prefix,
        "/outlines/" + encodeURIComponent(current.value.id) + "/propose",
        {
          method: "POST",
          body: JSON.stringify({ version: current.value.version }),
        },
      ),
    );
    step.value = 3;
    emit("updated");
  } catch (caught) {
    failure(caught);
  } finally {
    busy.value = false;
  }
}
function addPage() {
  if (!current.value || locked.value || current.value.pages.length >= 32)
    return;
  const draft = current.value;
  const page: KnowledgeOutlinePage = {
    id: crypto.randomUUID(),
    existingKey: null,
    title: "",
    kind: "explanation",
    reader: draft.reader,
    goal: "",
    scenario: "",
    questions: [""],
    entryPaths: [],
    topicPath: [...draft.topicPath],
    materialKeys: [...draft.materialKeys],
    contextIds: [...draft.contextIds],
  };
  draft.pages.push(page);
  selectedPageKey.value = page.id;
  step.value = 3;
  showDirectory.value = false;
}
function useExisting() {
  const plan = existingPlans.value.find(
    (page) => page.key === addExisting.value,
  )?.plan;
  if (
    !plan ||
    !current.value ||
    locked.value ||
    current.value.pages.length >= 32
  )
    return;
  const page: KnowledgeOutlinePage = {
    id: crypto.randomUUID(),
    existingKey: plan.key,
    title: plan.title,
    kind: plan.kind,
    reader: plan.reader,
    goal: plan.goal,
    scenario: plan.scenario,
    questions: [...plan.questions],
    entryPaths: [...plan.entryPaths],
    topicPath: [...(plan.topicPath ?? [])],
    materialKeys: [...(plan.materialKeys ?? [])],
    contextIds: [...(plan.contextIds ?? [])],
  };
  current.value.pages.push(page);
  current.value.materialKeys = [
    ...new Set([...current.value.materialKeys, ...page.materialKeys]),
  ];
  current.value.contextIds = [
    ...new Set([...current.value.contextIds, ...page.contextIds]),
  ];
  selectedPageKey.value = page.id;
  addExisting.value = "";
  showDirectory.value = false;
  notice.value =
    "已加入现有文章的阅读计划和材料范围。确认后会更新这篇文章，现有正文与历史引用保留。";
}
function selectPage(key: string) {
  selectedPageKey.value = key;
  mergeTarget.value = "";
  showDirectory.value = false;
}
function reorder(offset: number) {
  if (!current.value || !selectedPage.value) return;
  const pages = [...current.value.pages],
    from = pages.findIndex((page) => page.id === selectedPageKey.value),
    to = from + offset;
  if (to < 0 || to >= pages.length) return;
  const [page] = pages.splice(from, 1);
  pages.splice(to, 0, page);
  current.value.pages = pages;
}
function removePage() {
  if (!current.value || !selectedPage.value) return;
  const index = current.value.pages.findIndex(
    (page) => page.id === selectedPageKey.value,
  );
  current.value.pages = current.value.pages.filter(
    (page) => page.id !== selectedPageKey.value,
  );
  selectedPageKey.value =
    current.value.pages[Math.min(index, current.value.pages.length - 1)]?.id ??
    "";
  notice.value = "已从本草案移除页面。已有文章不会被删除。";
}
function mergePage() {
  if (!current.value || !selectedPage.value || !mergeTarget.value) return;
  current.value.pages = mergeOutlinePages(
    current.value.pages,
    selectedPageKey.value,
    mergeTarget.value,
  );
  selectedPageKey.value = mergeTarget.value;
  mergeTarget.value = "";
  notice.value =
    "材料、问题和阅读目标已合并。请检查合并后的标题与讲解范围；已有文章不会被删除。";
}
function choosePageMaterial(key: string, checked: boolean) {
  if (!selectedPage.value) return;
  selectedPage.value.materialKeys = checked
    ? [...new Set([...(selectedPage.value.materialKeys ?? []), key])]
    : (selectedPage.value.materialKeys ?? []).filter((value) => value !== key);
}
function choosePageContext(id: string, checked: boolean) {
  if (!selectedPage.value) return;
  const ids = checked
    ? [...new Set([...(selectedPage.value.contextIds ?? []), id])]
    : (selectedPage.value.contextIds ?? []).filter((value) => value !== id);
  selectedPage.value.contextIds = ids;
}
function applyScope() {
  if (!current.value) return;
  for (const page of current.value.pages) {
    page.materialKeys = [...current.value.materialKeys];
    page.contextIds = [...current.value.contextIds];
  }
  notice.value = "全部页面已使用本次选择的材料范围。仍可逐页缩小范围。";
}
async function apply() {
  if (!canApply.value || !(await saveDraft()) || !current.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await knowledgeApi<KnowledgeOutlineView>(
      props.prefix,
      "/outlines/" + encodeURIComponent(current.value.id) + "/apply",
      {
        method: "POST",
        body: JSON.stringify({ version: current.value.version }),
      },
    );
    accept(result);
    emit("applied");
    emit("updated");
    notice.value =
      "目录已确认，页面已进入调查、写作和独立复核。排队成功不表示正文已经发表；现有正文可继续阅读。";
    await loadDrafts();
  } catch (caught) {
    failure(caught);
  } finally {
    busy.value = false;
  }
}
async function retryPage(key: string) {
  if (!current.value?.id) return;
  busy.value = true;
  error.value = "";
  try {
    await knowledgeApi(
      props.prefix,
      "/pages/" + encodeURIComponent(key) + "/refresh",
      { method: "POST" },
    );
    accept(
      await knowledgeApi<KnowledgeOutlineView>(
        props.prefix,
        "/outlines/" + encodeURIComponent(current.value.id),
      ),
    );
    emit("applied");
    notice.value = "这一页已重新排队，完成写作和复核后才会发表。";
  } catch (caught) {
    failure(caught);
  } finally {
    busy.value = false;
  }
}
function close() {
  if (busy.value) return;
  if (dirty.value) {
    closeRequested.value = true;
    return;
  }
  emit("close");
}
async function saveAndClose() {
  if (await saveDraft()) {
    closeRequested.value = false;
    emit("close");
  }
}
async function poll() {
  if (
    !props.open ||
    !current.value?.id ||
    (!planning.value && !confirmed.value) ||
    dirty.value ||
    busy.value
  )
    return;
  try {
    const result = await knowledgeApi<KnowledgeOutlineView>(
      props.prefix,
      "/outlines/" + encodeURIComponent(current.value.id),
    );
    if (!dirty.value && current.value?.id === result.id) {
      accept(result);
      if (result.state !== "planning") {
        await loadDrafts();
        emit("updated");
      }
    }
  } catch (caught) {
    error.value = String(caught);
  }
}
function copyDraft() {
  if (!current.value) return;
  const original = current.value;
  current.value = {
    ...JSON.parse(JSON.stringify(original)),
    id: "",
    version: 0,
    state: "editing",
    rationale: "",
    gaps: [],
    error: null,
    jobId: null,
    appliedPages: [],
    createdAt: "",
    updatedAt: "",
    pages: original.pages.map((page) => ({
      ...JSON.parse(JSON.stringify(page)),
      id: crypto.randomUUID(),
      existingKey:
        original.appliedPages.find((applied) => applied.id === page.id)?.key ??
        page.existingKey,
    })),
  };
  saved.value = "";
  pageStatuses.value = [];
  step.value = 3;
  selectedPageKey.value = current.value!.pages[0]?.id ?? "";
  notice.value =
    original.state === "applied"
      ? "已复制为新草案，复用已确认的页面。调整后再次确认会更新原文章，保留现有正文和历史。"
      : "已复制为新草案。原草案保留，接下来的调整只影响这份副本。";
}
const pageStateLabel = (state: string) =>
  ({
    idle: "整理未运行",
    queued: "等待整理",
    planned: "等待整理",
    writing: "正在调查与写作",
    running: "正在调查与写作",
    published: "已发表",
    succeeded: "已发表",
    failed: "整理未完成",
    cancelled: "整理已取消",
  })[state] ?? "等待整理";
watch([filter, onlySelected], () => {
  materialLimit.value = 40;
});
watch(
  () => props.open,
  async (open) => {
    clearInterval(timer);
    timer = undefined;
    if (!open) return;
    closeRequested.value = false;
    loading.value = true;
    error.value = "";
    try {
      await loadDrafts();
      if (props.draftId && current.value?.id !== props.draftId)
        await openDraft(props.draftId);
    } catch (caught) {
      error.value = String(caught);
    } finally {
      loading.value = false;
    }
    timer = setInterval(() => void poll(), 3000);
  },
);
watch(step, async () => {
  await nextTick();
  document
    .querySelector(".outline-planner")
    ?.closest(".dialog-scroll")
    ?.scrollTo({ top: 0 });
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <OmDialog :open="open" title="规划知识目录" @close="close" @back="close">
    <section
      class="outline-planner"
      aria-label="知识目录草案"
      :aria-busy="busy || planning"
    >
      <p v-if="!available && !loading" class="notice" role="status">
        尚未配置写作 Agent。仍可手动编排、保存草案；配置 Agent
        后再调查目录和开始写作。
      </p>
      <div v-if="error" class="error" role="alert">
        <p>{{ error }}</p>
        <OmButton v-if="conflicting" :loading="busy" @click="reloadServerDraft"
          >放弃本地修改并加载服务器版本</OmButton
        >
      </div>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <section
        v-if="closeRequested"
        class="close-guard"
        aria-label="保存未完成的修改"
      >
        <h3>还有未保存的目录修改</h3>
        <p>先保存到服务，下次打开或刷新页面后还能接着调整。</p>
        <div class="button-row">
          <OmButton :loading="busy" @click="saveAndClose">保存并关闭</OmButton
          ><OmButton variant="ghost" @click="closeRequested = false"
            >继续编辑</OmButton
          >
        </div>
      </section>
      <template v-if="mode === 'list'">
        <div class="section-heading">
          <h3>先想清楚怎么读，再写文章</h3>
          <p>
            选定材料和阅读目标，AI
            调查后给出目录建议。你可以调整页面用途、顺序、材料和分类，再确认写作。
          </p>
        </div>
        <OmButton variant="primary" @click="newDraft">新建目录草案</OmButton>
        <h3 class="draft-list-heading">已保存的目录</h3>
        <p v-if="loading" role="status">正在读取目录草案…</p>
        <ul
          v-else-if="drafts.length"
          class="saved-drafts"
          aria-label="已保存目录草案"
        >
          <li v-for="draft in drafts" :key="draft.id">
            <button @click="openDraft(draft.id)">
              <strong>{{ draft.title || "尚未命名的目录" }}</strong
              ><span>{{ draft.goal || "阅读目标待补充" }}</span
              ><small
                >{{ stateLabel(draft.state) }} · {{ draft.pages.length }} 页 ·
                {{ time(draft.updatedAt) }}</small
              >
            </button>
          </li>
        </ul>
        <OmEmpty
          v-else
          title="还没有目录草案"
          description="可先让 AI 建议目录，也可以自己添加页面计划。"
        />
      </template>
      <template v-else-if="current">
        <div class="draft-topline">
          <OmButton
            variant="ghost"
            :disabled="busy || planning || dirty"
            @click="mode = 'list'"
            >查看其他草案</OmButton
          ><OmBadge>{{ stateLabel(current.state) }}</OmBadge
          ><span class="save-state">{{
            dirty ? "有未保存修改" : current.id ? "草案已保存" : "尚未保存"
          }}</span>
        </div>
        <ol class="outline-steps" aria-label="目录规划步骤">
          <li
            v-for="(label, index) in ['选择材料', '阅读目标', '编辑目录']"
            :key="label"
            :class="{ active: step === index + 1 }"
            :aria-current="step === index + 1 ? 'step' : undefined"
          >
            <span>{{ index + 1 }}</span
            >{{ label }}
          </li>
        </ol>
        <section v-if="step === 1" class="scope-step" aria-label="目录材料范围">
          <div class="section-heading">
            <h3>这套知识从哪些材料出发？</h3>
            <p>
              可以选择长期项目或主题，也可以固定选择文档、代码与聊天记录。后续每一页还能缩小调查范围。
            </p>
          </div>
          <ContextPicker
            :model-value="current.contextIds"
            @update:model-value="chooseContexts"
            label="持续跟踪项目或主题"
            :disabled="locked"
          />
          <div class="material-toolbar">
            <label
              >查找材料<input
                v-model="filter"
                aria-label="筛选目录材料"
                placeholder="输入标题或路径" /></label
            ><OmButton
              :aria-pressed="onlySelected"
              @click="onlySelected = !onlySelected"
              >已选 {{ scopeMaterials.length }} 项</OmButton
            >
          </div>
          <div class="material-options" aria-label="目录可选材料">
            <OmCheckbox
              v-for="material in materialCandidates.slice(0, materialLimit)"
              :key="material.key"
              class="material-option"
              :checked="!!inScope(material)"
              :disabled="locked || inContext(material)"
              @change="
                chooseMaterial(
                  material,
                  ($event.target as HTMLInputElement).checked,
                )
              "
              ><span
                ><strong>{{ material.title }}</strong
                ><small v-if="inContext(material)">随项目或主题加入</small
                ><small
                  v-else-if="material.path && material.path !== material.title"
                  >{{ material.path }}</small
                ></span
              ></OmCheckbox
            >
            <p v-if="!materialCandidates.length">
              没有匹配的材料，试试其他名称。
            </p>
          </div>
          <OmButton
            v-if="materialCandidates.length > materialLimit"
            variant="ghost"
            @click="materialLimit += 40"
            >继续显示（还有
            {{ materialCandidates.length - materialLimit }} 项）</OmButton
          >
          <p class="hint">
            已选 {{ scopeMaterials.length }} 份现有材料<span
              v-if="current.contextIds.length"
              >；所选项目或主题以后新增的材料也可用于页面更新</span
            >。
          </p>
        </section>
        <section
          v-else-if="step === 2"
          class="purpose-step"
          aria-label="目录阅读目标"
        >
          <div class="section-heading">
            <h3>希望这套知识帮你解决什么？</h3>
            <p>
              目录按读者问题组织。可以说明是想上手、理解原理、排查故障，还是学习和练习。
            </p>
          </div>
          <label
            >目录名称<input
              v-model="current.title"
              maxlength="240"
              aria-label="目录名称"
              placeholder="这套知识的主题"
              :disabled="locked"
          /></label>
          <label
            >整体阅读目标<textarea
              v-model="current.goal"
              rows="4"
              maxlength="3000"
              aria-label="整体阅读目标"
              placeholder="读者目前遇到什么问题，读完之后应当能够做什么？"
              :disabled="locked"
            />
          </label>
          <label
            >写给谁看<input
              v-model="current.reader"
              maxlength="1000"
              aria-label="目录读者"
              :disabled="locked"
          /></label>
          <label
            >放入哪个知识目录<input
              :value="current.topicPath.join(' / ')"
              @change="
                changeRootPath(($event.target as HTMLInputElement).value)
              "
              aria-label="目录分类路径"
              placeholder="例如：工作 / 系统学习；留空由页面分别设置"
              :disabled="locked"
            /><small
              >用 / 分隔层级。它是知识分类，不是原始材料的文件目录。</small
            ></label
          >
          <p class="hint">
            AI
            先搜索和补读材料，只生成可编辑的目录与页面计划。确认后才开始文章写作。
          </p>
        </section>
        <section v-else class="outline-step" aria-label="编辑目录草案">
          <div class="section-heading">
            <h3>{{ current.title || "还未命名的目录" }}</h3>
            <p>{{ current.goal || "先补充整体阅读目标，再安排页面。" }}</p>
          </div>
          <p v-if="planning" class="notice" role="status">
            AI
            正在调查所选材料并建议阅读顺序。可以关闭窗口，回来后继续查看；此时不会撰写文章。
            <OmButton :loading="busy" @click="saveDraft"
              >停止调查并编辑草案</OmButton
            >
          </p>
          <p v-if="current.error" class="error" role="alert">
            目录调查未完成：{{
              current.error
            }}。已保存的页面计划仍在，可修改后重试。
          </p>
          <OmDisclosure
            v-if="current.rationale || current.gaps.length"
            title="目录这样安排的原因"
            ><p v-if="current.rationale">{{ current.rationale }}</p>
            <template v-if="current.gaps.length"
              ><h4>还缺哪些背景</h4>
              <ul class="planning-gaps">
                <li v-for="gap in current.gaps" :key="gap">{{ gap }}</li>
              </ul></template
            ></OmDisclosure
          >
          <section
            v-if="confirmed"
            class="applied-status"
            aria-label="目录写作进度"
          >
            <h4>每页写作进度</h4>
            <p>目录已保存。调查、写作和独立复核完成后才发表正文。</p>
            <ul>
              <li v-for="page in pageStatuses" :key="page.id">
                <div>
                  <strong>{{ page.title }}</strong
                  ><span>{{ pageStateLabel(page.state) }}</span
                  ><small v-if="page.error" class="error">{{
                    page.error
                  }}</small>
                </div>
                <OmButton
                  v-if="
                    page.state === 'published' || page.state === 'succeeded'
                  "
                  @click="
                    emit('read', page.key);
                    emit('close');
                  "
                  >阅读文章</OmButton
                >
                <OmButton
                  v-else-if="
                    page.state === 'failed' ||
                    page.state === 'cancelled' ||
                    page.state === 'idle'
                  "
                  :loading="busy"
                  @click="retryPage(page.key)"
                  >{{
                    page.state === "idle" ? "开始整理" : "重试整理"
                  }}</OmButton
                >
              </li>
            </ul>
          </section>
          <div class="outline-toolbar">
            <OmButton
              :disabled="locked || busy || current.pages.length >= 32"
              @click="addPage"
              >添加页面</OmButton
            ><OmButton
              :disabled="locked || busy || !canPlan || !available"
              @click="propose"
              >{{
                current.pages.length ? "重新调查目录建议" : "让 AI 建议目录"
              }}</OmButton
            ><OmButton
              v-if="current.id && !locked"
              :disabled="busy"
              @click="copyDraft"
              >另存为新草案</OmButton
            ><OmButton
              class="directory-toggle"
              variant="ghost"
              :aria-expanded="showDirectory"
              @click="showDirectory = !showDirectory"
              >{{ showDirectory ? "收起页面目录" : "展开页面目录" }}</OmButton
            >
          </div>
          <p v-if="current.pages.length && !locked" class="hint">
            重新调查会更新这份未确认草案的页面建议。需要保留当前版本时，可先另存为新草案。
          </p>
          <OmDisclosure title="加入已有文章计划"
            ><div class="existing-row">
              <label
                >复用已有文章<OmSelect v-model="addExisting" :disabled="locked"
                  ><option value="">选择已有文章</option>
                  <option
                    v-for="page in existingPlans"
                    :key="page.key"
                    :value="page.key"
                  >
                    {{ page.plan?.title }}
                  </option></OmSelect
                ></label
              ><OmButton
                :disabled="!addExisting || locked || current.pages.length >= 32"
                @click="useExisting"
                >加入目录草案</OmButton
              >
            </div>
            <p class="hint">
              复用原页面，确认后按新目标重新调查与撰写。已有正文和固定引用历史保留。
            </p></OmDisclosure
          >
          <div v-if="current.pages.length" class="outline-workspace">
            <nav
              class="draft-directory"
              :class="{ expanded: showDirectory }"
              aria-label="草案页面目录"
            >
              <h4>建议阅读顺序 · {{ current.pages.length }} 页</h4>
              <ol>
                <li v-for="(page, index) in current.pages" :key="page.id">
                  <button
                    :class="{ selected: selectedPageKey === page.id }"
                    :aria-current="
                      selectedPageKey === page.id ? 'page' : undefined
                    "
                    @click="selectPage(page.id)"
                  >
                    <span class="page-number">{{ index + 1 }}</span
                    ><span
                      ><small>{{
                        page.topicPath?.join(" / ") || "未分类"
                      }}</small
                      ><strong>{{ page.title || "待填写页面标题" }}</strong
                      ><span>{{ page.goal || "阅读目标待填写" }}</span></span
                    >
                  </button>
                </li>
              </ol>
            </nav>
            <section
              v-if="selectedPage"
              class="page-editor"
              aria-label="页面计划编辑器"
            >
              <div class="page-actions">
                <OmButton
                  :disabled="
                    locked ||
                    current.pages.findIndex(
                      (page) => page.id === selectedPageKey,
                    ) === 0
                  "
                  aria-label="页面上移"
                  @click="reorder(-1)"
                  >上移</OmButton
                ><OmButton
                  :disabled="
                    locked ||
                    current.pages.findIndex(
                      (page) => page.id === selectedPageKey,
                    ) ===
                      current.pages.length - 1
                  "
                  aria-label="页面下移"
                  @click="reorder(1)"
                  >下移</OmButton
                ><OmButton
                  variant="ghost"
                  :disabled="locked"
                  @click="removePage"
                  >移除此页</OmButton
                >
              </div>
              <fieldset :disabled="locked" class="page-fields">
                <label
                  >页面标题<input
                    v-model="selectedPage.title"
                    maxlength="240"
                    aria-label="页面标题"
                /></label>
                <div class="field-pair">
                  <label
                    >讲解方式<OmSelect
                      v-model="selectedPage.kind"
                      aria-label="页面讲解方式"
                      ><option value="explanation">原理说明：理解为什么</option>
                      <option value="tutorial">教程：跟着案例学</option>
                      <option value="how-to">操作指南：完成具体任务</option>
                      <option value="reference">
                        参考：查定义与参数
                      </option></OmSelect
                    ></label
                  ><label
                    >页面读者<input
                      v-model="selectedPage.reader"
                      maxlength="1000"
                      aria-label="页面读者"
                  /></label>
                </div>
                <label
                  >读完这页能做什么<textarea
                    v-model="selectedPage.goal"
                    rows="3"
                    maxlength="3000"
                    aria-label="页面阅读目标"
                  />
                </label>
                <label
                  >从什么场景或案例讲起（建议填写）<textarea
                    v-model="selectedPage.scenario"
                    rows="3"
                    maxlength="3000"
                    aria-label="页面使用场景"
                    placeholder="描述读者会遇到的具体任务或问题"
                  />
                </label>
                <label
                  >这页要回答的问题<textarea
                    :value="selectedPage.questions.join('\n')"
                    @change="
                      selectedPage.questions = outlineLines(
                        ($event.target as HTMLTextAreaElement).value,
                      )
                    "
                    rows="4"
                    aria-label="页面要回答的问题"
                  /><small
                    >每行一个问题，最多 12
                    个。避免和其他页面重复解释同一件事。</small
                  ></label
                >
                <label
                  >移动到哪个目录<input
                    :value="selectedPage.topicPath?.join(' / ') || ''"
                    @change="
                      selectedPage.topicPath = outlinePath(
                        ($event.target as HTMLInputElement).value,
                      )
                    "
                    aria-label="页面目录路径"
                    placeholder="用 / 分隔目录层级"
                /></label>
              </fieldset>
              <OmDisclosure title="这一页使用的材料" :default-open="true"
                ><p class="hint">
                  {{ selectedPage.materialKeys?.length ?? 0 }}
                  份明确选择的来源<span v-if="selectedPage.contextIds?.length"
                    >，持续跟踪
                    {{ selectedPage.contextIds.length }} 个项目或主题</span
                  >。保留足够的背景，避免每页只围绕一个文件写。
                </p>
                <div class="page-materials">
                  <OmCheckbox
                    v-for="context in selectedContexts"
                    :key="context.id"
                    :checked="
                      selectedPage.contextIds?.includes(context.id) ?? false
                    "
                    :disabled="locked"
                    @change="
                      choosePageContext(
                        context.id,
                        ($event.target as HTMLInputElement).checked,
                      )
                    "
                    ><span
                      >项目或主题：{{ context.name
                      }}<small>包括以后加入的材料</small></span
                    ></OmCheckbox
                  ><OmCheckbox
                    v-for="material in scopeMaterials"
                    :key="material.key"
                    :checked="
                      selectedPage.materialKeys?.includes(material.key) ?? false
                    "
                    :disabled="locked"
                    @change="
                      choosePageMaterial(
                        material.key,
                        ($event.target as HTMLInputElement).checked,
                      )
                    "
                    ><span>{{ material.title }}</span></OmCheckbox
                  >
                </div>
                <OmButton variant="ghost" :disabled="locked" @click="applyScope"
                  >将本次材料范围用于全部页面</OmButton
                ></OmDisclosure
              >
              <OmDisclosure v-if="current.pages.length > 1" title="合并重复页面"
                ><div class="existing-row">
                  <label
                    >将此页合并到<OmSelect
                      v-model="mergeTarget"
                      aria-label="合并目标页面"
                      :disabled="locked"
                      ><option value="">选择保留的页面</option>
                      <option
                        v-for="page in current.pages.filter(
                          (item) => item.id !== selectedPageKey,
                        )"
                        :key="page.id"
                        :value="page.id"
                      >
                        {{ page.title || "待填写标题" }}
                      </option></OmSelect
                    ></label
                  ><OmButton
                    :disabled="!mergeTarget || locked"
                    @click="mergePage"
                    >合并页面</OmButton
                  >
                </div>
                <p class="hint">
                  保留目标页面，合并双方的问题与材料。合并后请再检查标题和范围；不会删除已发表文章。
                </p></OmDisclosure
              >
            </section>
          </div>
          <OmEmpty
            v-else-if="!planning"
            title="目录里还没有页面"
            description="让 AI 先建议阅读路线，或点击「添加页面」自己安排。"
          />
          <ul
            v-if="pageProblems.length && !planning"
            class="page-problems"
            aria-label="尚需补充的页面计划"
          >
            <li v-for="problem in pageProblems" :key="problem">
              {{ problem }}
            </li>
          </ul>
          <p class="hint">
            确认后保存正式页面目标和目录顺序，再逐页调查、写作与独立复核。文章失败时保留有效旧正文，不会把空计划当成文章。
          </p>
        </section>
      </template>
    </section>
    <template #actions
      ><div class="outline-footer">
        <span>{{
          mode === "edit" ? `第 ${step} 步，共 3 步` : "草案保存到当前个人库"
        }}</span>
        <div v-if="mode === 'edit' && confirmed">
          <OmButton @click="copyDraft">复制并调整目录</OmButton
          ><OmButton variant="ghost" @click="close">关闭</OmButton>
        </div>
        <div v-else-if="mode === 'edit'">
          <OmButton v-if="step > 1" :disabled="busy || locked" @click="step--"
            >上一步</OmButton
          ><OmButton :loading="busy" :disabled="locked" @click="saveDraft"
            >保存草案</OmButton
          ><OmButton
            v-if="step === 1"
            variant="primary"
            :disabled="!scopeMaterials.length && !current?.contextIds.length"
            @click="step = 2"
            >下一步</OmButton
          ><template v-else-if="step === 2"
            ><OmButton :disabled="!canPlan || busy || locked" @click="step = 3"
              >手动编排目录</OmButton
            ><OmButton
              variant="primary"
              :disabled="!canPlan || busy || locked || !available"
              @click="propose"
              >让 AI 建议目录</OmButton
            ></template
          ><OmButton
            v-else
            variant="primary"
            :disabled="!canApply || busy"
            @click="apply"
            >确认目录并开始写作</OmButton
          >
        </div>
        <OmButton v-else variant="ghost" @click="close">关闭</OmButton>
      </div></template
    >
  </OmDialog>
</template>

<style scoped>
.outline-planner {
  min-width: 0;
  font-size: 14px;
}
.outline-planner h3 {
  font-size: 20px;
  line-height: 1.6;
  margin: 0;
}
.outline-planner p {
  line-height: 1.8;
  margin: 0;
}
.section-heading {
  display: grid;
  gap: 8px;
  margin-bottom: 24px;
}
.section-heading p,
.hint {
  color: var(--om-secondary);
}
.hint {
  font-size: 13px;
}
.error,
.notice,
.close-guard {
  padding: 16px;
  border: 1px solid var(--om-line);
  border-radius: 8px;
  margin-bottom: 16px !important;
  overflow-wrap: anywhere;
}
.notice,
.close-guard {
  background: var(--om-paper);
}
.error,
.page-problems {
  color: var(--om-danger);
}
.close-guard {
  display: grid;
  gap: 12px;
}
.button-row,
.draft-topline,
.outline-toolbar,
.page-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.draft-topline {
  margin-bottom: 20px;
}
.save-state {
  color: var(--om-muted);
  font-size: 13px;
}
.outline-steps {
  display: flex;
  gap: 24px;
  list-style: none;
  padding: 0 0 20px;
  margin: 0 0 24px;
  border-bottom: 1px solid var(--om-line);
  color: var(--om-muted);
  font-size: 13px;
}
.outline-steps li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.outline-steps li.active {
  color: var(--om-ink);
  font-weight: 600;
}
.outline-steps li > span {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--om-line);
  border-radius: 50%;
  flex-shrink: 0;
}
.outline-steps li.active > span {
  color: white;
  background: var(--om-ink);
}
.scope-step,
.purpose-step,
.outline-step {
  display: grid;
  gap: 24px;
}
.scope-step > .section-heading,
.purpose-step > .section-heading,
.outline-step > .section-heading {
  margin-bottom: 0;
}
label {
  display: grid;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
}
input,
textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  font: inherit;
  color: var(--om-ink);
  background: var(--om-panel);
  border: 1px solid var(--om-line);
  border-radius: 6px;
  padding: 10px 12px;
}
textarea {
  resize: vertical;
  line-height: 1.8;
}
label small {
  color: var(--om-muted);
  line-height: 1.7;
}
.material-toolbar {
  display: flex;
  align-items: end;
  gap: 12px;
}
.material-toolbar > label {
  flex: 1;
}
.material-toolbar > button {
  flex-shrink: 0;
}
.material-options {
  border: 1px solid var(--om-line);
  border-radius: 8px;
  max-height: 320px;
  overflow: auto;
}
.material-options > p {
  padding: 24px;
}
.material-option {
  display: flex;
  width: 100%;
  min-height: 60px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--om-line);
  box-sizing: border-box;
}
.material-option:last-child {
  border-bottom: 0;
}
.material-option :deep(.om-choice-copy) {
  min-width: 0;
}
.material-option strong,
.material-option small,
.page-materials small {
  display: block;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.material-option strong {
  font-size: 14px;
  font-weight: 500;
}
.material-option small,
.page-materials small {
  font-size: 12px;
  color: var(--om-muted);
}
.draft-list-heading {
  margin-top: 32px !important;
}
.saved-drafts,
.draft-directory ol {
  list-style: none;
  margin: 0;
  padding: 0;
}
.saved-drafts li {
  border-bottom: 1px solid var(--om-line);
}
.saved-drafts button {
  display: grid;
  gap: 8px;
  width: 100%;
  border: 0;
  padding: 20px 8px;
  background: none;
  text-align: left;
}
.saved-drafts button:hover {
  background: var(--om-paper);
}
.saved-drafts strong {
  font-size: 16px;
}
.saved-drafts span {
  color: var(--om-secondary);
  overflow-wrap: anywhere;
}
.saved-drafts small {
  color: var(--om-muted);
}
.existing-row {
  display: flex;
  gap: 12px;
  align-items: end;
}
.existing-row > label {
  flex: 1;
}
.existing-row > button {
  flex-shrink: 0;
}
.outline-workspace {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(0, 2fr);
  gap: 24px;
  align-items: start;
}
.draft-directory {
  min-width: 0;
  border: 1px solid var(--om-line);
  border-radius: 8px;
  background: var(--om-paper);
}
.draft-directory h4 {
  font-size: 14px;
  padding: 16px;
  margin: 0;
  border-bottom: 1px solid var(--om-line);
}
.draft-directory button {
  display: flex;
  gap: 12px;
  align-items: start;
  width: 100%;
  padding: 16px;
  min-height: 60px;
  text-align: left;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--om-line);
}
.draft-directory button.selected {
  background: var(--om-soft);
}
.draft-directory button > span:last-child {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.draft-directory button small {
  color: var(--om-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.draft-directory button strong {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.draft-directory button span span {
  color: var(--om-secondary);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.page-number {
  color: var(--om-muted);
  font-size: 13px;
}
.page-editor {
  display: grid;
  gap: 24px;
  min-width: 0;
}
.page-fields {
  display: grid;
  gap: 16px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.field-pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}
.page-materials {
  max-height: 240px;
  overflow: auto;
  display: grid;
  gap: 4px;
  border: 1px solid var(--om-line);
  border-radius: 6px;
  padding: 8px;
}
.page-materials :deep(.om-choice) {
  padding: 8px;
  min-width: 0;
  width: 100%;
  align-items: start;
}
.page-materials :deep(.om-choice-copy) {
  min-width: 0;
  overflow-wrap: anywhere;
}
.applied-status {
  display: grid;
  gap: 12px;
  padding: 16px;
  background: var(--om-paper);
  border: 1px solid var(--om-line);
  border-radius: 8px;
}
.applied-status h4 {
  margin: 0;
}
.applied-status ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.applied-status li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--om-line);
}
.applied-status li > div {
  display: grid;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.applied-status span,
.applied-status small {
  color: var(--om-secondary);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.planning-gaps {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
}
.page-problems {
  line-height: 1.8;
  margin: 0;
  padding-left: 20px;
}
.directory-toggle {
  display: none;
}
.outline-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  align-items: center;
}
.outline-footer > span {
  color: var(--om-muted);
  font-size: 12px;
}
.outline-footer > div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.outline-footer :deep(button) {
  font-size: 14px;
}
@media (max-width: 900px) {
  .outline-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
  .draft-directory {
    display: none;
  }
  .draft-directory.expanded {
    display: block;
  }
  .directory-toggle {
    display: inline-flex;
  }
  .field-pair {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 700px) {
  .outline-steps {
    gap: 12px;
    flex-wrap: wrap;
  }
  .material-toolbar,
  .existing-row {
    align-items: stretch;
    flex-direction: column;
  }
  .outline-footer {
    gap: 8px;
  }
  .outline-footer > div {
    width: 100%;
  }
  .outline-footer > div > :deep(button) {
    flex: 1 1 auto;
  }
}
</style>
