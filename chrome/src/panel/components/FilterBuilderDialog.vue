<script setup lang="ts">
import { shouldHandleEnterKey } from "../../shared/keyboard";
import type {
  AdvancedFilterField,
  AdvancedFilterOperator
} from "../../shared/network-filters";
import type { AppendMode } from "../panel-types";
import { useInjectedPanelContext } from "../use-panel-context";

const {
  addVisualFilterCondition,
  builderAppendMode,
  builderField,
  builderNegative,
  builderOperator,
  builderOperatorOptions,
  builderPlaceholder,
  builderValue,
  filterFieldOptions,
  filterValidation,
  showFilterBuilderDialog,
  updateBuilderField,
  visualConditionToken
} = useInjectedPanelContext();

function handleBuilderValueKeyup(event: KeyboardEvent): void {
  if (shouldHandleEnterKey(event)) {
    addVisualFilterCondition();
  }
}
</script>

<template>
  <div v-if="showFilterBuilderDialog" class="dialog-backdrop" @click.self="showFilterBuilderDialog = false">
    <section class="dialog dialog-wide">
      <header class="dialog-header">
        <strong>添加筛选条件</strong>
        <button class="button" type="button" @click="showFilterBuilderDialog = false">关闭</button>
      </header>

      <div class="filter-builder filter-builder-dialog">
        <label class="builder-field">
          字段
          <select class="preset-select" :value="builderField" @change="updateBuilderField(($event.target as HTMLSelectElement).value as AdvancedFilterField)">
            <option v-for="option in filterFieldOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="builder-field builder-operator-field">
          <span class="builder-label-row">
            <span>对比方式</span>
            <label class="builder-check builder-check-inline">
              <input :checked="builderNegative" type="checkbox" @change="builderNegative = ($event.target as HTMLInputElement).checked" />
              否定
            </label>
          </span>
          <select class="preset-select" :value="builderOperator" @change="builderOperator = (($event.target as HTMLSelectElement).value as AdvancedFilterOperator)">
            <option v-for="option in builderOperatorOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="builder-field builder-field-wide">
          值
          <input
            class="filter-input"
            :value="builderValue"
            :placeholder="builderPlaceholder()"
            @input="builderValue = ($event.target as HTMLInputElement).value"
            @keyup="handleBuilderValueKeyup"
          />
        </label>
        <label class="builder-field">
          追加方式
          <select class="preset-select" :value="builderAppendMode" @change="builderAppendMode = (($event.target as HTMLSelectElement).value as AppendMode)">
            <option value="and">AND 追加</option>
            <option value="or">OR 分组追加</option>
          </select>
        </label>
        <button class="button" type="button" @click="addVisualFilterCondition()">添加条件</button>
      </div>

      <div class="filter-preview">
        <span>将添加：</span>
        <code>{{ visualConditionToken || "(等待输入)" }}</code>
      </div>
      <div v-if="filterValidation.errors.length" class="filter-validation">
        <strong>校验提示</strong>
        <span v-for="error in filterValidation.errors" :key="error">{{ error }}</span>
      </div>
    </section>
  </div>
</template>
