<script setup lang="ts">
import { ref } from "vue";
import OmSelect from "./OmSelect.vue";
import OmCheckbox from "./OmCheckbox.vue";
import OmRadio from "./OmRadio.vue";

const scope = ref("current");
const enabled = ref(true);
const materials = ref(["document"]);
const mode = ref("manual");
</script>

<template>
  <div class="form-showcase">
    <div class="select-examples">
      <label
        >回答范围
        <OmSelect v-model="scope" aria-label="回答范围">
          <option value="current">当前材料</option>
          <option value="library">整个知识库</option>
        </OmSelect>
      </label>
      <label
        >暂不可用
        <OmSelect value="loading" disabled aria-label="暂不可用">
          <option value="loading">正在读取可用模型</option>
        </OmSelect>
      </label>
      <label
        >需要补充
        <OmSelect
          value=""
          invalid
          aria-label="需要补充"
          aria-describedby="design-select-error"
        >
          <option value="">请选择材料用途</option>
          <option value="guide">使用指南</option>
        </OmSelect>
        <span id="design-select-error" class="field-error"
          >选择用途后才能保存。</span
        >
      </label>
    </div>
    <fieldset>
      <legend>勾选与说明</legend>
      <OmCheckbox
        v-model="enabled"
        hint="材料有变化时更新文章，期间仍可阅读旧版。"
        >随材料自动更新</OmCheckbox
      >
      <OmCheckbox label="部分材料已选择" indeterminate />
      <OmCheckbox label="等待权限后可开启" disabled />
      <OmCheckbox
        label="保存之前确认材料范围"
        error="请先确认你需要处理的材料。"
      />
    </fieldset>
    <fieldset>
      <legend>多个选择</legend>
      <div class="choice-row">
        <OmCheckbox v-model="materials" value="document" label="文档" />
        <OmCheckbox v-model="materials" value="chat" label="聊天记录" />
      </div>
    </fieldset>
    <fieldset>
      <legend>单选</legend>
      <div class="choice-row">
        <OmRadio
          v-model="mode"
          name="design-maintenance"
          value="manual"
          label="手动整理"
        />
        <OmRadio
          v-model="mode"
          name="design-maintenance"
          value="automatic"
          label="自动维护"
        />
      </div>
    </fieldset>
    <p class="selection-status" role="status">
      当前范围：{{
        scope === "current" ? "当前材料" : "整个知识库"
      }}；自动更新{{ enabled ? "已开启" : "未开启" }}；已选
      {{ materials.length }} 类材料。
    </p>
  </div>
</template>

<style scoped>
.form-showcase {
  display: grid;
  gap: 24px;
  width: 100%;
  min-width: 0;
}
.select-examples {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  align-items: start;
  gap: 16px;
}
fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
legend {
  margin-bottom: 8px;
  padding: 0;
  font-size: 14px;
  font-weight: 600;
}
.choice-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
}
.field-error {
  font-size: 13px;
  color: var(--om-danger);
}
.selection-status {
  margin: 0;
  padding-top: 16px;
  border-top: 1px solid var(--om-line);
  color: var(--om-secondary);
  font-size: 13px;
}
</style>
