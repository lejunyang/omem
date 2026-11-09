<script setup lang="ts">
import { shouldHandleEnterKey } from "../../shared/keyboard";
import { useInjectedPanelContext } from "../use-panel-context";

const {
  cancelSavePreset,
  confirmSavePreset,
  filter,
  saveDialogVisible,
  savePresetName,
  selectedStatusFilter,
  selectedTypeFilter
} = useInjectedPanelContext();

function handleSavePresetNameKeyup(event: KeyboardEvent): void {
  if (shouldHandleEnterKey(event)) {
    void handleConfirmSavePreset();
  }
}

// 确认保存会触发异步 storage 持久化；组件显式 await，确保成功后的关闭状态在交互路径中稳定生效。
async function handleConfirmSavePreset(): Promise<void> {
  await confirmSavePreset();
}
</script>

<template>
  <div v-if="saveDialogVisible" class="dialog-backdrop" data-testid="save-preset-dialog" @click.self="cancelSavePreset">
    <section class="dialog">
      <header class="dialog-header">
        <strong>保存筛选</strong>
        <button class="button" type="button" @click="cancelSavePreset">关闭</button>
      </header>
      <label class="builder-field">
        名称
        <input
          class="filter-input"
          :value="savePresetName"
          data-testid="save-preset-name"
          placeholder="请输入唯一的筛选名称"
          @input="savePresetName = ($event.target as HTMLInputElement).value"
          @keyup="handleSavePresetNameKeyup"
        />
      </label>
      <div class="dialog-summary">
        <span>临时筛选：{{ filter || "(全部)" }}</span>
        <span>类型：{{ selectedTypeFilter }}</span>
        <span>状态：{{ selectedStatusFilter }}</span>
      </div>
      <footer class="dialog-actions">
        <button class="button" type="button" @click="cancelSavePreset">取消</button>
        <button class="button is-active" data-testid="save-preset-confirm" type="button" @click="handleConfirmSavePreset">
          确认保存
        </button>
      </footer>
    </section>
  </div>
</template>
