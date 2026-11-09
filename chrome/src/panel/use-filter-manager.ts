import { computed, ref, type Ref } from "vue";
import {
  createFilterPreset,
  type FilterPreset,
  matchesEnabledFilterPresets as recordMatchesEnabledFilterPresets,
  moveFilterPreset
} from "../shared/filter-presets";
import {
  appendAdvancedFilterToken,
  type AdvancedFilterOperator,
  type AdvancedFilterField,
  buildAdvancedFilterToken,
  getAdvancedFilterOperatorOptions,
  type StatusFilter,
  type TypeFilter
} from "../shared/network-filters";
import type { NetworkRecord } from "../shared/network";
import { FILTER_FIELD_OPTIONS } from "./panel-options";
import type { AppendMode } from "./panel-types";
import { loadFilterPresetsFromStorage, persistFilterPresetsToStorage } from "./persistent-state";

export function useFilterManager(input: {
  filter: Ref<string>;
  message: Ref<string>;
  selectedStatusFilter: Ref<StatusFilter>;
  selectedTypeFilter: Ref<TypeFilter>;
}) {
  const presets = ref<FilterPreset[]>([]);
  const selectedPresetId = ref("");
  const builderField = ref<AdvancedFilterField>("method");
  const builderOperator = ref<AdvancedFilterOperator>("contains");
  const builderValue = ref("");
  const builderNegative = ref(false);
  const builderAppendMode = ref<AppendMode>("and");
  const saveDialogVisible = ref(false);
  const savePresetName = ref("");

  const selectedPreset = computed(
    () => presets.value.find((preset) => preset.id === selectedPresetId.value) ?? null
  );
  const selectedPresetIndex = computed(() =>
    presets.value.findIndex((preset) => preset.id === selectedPresetId.value)
  );
  const canMovePresetUp = computed(() => selectedPresetIndex.value > 0);
  const canMovePresetDown = computed(
    () => selectedPresetIndex.value >= 0 && selectedPresetIndex.value < presets.value.length - 1
  );
  const visualConditionToken = computed(() =>
    buildAdvancedFilterToken({
      field: builderField.value,
      operator: builderOperator.value,
      value: builderValue.value,
      negative: builderNegative.value
    })
  );
  const builderOperatorOptions = computed(() => getAdvancedFilterOperatorOptions(builderField.value));
  const enabledPresets = computed(() => presets.value.filter((preset) => preset.enabled));
  const enabledPresetSummary = computed(() => {
    if (!enabledPresets.value.length) {
      return "";
    }
    return `启用 ${enabledPresets.value.length} 条：${enabledPresets.value
      .map((preset) => preset.name)
      .join(" AND ")}`;
  });
  const enabledPresetQueryPreview = computed(() =>
    enabledPresets.value.map((preset) => describePresetAsQuery(preset)).join(" AND ")
  );

  async function loadPresets(): Promise<void> {
    presets.value = await loadFilterPresetsFromStorage();
  }

  async function saveCurrentPreset(): Promise<void> {
    const query = input.filter.value.trim();
    const typeFilter = input.selectedTypeFilter.value;
    const statusFilter = input.selectedStatusFilter.value;
    if (!query && typeFilter === "all" && statusFilter === "all") {
      input.message.value = "筛选条件为空，无法保存。";
      return;
    }

    savePresetName.value = suggestPresetName(query, typeFilter, statusFilter);
    saveDialogVisible.value = true;
  }

  async function confirmSavePreset(): Promise<void> {
    const query = input.filter.value.trim();
    const typeFilter = input.selectedTypeFilter.value;
    const statusFilter = input.selectedStatusFilter.value;
    const name = savePresetName.value.trim();
    if (!name) {
      input.message.value = "筛选方案名称不能为空。";
      return;
    }
    if (presets.value.some((preset) => preset.name === name)) {
      input.message.value = `筛选方案名称已存在：${name}`;
      return;
    }

    const preset = createFilterPreset({
      id: crypto.randomUUID(),
      name,
      enabled: true,
      query,
      typeFilter,
      statusFilter
    });

    presets.value = [...presets.value, preset];
    await persistPresets();
    selectedPresetId.value = preset.id;
    saveDialogVisible.value = false;
    savePresetName.value = "";
    input.message.value = "";
  }

  function cancelSavePreset(): void {
    saveDialogVisible.value = false;
    savePresetName.value = "";
  }

  async function deleteSelectedPreset(): Promise<void> {
    const preset = selectedPreset.value;
    if (!preset) {
      input.message.value = "请先选择要删除的筛选方案。";
      return;
    }
    if (!window.confirm(`确定删除筛选方案“${preset.name}”吗？`)) {
      return;
    }

    presets.value = presets.value.filter((item) => item.id !== preset.id);
    selectedPresetId.value = "";
    await persistPresets();
    input.message.value = `已删除筛选方案：${preset.name}`;
  }

  async function moveSelectedPreset(direction: "up" | "down"): Promise<void> {
    if (!selectedPreset.value) {
      input.message.value = "请先选择要排序的筛选方案。";
      return;
    }

    const nextPresets = moveFilterPreset(presets.value, selectedPreset.value.id, direction);
    if (nextPresets === presets.value) {
      return;
    }

    presets.value = nextPresets;
    await persistPresets();
    input.message.value = "";
  }

  async function movePreset(presetId: string, direction: "up" | "down"): Promise<void> {
    const nextPresets = moveFilterPreset(presets.value, presetId, direction);
    if (nextPresets === presets.value) {
      return;
    }
    presets.value = nextPresets;
    await persistPresets();
  }

  async function deletePreset(presetId: string): Promise<void> {
    presets.value = presets.value.filter((preset) => preset.id !== presetId);
    if (selectedPresetId.value === presetId) {
      selectedPresetId.value = "";
    }
    await persistPresets();
  }

  async function updatePreset(
    presetId: string,
    patch: Partial<Pick<FilterPreset, "enabled" | "name" | "query" | "typeFilter" | "statusFilter">>
  ): Promise<void> {
    const duplicateName = patch.name?.trim();
    if (duplicateName && presets.value.some((preset) => preset.id !== presetId && preset.name === duplicateName)) {
      input.message.value = `筛选方案名称已存在：${duplicateName}`;
      return;
    }
    presets.value = presets.value.map((preset) =>
      preset.id === presetId
        ? {
            ...preset,
            ...patch,
            name: patch.name?.trim() || preset.name
          }
        : preset
    );
    await persistPresets();
  }

  function addVisualFilterCondition(): void {
    const token = visualConditionToken.value;
    if (!token) {
      input.message.value = "请先填写可视化筛选条件的值。";
      return;
    }

    input.filter.value = appendAdvancedFilterToken(input.filter.value, token, builderAppendMode.value);
    builderValue.value = "";
    input.message.value = "";
  }

  function updateBuilderField(field: AdvancedFilterField): void {
    builderField.value = field;
    const options = getAdvancedFilterOperatorOptions(field);
    if (!options.some((option) => option.value === builderOperator.value)) {
      builderOperator.value = options[0]?.value ?? "contains";
    }
  }

  function useFilterExample(example: string): void {
    input.filter.value = example;
    input.message.value = "";
  }

  function builderPlaceholder(): string {
    return (
      FILTER_FIELD_OPTIONS.find((option) => option.value === builderField.value)?.placeholder ??
      "输入条件值"
    );
  }

  async function persistPresets(): Promise<void> {
    await persistFilterPresetsToStorage(presets.value);
  }

  function matchesEnabledFilterPresets(record: NetworkRecord): boolean {
    return recordMatchesEnabledFilterPresets(record, presets.value);
  }

  return {
    addVisualFilterCondition,
    builderAppendMode,
    builderField,
    builderNegative,
    builderOperator,
    builderOperatorOptions,
    builderPlaceholder,
    builderValue,
    canMovePresetDown,
    canMovePresetUp,
    cancelSavePreset,
    confirmSavePreset,
    deleteSelectedPreset,
    deletePreset,
    enabledPresetQueryPreview,
    enabledPresets,
    enabledPresetSummary,
    loadPresets,
    matchesEnabledFilterPresets,
    movePreset,
    moveSelectedPreset,
    presets,
    saveDialogVisible,
    saveCurrentPreset,
    savePresetName,
    selectedPreset,
    selectedPresetId,
    updateBuilderField,
    updatePreset,
    useFilterExample,
    visualConditionToken
  };
}

function suggestPresetName(query: string, typeFilter: TypeFilter, statusFilter: StatusFilter): string {
  return query || `${typeFilter} / ${statusFilter}`;
}

function describePresetAsQuery(preset: FilterPreset): string {
  return [
    preset.query ? `(${preset.query})` : "",
    preset.typeFilter !== "all" ? `type:${preset.typeFilter}` : "",
    preset.statusFilter !== "all" ? `status:${preset.statusFilter}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}
