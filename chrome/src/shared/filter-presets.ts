import {
  matchesAdvancedQuery,
  matchesStatus,
  matchesType,
  STATUS_FILTERS,
  type StatusFilter,
  TYPE_FILTERS,
  type TypeFilter
} from "./network-filters";
import type { NetworkRecord } from "./network";
import { normalizeStoredList } from "./stored-list";

export interface FilterPreset {
  id: string;
  name: string;
  enabled: boolean;
  query: string;
  typeFilter: TypeFilter;
  statusFilter: StatusFilter;
}

export function createFilterPreset(input: {
  id: string;
  name: string;
  enabled?: boolean;
  query: string;
  typeFilter: TypeFilter;
  statusFilter: StatusFilter;
}): FilterPreset {
  return {
    id: input.id,
    name: input.name,
    enabled: input.enabled ?? false,
    query: input.query,
    typeFilter: input.typeFilter,
    statusFilter: input.statusFilter
  };
}

export function normalizeFilterPresets(value: unknown): FilterPreset[] {
  return normalizeStoredList(value).flatMap((item) => {
    if (!isPresetLike(item)) {
      return [];
    }

    return [
      {
        id: item.id,
        name: item.name,
        enabled: typeof item.enabled === "boolean" ? item.enabled : false,
        query: item.query,
        typeFilter: isTypeFilter(item.typeFilter) ? item.typeFilter : "all",
        statusFilter: isStatusFilter(item.statusFilter) ? item.statusFilter : "all"
      }
    ];
  });
}

export function describeFilterPreset(preset: FilterPreset): string {
  return [
    `名称：${preset.name}`,
    `启用：${preset.enabled ? "是" : "否"}`,
    `筛选：${preset.query || "(全部)"}`,
    `类型：${preset.typeFilter}`,
    `状态：${preset.statusFilter}`
  ].join("\n");
}

export function moveFilterPreset(
  presets: FilterPreset[],
  presetId: string,
  direction: "up" | "down"
): FilterPreset[] {
  const index = presets.findIndex((preset) => preset.id === presetId);
  if (index < 0) {
    return presets;
  }

  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= presets.length) {
    return presets;
  }

  const nextPresets = [...presets];
  [nextPresets[index], nextPresets[targetIndex]] = [nextPresets[targetIndex], nextPresets[index]];
  return nextPresets;
}

export function matchesFilterPreset(record: NetworkRecord, preset: FilterPreset): boolean {
  return (
    matchesAdvancedQuery(record, preset.query) &&
    matchesType(record, preset.typeFilter) &&
    matchesStatus(record, preset.statusFilter)
  );
}

export function matchesEnabledFilterPresets(record: NetworkRecord, presets: FilterPreset[]): boolean {
  return presets.filter((preset) => preset.enabled).every((preset) => matchesFilterPreset(record, preset));
}

function isPresetLike(value: unknown): value is {
  id: string;
  name: string;
  enabled?: unknown;
  query: string;
  typeFilter?: unknown;
  statusFilter?: unknown;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.query === "string"
  );
}

function isTypeFilter(value: unknown): value is TypeFilter {
  return TYPE_FILTERS.some((item) => item.value === value);
}

function isStatusFilter(value: unknown): value is StatusFilter {
  return STATUS_FILTERS.some((item) => item.value === value);
}
