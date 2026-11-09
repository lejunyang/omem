<script setup lang="ts">
import type { DeviceEmulationContext } from "../use-device-emulation-context";
import type { DeviceMetricDisplayFeatureOverride, DeviceMetricViewportOverride, DeviceMetricsAdvancedSettings } from "../device-emulation";
const props = defineProps<{ context: DeviceEmulationContext }>();
const numberValue = (event: Event) => Number((event.target as HTMLInputElement).value);
const checkedValue = (event: Event) => (event.target as HTMLInputElement).checked;
const textValue = (event: Event) => (event.target as HTMLInputElement).value;
// 实验参数独立收口，常用配置不必承载完整 CDP 字段表单。
const updateSelectedProfile = (patch: { metricsAdvanced: DeviceMetricsAdvancedSettings }) => props.context.updateProfile(props.context.selectedProfile.value.id, patch);
async function updateAdvanced(patch: Partial<DeviceMetricsAdvancedSettings>): Promise<void> {
  // CDP 高级参数随设备配置持久化；每项都必须显式 enabled，避免默认值误下发导致真实页面滚动和渲染区域异常。
  await updateSelectedProfile({
    metricsAdvanced: {
      ...props.context.selectedProfile.value.metricsAdvanced,
      ...patch
    }
  });
}

async function updateAdvancedNumber(
  key: "scale" | "screenWidth" | "screenHeight" | "positionX" | "positionY",
  patch: { enabled?: boolean; value?: number }
): Promise<void> {
  await updateAdvanced({
    [key]: {
      ...props.context.selectedProfile.value.metricsAdvanced[key],
      ...patch
    }
  });
}

async function updateDontSetVisibleSize(patch: { enabled?: boolean; value?: boolean }): Promise<void> {
  await updateAdvanced({
    dontSetVisibleSize: {
      ...props.context.selectedProfile.value.metricsAdvanced.dontSetVisibleSize,
      ...patch
    }
  });
}

async function updateViewport(patch: Partial<DeviceMetricViewportOverride>): Promise<void> {
  await updateAdvanced({
    viewport: {
      ...props.context.selectedProfile.value.metricsAdvanced.viewport,
      ...patch
    }
  });
}

