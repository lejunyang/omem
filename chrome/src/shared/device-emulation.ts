import { normalizeStoredList } from "./stored-list";

export const DEVICE_PROFILE_STORAGE_KEY = "advancedNetwork.deviceProfiles";

export type DeviceOrientation = "portrait" | "landscape";
export type DeviceScaleMode = "fixed" | "fit-window";
export type DeviceEmulationSource = "devtools" | "popup";

export interface DeviceProfile {
  id: string;
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
  platform: string;
  touchEnabled: boolean;
  maxTouchPoints: number;
  metricsAdvanced: DeviceMetricsAdvancedSettings;
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceMetricNumberOverride {
  enabled: boolean;
  value: number;
}

export interface DeviceMetricBooleanOverride {
  enabled: boolean;
  value: boolean;
}

export interface DeviceMetricViewportOverride {
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface DeviceMetricDisplayFeatureOverride {
  enabled: boolean;
  orientation: "vertical" | "horizontal";
  offset: number;
  maskLength: number;
}

export interface DeviceMetricsAdvancedSettings {
  scale: DeviceMetricNumberOverride;
  screenWidth: DeviceMetricNumberOverride;
  screenHeight: DeviceMetricNumberOverride;
  positionX: DeviceMetricNumberOverride;
  positionY: DeviceMetricNumberOverride;
  dontSetVisibleSize: DeviceMetricBooleanOverride;
  viewport: DeviceMetricViewportOverride;
  displayFeature: DeviceMetricDisplayFeatureOverride;
}

export interface DeviceEmulationSettings {
  enabled: boolean;
  profileId: string;
  orientation: DeviceOrientation;
  scaleMode: DeviceScaleMode;
  scale: number;
}

export interface DeviceEmulationState {
  tabId: number;
  settings: DeviceEmulationSettings;
  profile: DeviceProfile;
  appliedAt: number;
  source: DeviceEmulationSource;
}

export interface AvailableViewportSize {
  width: number;
  height: number;
}

export interface DeviceMetricsOverrideParams {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  scale: number;
  screenWidth?: number;
  screenHeight?: number;
  positionX?: number;
  positionY?: number;
  dontSetVisibleSize?: boolean;
  screenOrientation: {
    type: "portraitPrimary" | "landscapePrimary";
    angle: 0 | 90;
  };
  viewport?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  };
  displayFeature?: {
    orientation: "vertical" | "horizontal";
    offset: number;
    maskLength: number;
  };
}

export interface TouchEmulationParams {
  enabled: boolean;
  maxTouchPoints?: number;
}

export interface UserAgentOverrideParams {
  userAgent: string;
  platform: string;
}

const DEFAULT_MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DEFAULT_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const DEFAULT_TABLET_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export const DEFAULT_DEVICE_METRICS_ADVANCED_SETTINGS: DeviceMetricsAdvancedSettings = {
  scale: { enabled: false, value: 1 },
  screenWidth: { enabled: false, value: 0 },
  screenHeight: { enabled: false, value: 0 },
  positionX: { enabled: false, value: 0 },
  positionY: { enabled: false, value: 0 },
  dontSetVisibleSize: { enabled: false, value: false },
  viewport: { enabled: false, x: 0, y: 0, width: 0, height: 0, scale: 1 },
  displayFeature: { enabled: false, orientation: "vertical", offset: 0, maskLength: 0 }
};

export const DEFAULT_DEVICE_PROFILES: DeviceProfile[] = [
  createDeviceProfile({
    id: "iphone-15",
    name: "iPhone 15",
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: DEFAULT_MOBILE_UA,
    platform: "iPhone",
    touchEnabled: true,
    maxTouchPoints: 5,
    builtin: true,
    now: 1
  }),
  createDeviceProfile({
    id: "pixel-8",
    name: "Pixel 8",
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: DEFAULT_ANDROID_UA,
    platform: "Linux armv8l",
    touchEnabled: true,
    maxTouchPoints: 5,
    builtin: true,
    now: 1
  }),
  createDeviceProfile({
    id: "ipad",
    name: "iPad",
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: DEFAULT_TABLET_UA,
    platform: "iPad",
    touchEnabled: true,
    maxTouchPoints: 5,
    builtin: true,
    now: 1
  })
];

export const DEFAULT_DEVICE_EMULATION_SETTINGS: DeviceEmulationSettings = {
  enabled: false,
  profileId: DEFAULT_DEVICE_PROFILES[0].id,
  orientation: "portrait",
  scaleMode: "fit-window",
  scale: 1
};

// 创建设备配置时统一收口数值边界，避免 UI 或旧 storage 写入非法 CDP 参数。
export function createDeviceProfile(input: {
  id: string;
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
  platform: string;
  touchEnabled: boolean;
  maxTouchPoints: number;
  metricsAdvanced?: unknown;
  builtin?: boolean;
  now: number;
}): DeviceProfile {
  return {
    id: input.id,
    name: input.name,
    width: clampInteger(input.width, 1, 10000000),
    height: clampInteger(input.height, 1, 10000000),
    deviceScaleFactor: clampNumber(input.deviceScaleFactor, 0, 10),
    mobile: input.mobile,
    userAgent: input.userAgent,
    platform: input.platform,
    touchEnabled: input.touchEnabled,
    maxTouchPoints: clampInteger(input.maxTouchPoints, 0, 10),
    metricsAdvanced: normalizeDeviceMetricsAdvancedSettings(input.metricsAdvanced),
    builtin: input.builtin,
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function normalizeDeviceProfiles(value: unknown): DeviceProfile[] {
  // 设备列表需要兼容 chrome.storage 展示过的数字键对象，同时始终保留内置设备作为兜底入口。
  const stored = normalizeStoredList(value);
  const customProfiles = stored.map(normalizeDeviceProfile).filter((item): item is DeviceProfile => Boolean(item));
  const byId = new Map(DEFAULT_DEVICE_PROFILES.map((profile) => [profile.id, profile]));
  for (const profile of customProfiles) {
    byId.set(profile.id, profile);
  }
  return Array.from(byId.values());
}

export function normalizeDeviceProfile(value: unknown): DeviceProfile | null {
  // 单条设备配置只接受具备稳定 id/name 的对象；坏数据直接跳过，避免影响整个面板初始化。
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<DeviceProfile>;
  const id = normalizeString(candidate.id);
  const name = normalizeString(candidate.name);
  if (!id || !name) {
    return null;
  }

  const now = Date.now();
  return {
    id,
    name,
    width: clampInteger(candidate.width, 1, 10000000),
    height: clampInteger(candidate.height, 1, 10000000),
    deviceScaleFactor: clampNumber(candidate.deviceScaleFactor, 0, 10),
    mobile: candidate.mobile === true,
    userAgent: normalizeString(candidate.userAgent),
    platform: normalizeString(candidate.platform),
    touchEnabled: candidate.touchEnabled === true,
    maxTouchPoints: clampInteger(candidate.maxTouchPoints, 0, 10),
    metricsAdvanced: normalizeDeviceMetricsAdvancedSettings(candidate.metricsAdvanced),
    builtin: candidate.builtin === true,
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : now
  };
}

export function normalizeDeviceEmulationSettings(value: unknown): DeviceEmulationSettings {
  // 运行态设置来自 UI 和 background 消息，归一化后再下发 CDP，避免方向、缩放等非法值触发 debugger 错误。
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_DEVICE_EMULATION_SETTINGS };
  }
  const candidate = value as Partial<DeviceEmulationSettings>;
  return {
    enabled: candidate.enabled === true,
    profileId: normalizeString(candidate.profileId) || DEFAULT_DEVICE_EMULATION_SETTINGS.profileId,
    orientation: candidate.orientation === "landscape" ? "landscape" : "portrait",
    scaleMode: candidate.scaleMode === "fixed" ? "fixed" : "fit-window",
    scale: clampNumber(candidate.scale, 0.1, 5)
  };
}

export function normalizeDeviceMetricsAdvancedSettings(value: unknown): DeviceMetricsAdvancedSettings {
  // CDP 高级参数全部默认关闭，避免存在默认数值时误传实验字段导致页面高度、滚动和 compositor 状态异常。
  const candidate = value && typeof value === "object" ? (value as Partial<DeviceMetricsAdvancedSettings>) : {};
  return {
    scale: normalizeNumberOverride(candidate.scale, 0.1, 5, DEFAULT_DEVICE_METRICS_ADVANCED_SETTINGS.scale.value),
    screenWidth: normalizeIntegerOverride(
      candidate.screenWidth,
      0,
      10000000,
      DEFAULT_DEVICE_METRICS_ADVANCED_SETTINGS.screenWidth.value
    ),
    screenHeight: normalizeIntegerOverride(
      candidate.screenHeight,
      0,
      10000000,
      DEFAULT_DEVICE_METRICS_ADVANCED_SETTINGS.screenHeight.value
    ),
    positionX: normalizeIntegerOverride(
      candidate.positionX,
      0,
      10000000,
      DEFAULT_DEVICE_METRICS_ADVANCED_SETTINGS.positionX.value
    ),
    positionY: normalizeIntegerOverride(
      candidate.positionY,
      0,
      10000000,
      DEFAULT_DEVICE_METRICS_ADVANCED_SETTINGS.positionY.value
    ),
    dontSetVisibleSize: normalizeBooleanOverride(
      candidate.dontSetVisibleSize,
      DEFAULT_DEVICE_METRICS_ADVANCED_SETTINGS.dontSetVisibleSize.value
    ),
    viewport: normalizeViewportOverride(candidate.viewport),
    displayFeature: normalizeDisplayFeatureOverride(candidate.displayFeature)
  };
}

export function getOrCreateSelectedDeviceProfile(profiles: DeviceProfile[], profileId: string): DeviceProfile {
  // 选中的设备可能已被用户删除，必须回退到现存首项，保证启用模拟时始终有可用 profile。
  return profiles.find((profile) => profile.id === profileId) ?? profiles[0] ?? DEFAULT_DEVICE_PROFILES[0];
}

export function getOrientedDeviceSize(
  profile: Pick<DeviceProfile, "width" | "height">,
  orientation: DeviceOrientation
): AvailableViewportSize {
  // CDP 的 width/height 表示当前方向下的视口尺寸，横屏需要交换用户配置的自然宽高。
  return orientation === "landscape"
    ? { width: profile.height, height: profile.width }
    : { width: profile.width, height: profile.height };
}

// 自适应窗口不是 CDP 独立开关，必须由扩展侧根据可用区域计算 scale，再重放 setDeviceMetricsOverride。
export function calculateDeviceScale(input: {
  mode: DeviceScaleMode;
  fixedScale: number;
  deviceSize: AvailableViewportSize;
  availableSize?: AvailableViewportSize;
}): number {
  if (input.mode === "fixed" || !input.availableSize) {
    return clampNumber(input.fixedScale, 0.1, 5);
  }
  const widthRatio = input.availableSize.width / input.deviceSize.width;
  const heightRatio = input.availableSize.height / input.deviceSize.height;
  return clampNumber(Math.min(widthRatio, heightRatio, 1), 0.1, 1);
}

export function toDeviceMetricsOverrideParams(input: {
  profile: DeviceProfile;
  settings: DeviceEmulationSettings;
  availableSize?: AvailableViewportSize;
}): DeviceMetricsOverrideParams {
  // 将产品模型转换为真实 tab 的 CDP Emulation 参数；高级参数仅在用户显式启用时下发，避免实验字段默认影响滚动和渲染区域。
  const deviceSize = getOrientedDeviceSize(input.profile, input.settings.orientation);
  const params: DeviceMetricsOverrideParams = {
    width: deviceSize.width,
    height: deviceSize.height,
    deviceScaleFactor: input.profile.deviceScaleFactor,
    mobile: input.profile.mobile,
    scale: input.profile.metricsAdvanced.scale.enabled ? input.profile.metricsAdvanced.scale.value : 1,
    screenOrientation:
      input.settings.orientation === "landscape"
        ? { type: "landscapePrimary", angle: 90 }
        : { type: "portraitPrimary", angle: 0 }
  };

  const advanced = input.profile.metricsAdvanced;
  if (advanced.screenWidth.enabled) {
    params.screenWidth = advanced.screenWidth.value;
  }
  if (advanced.screenHeight.enabled) {
    params.screenHeight = advanced.screenHeight.value;
  }
  if (advanced.positionX.enabled) {
    params.positionX = advanced.positionX.value;
  }
  if (advanced.positionY.enabled) {
    params.positionY = advanced.positionY.value;
  }
  if (advanced.dontSetVisibleSize.enabled) {
    params.dontSetVisibleSize = advanced.dontSetVisibleSize.value;
  }
  if (advanced.viewport.enabled) {
    params.viewport = {
      x: advanced.viewport.x,
      y: advanced.viewport.y,
      width: advanced.viewport.width,
      height: advanced.viewport.height,
      scale: advanced.viewport.scale
    };
  }
  if (advanced.displayFeature.enabled) {
    params.displayFeature = {
      orientation: advanced.displayFeature.orientation,
      offset: advanced.displayFeature.offset,
      maskLength: advanced.displayFeature.maskLength
    };
  }
  return params;
}

export function toTouchEmulationParams(profile: DeviceProfile): TouchEmulationParams {
  // 触摸点数为 0 表示产品层关闭 touch，而不是启用 0 个触点。
  if (!profile.touchEnabled || profile.maxTouchPoints <= 0) {
    return { enabled: false };
  }
  return {
    enabled: true,
    maxTouchPoints: profile.maxTouchPoints
  };
}

export function toUserAgentOverrideParams(profile: DeviceProfile): UserAgentOverrideParams {
  // UA 覆盖独立于 viewport/touch，便于关闭模拟时分别清理可恢复和需刷新恢复的能力。
  return {
    userAgent: profile.userAgent,
    platform: profile.platform
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumberOverride(
  value: unknown,
  min: number,
  max: number,
  defaultValue: number
): DeviceMetricNumberOverride {
  const candidate = value && typeof value === "object" ? (value as Partial<DeviceMetricNumberOverride>) : {};
  return {
    enabled: candidate.enabled === true,
    value: clampNumber(candidate.value, min, max) || defaultValue
  };
}

function normalizeIntegerOverride(
  value: unknown,
  min: number,
  max: number,
  defaultValue: number
): DeviceMetricNumberOverride {
  const candidate = value && typeof value === "object" ? (value as Partial<DeviceMetricNumberOverride>) : {};
  return {
    enabled: candidate.enabled === true,
    value: clampInteger(candidate.value, min, max) || defaultValue
  };
}

function normalizeBooleanOverride(value: unknown, defaultValue: boolean): DeviceMetricBooleanOverride {
  const candidate = value && typeof value === "object" ? (value as Partial<DeviceMetricBooleanOverride>) : {};
  return {
    enabled: candidate.enabled === true,
    value: typeof candidate.value === "boolean" ? candidate.value : defaultValue
  };
}

function normalizeViewportOverride(value: unknown): DeviceMetricViewportOverride {
  const candidate = value && typeof value === "object" ? (value as Partial<DeviceMetricViewportOverride>) : {};
  return {
    enabled: candidate.enabled === true,
    x: clampNumber(candidate.x, 0, 10000000),
    y: clampNumber(candidate.y, 0, 10000000),
    width: clampNumber(candidate.width, 0, 10000000),
    height: clampNumber(candidate.height, 0, 10000000),
    scale: typeof candidate.scale === "number" ? clampNumber(candidate.scale, 0.1, 5) : 1
  };
}

function normalizeDisplayFeatureOverride(value: unknown): DeviceMetricDisplayFeatureOverride {
  const candidate = value && typeof value === "object" ? (value as Partial<DeviceMetricDisplayFeatureOverride>) : {};
  return {
    enabled: candidate.enabled === true,
    orientation: candidate.orientation === "horizontal" ? "horizontal" : "vertical",
    offset: clampInteger(candidate.offset, 0, 10000000),
    maskLength: clampInteger(candidate.maskLength, 0, 10000000)
  };
}

function clampInteger(value: unknown, min: number, max: number): number {
  const numeric = Math.round(typeof value === "number" && Number.isFinite(value) ? value : min);
  return Math.min(max, Math.max(min, numeric));
}

function clampNumber(value: unknown, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, numeric));
}
