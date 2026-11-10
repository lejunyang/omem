<script setup lang="ts">
import type { StatusFilter, TypeFilter } from "../../shared/network-filters";
import { useInjectedPanelContext } from "../use-panel-context";

const { deletePreset, movePreset, presets, showPresetManager, statusFilters, typeFilters, updatePreset } =
  useInjectedPanelContext();
</script>

<template>
  <section v-if="showPresetManager" class="action-panel">
    <div class="action-panel-text">
      <strong>全部筛选</strong>
      <span>启用的规则会与临时输入框按 AND 生效。</span>
    </div>
    <div v-if="!presets.length" class="filter-empty">暂无保存筛选。可以先在输入框填写条件，再点击“保存筛选”。</div>
    <div v-else class="filter-rule-list">
      <article v-for="(preset, index) in presets" :key="preset.id" class="filter-rule-card">
        <label class="builder-check">
          <input
            :checked="preset.enabled"
            type="checkbox"
            @change="updatePreset(preset.id, { enabled: ($event.target as HTMLInputElement).checked })"
          />
          启用
        </label>
        <label class="builder-field">
          名称
          <input
            class="filter-input"
            :value="preset.name"
            :title="preset.name"
          @change="updatePreset(preset.id, { name: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="builder-field builder-field-wide">
          URL / DSL
          <input
            class="filter-input"
            :value="preset.query"
            :title="preset.query"
            placeholder="例如 url:/api/users status>=400"
          @change="updatePreset(preset.id, { query: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="builder-field">
          类型
          <select
            class="preset-select"
            :value="preset.typeFilter"
          @change="updatePreset(preset.id, { typeFilter: ($event.target as HTMLSelectElement).value as TypeFilter })"
          >
          <option v-for="typeFilter in typeFilters" :key="typeFilter.value" :value="typeFilter.value">
              {{ typeFilter.label }}
            </option>
          </select>
        </label>
        <label class="builder-field">
          状态
          <select
            class="preset-select"
            :value="preset.statusFilter"
          @change="updatePreset(preset.id, { statusFilter: ($event.target as HTMLSelectElement).value as StatusFilter })"
          >
          <option v-for="statusFilter in statusFilters" :key="statusFilter.value" :value="statusFilter.value">
              {{ statusFilter.label }}
            </option>
          </select>
        </label>
        <button class="button button-icon" type="button" :disabled="index === 0" @click="movePreset(preset.id, 'up')">上移</button>
        <button class="button button-icon" type="button" :disabled="index === presets.length - 1" @click="movePreset(preset.id, 'down')">下移</button>
        <button class="button button-danger" type="button" @click="deletePreset(preset.id)">删除</button>
      </article>
    </div>
  </section>
</template>