async function updateDisplayFeature(patch: Partial<DeviceMetricDisplayFeatureOverride>): Promise<void> {
  await updateAdvanced({
    displayFeature: {
      ...props.context.selectedProfile.value.metricsAdvanced.displayFeature,
      ...patch
    }
  });
}
</script>
<template>
      <section class="device-emulation-card device-emulation-card-wide">
        <details>
          <summary class="device-emulation-card-title">
            <strong>CDP 高级参数</strong>
            <span>默认全部不下发；勾选后才写入 Emulation.setDeviceMetricsOverride。</span>
          </summary>
          <p class="device-emulation-note">
            这些字段来自官方 CDP 文档，部分为 Experimental。尤其 viewport 官方说明“页面不可感知”，可能导致滚动、fixed
            元素或渲染区域异常，请仅用于手动调试。
          </p>
          <div class="device-two-columns">
            <label class="device-field">
              <span>
                <input
                  type="checkbox"
                  :checked="context.selectedProfile.value.metricsAdvanced.scale.enabled"
                  @change="updateAdvancedNumber('scale', { enabled: checkedValue($event) })"
                />
                scale
              </span>
              <input
                class="filter-input"
                data-testid="device-advanced-scale"
                min="0.1"
                step="0.1"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.scale.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.scale.value"
                @change="updateAdvancedNumber('scale', { value: numberValue($event) })"
              />
            </label>
            <label class="device-field">
              <span>
                <input
                  type="checkbox"
                  :checked="context.selectedProfile.value.metricsAdvanced.dontSetVisibleSize.enabled"
                  @change="updateDontSetVisibleSize({ enabled: checkedValue($event) })"
                />
                dontSetVisibleSize
              </span>
              <label class="toolbar-check">
                <input
                  type="checkbox"
                  :disabled="!context.selectedProfile.value.metricsAdvanced.dontSetVisibleSize.enabled"
                  :checked="context.selectedProfile.value.metricsAdvanced.dontSetVisibleSize.value"
                  @change="updateDontSetVisibleSize({ value: checkedValue($event) })"
                />
                value
              </label>
            </label>
          </div>

          <div class="device-two-columns">
            <label class="device-field">
              <span>
                <input
                  type="checkbox"
                  :checked="context.selectedProfile.value.metricsAdvanced.screenWidth.enabled"
                  @change="updateAdvancedNumber('screenWidth', { enabled: checkedValue($event) })"
                />
                screenWidth
              </span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.screenWidth.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.screenWidth.value"
                @change="updateAdvancedNumber('screenWidth', { value: numberValue($event) })"
              />
            </label>
            <label class="device-field">
              <span>
                <input
                  type="checkbox"
                  :checked="context.selectedProfile.value.metricsAdvanced.screenHeight.enabled"
                  @change="updateAdvancedNumber('screenHeight', { enabled: checkedValue($event) })"
                />
                screenHeight
              </span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.screenHeight.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.screenHeight.value"
                @change="updateAdvancedNumber('screenHeight', { value: numberValue($event) })"
              />
            </label>
          </div>

          <div class="device-two-columns">
            <label class="device-field">
              <span>
                <input
                  type="checkbox"
                  :checked="context.selectedProfile.value.metricsAdvanced.positionX.enabled"
                  @change="updateAdvancedNumber('positionX', { enabled: checkedValue($event) })"
                />
                positionX
              </span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.positionX.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.positionX.value"
                @change="updateAdvancedNumber('positionX', { value: numberValue($event) })"
              />
            </label>
            <label class="device-field">
              <span>
                <input
                  type="checkbox"
                  :checked="context.selectedProfile.value.metricsAdvanced.positionY.enabled"
                  @change="updateAdvancedNumber('positionY', { enabled: checkedValue($event) })"
                />
                positionY
              </span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.positionY.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.positionY.value"
                @change="updateAdvancedNumber('positionY', { value: numberValue($event) })"
              />
            </label>
          </div>

          <div class="device-emulation-card-title">
            <strong>
              <input
                type="checkbox"
                :checked="context.selectedProfile.value.metricsAdvanced.viewport.enabled"
                @change="updateViewport({ enabled: checkedValue($event) })"
              />
              viewport
            </strong>
          </div>
          <div class="device-two-columns">
            <label class="device-field">
              <span>x</span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.viewport.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.viewport.x"
                @change="updateViewport({ x: numberValue($event) })"
              />
            </label>
            <label class="device-field">
              <span>y</span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.viewport.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.viewport.y"
                @change="updateViewport({ y: numberValue($event) })"
              />
            </label>
            <label class="device-field">
              <span>width</span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.viewport.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.viewport.width"
                @change="updateViewport({ width: numberValue($event) })"
              />
            </label>
            <label class="device-field">
              <span>height</span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.viewport.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.viewport.height"
                @change="updateViewport({ height: numberValue($event) })"
              />
            </label>
            <label class="device-field">
              <span>scale</span>
              <input
                class="filter-input"
                min="0.1"
                step="0.1"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.viewport.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.viewport.scale"
                @change="updateViewport({ scale: numberValue($event) })"
              />
            </label>
          </div>

          <div class="device-emulation-card-title">
            <strong>
              <input
                type="checkbox"
                :checked="context.selectedProfile.value.metricsAdvanced.displayFeature.enabled"
                @change="updateDisplayFeature({ enabled: checkedValue($event) })"
              />
              displayFeature
            </strong>
          </div>
          <div class="device-two-columns">
            <label class="device-field">
              <span>orientation</span>
              <select
                class="preset-select"
                :disabled="!context.selectedProfile.value.metricsAdvanced.displayFeature.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.displayFeature.orientation"
                @change="updateDisplayFeature({ orientation: textValue($event) === 'horizontal' ? 'horizontal' : 'vertical' })"
              >
                <option value="vertical">vertical</option>
                <option value="horizontal">horizontal</option>
              </select>
            </label>
            <label class="device-field">
              <span>offset</span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.displayFeature.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.displayFeature.offset"
                @change="updateDisplayFeature({ offset: numberValue($event) })"
              />
            </label>
            <label class="device-field">
              <span>maskLength</span>
              <input
                class="filter-input"
                min="0"
                type="number"
                :disabled="!context.selectedProfile.value.metricsAdvanced.displayFeature.enabled"
                :value="context.selectedProfile.value.metricsAdvanced.displayFeature.maskLength"
                @change="updateDisplayFeature({ maskLength: numberValue($event) })"
              />
            </label>
          </div>
        </details>
      </section>
</template>
