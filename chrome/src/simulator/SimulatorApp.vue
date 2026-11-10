<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { DEFAULT_DEVICE_PROFILES, getOrientedDeviceSize, type DeviceOrientation } from "../shared/device-emulation";
import { normalizeSimulatorUrl, simulatorFrameName } from "../shared/device-simulator";
import { loadDeviceProfilesFromStorage } from "../panel/persistent-state";

const query = new URLSearchParams(location.search);
const profiles = ref(DEFAULT_DEVICE_PROFILES);
const selectedId = ref(query.get("profile") || profiles.value[0].id);
const orientation = ref<DeviceOrientation>("portrait");
const address = ref(query.get("url") || "");
const frameUrl = ref("");
const frameKey = ref(0);
const error = ref("");
const ready = ref(false);
const busy = ref(false);
const touch = ref(true);
const width = ref(393);
const height = ref(852);
const dpr = ref(3);
const maxTouchPoints = ref(5);
const userAgent = ref("");
const platform = ref("");
const zoom = ref("fit");
// 不用 CDP 时（mode = "dnr"）：UA 请求头由 DNR 规则改，环境脚本靠 frame 名带参数、由已授权站点的内容脚本安装。
const frameName = ref(simulatorFrameName(null));
const missingOrigin = ref("");
const stage = ref<HTMLElement>();
const available = ref({ width: 800, height: 800 });
const applied = ref({ width: 393, height: 852, orientation: "portrait" as DeviceOrientation, touch: true });
const size = computed(() => getOrientedDeviceSize(applied.value, applied.value.orientation));
const scale = computed(() => zoom.value === "fit"
  ? Math.max(0.05, Math.min(1, (available.value.width - 72) / size.value.width, (available.value.height - 96) / size.value.height))
  : Number(zoom.value));
let observer: ResizeObserver | undefined;
let currentTabId: number | undefined;
let operations = Promise.resolve();
let applyRevision = 0;

// 外框缩放只影响视觉尺寸；iframe 的 CSS 视口宽高始终保持用户设定，不代理键盘或文本输入。
function selectProfile() {
  const profile = profiles.value.find((item) => item.id === selectedId.value) ?? profiles.value[0];
  width.value = profile.width; height.value = profile.height; dpr.value = profile.deviceScaleFactor;
  touch.value = profile.touchEnabled; maxTouchPoints.value = profile.maxTouchPoints;
  userAgent.value = profile.userAgent; platform.value = profile.platform;
}

// 先应用 UA / DPR / touch 再创建 iframe，首个文档请求也要携带正确 UA。改变参数会重载内页。
function apply() {
  const revision = ++applyRevision;
  const snapshot = {
    ...profiles.value.find((item) => item.id === selectedId.value)!,
    width: Math.round(Math.min(10000, Math.max(1, width.value || 393))),
    height: Math.round(Math.min(10000, Math.max(1, height.value || 852))),
    deviceScaleFactor: Math.min(10, Math.max(0, dpr.value || 0)),
    touchEnabled: touch.value, maxTouchPoints: Math.round(Math.min(10, Math.max(0, maxTouchPoints.value || 0))),
    userAgent: userAgent.value, platform: platform.value
  };
  width.value = snapshot.width; height.value = snapshot.height;
  const direction = orientation.value;
  const nextAddress = address.value;
  busy.value = true;
  operations = operations.catch(() => undefined).then(async () => {
    error.value = "";
    try {
      const url = normalizeSimulatorUrl(nextAddress);
      const response = await chrome.runtime.sendMessage({ type: "advanced-network:configure-simulator", profile: snapshot, orientation: direction });
      if (!response?.ok) throw new Error([response?.error, response?.recoveryHint].filter(Boolean).join(" ") || "无法连接浏览器调试接口。");
      if (revision !== applyRevision) return;
      applied.value = { width: snapshot.width, height: snapshot.height, orientation: direction, touch: snapshot.touchEnabled && snapshot.maxTouchPoints > 0 };
      const oriented = getOrientedDeviceSize(snapshot, direction);
      frameName.value = response.mode === "dnr"
        ? simulatorFrameName({
            environment: { ...oriented, deviceScaleFactor: snapshot.deviceScaleFactor, touchEnabled: snapshot.touchEnabled, maxTouchPoints: snapshot.maxTouchPoints, landscape: direction === "landscape" },
            userAgent: snapshot.userAgent,
            platform: snapshot.platform
          })
        : simulatorFrameName(null);
      const origin = `${new URL(url).origin}/*`;
      missingOrigin.value = response.mode === "dnr" && !(await chrome.permissions.contains({ origins: [origin] })) ? origin : "";
      frameUrl.value = url;
      frameKey.value += 1;
      ready.value = true;
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    } finally { if (revision === applyRevision) busy.value = false; }
  });
  return operations;
}

// 跨域 frame 无法读取当前位置，明确重新载入地址栏地址，不冒充页面内后退/刷新。
function reloadFrame() { frameKey.value += 1; }

// 授权必须由点击触发；授权后重新载入，DNR 改 UA 和环境脚本才会生效。
async function grantOrigin() {
  if (!missingOrigin.value) return;
  if (await chrome.permissions.request({ origins: [missingOrigin.value] }).catch(() => false)) {
    missingOrigin.value = "";
    reloadFrame();
  }
}

async function openOriginal() {
  try { await chrome.tabs.create({ url: normalizeSimulatorUrl(address.value) }); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}

// 子进程配置失败或用户取消调试连接时显示实际错误，不把画布存在视作模拟仍然有效。
function handleRuntimeMessage(message: { type?: string; tabId?: number; error?: string }) {
  if (message.type === "advanced-network:simulator-error" && message.tabId === currentTabId) error.value = message.error || "模拟器连接失败。";
}

onMounted(async () => {
  currentTabId = (await chrome.tabs.getCurrent())?.id;
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  profiles.value = await loadDeviceProfilesFromStorage();
  if (!profiles.value.some((profile) => profile.id === selectedId.value)) selectedId.value = profiles.value[0].id;
  selectProfile();
  observer = new ResizeObserver(([entry]) => { available.value = { width: entry.contentRect.width, height: entry.contentRect.height }; });
  if (stage.value) observer.observe(stage.value);
  await apply();
});
onBeforeUnmount(() => { observer?.disconnect(); chrome.runtime.onMessage.removeListener(handleRuntimeMessage); });
</script>

<template>
  <main class="simulator-app">
    <header class="simulator-header">
      <div class="simulator-brand"><span class="brand-mark">o</span><div><strong>设备模拟器</strong><small>omem 助手 / 响应式画布</small></div></div>
      <form class="simulator-address" @submit.prevent="apply">
        <input v-model="address" aria-label="网页地址" placeholder="https://example.com" />
        <button class="button" :disabled="busy">前往</button>
      </form>
      <button class="button" type="button" @click="openOriginal">在普通标签页打开</button>
    </header>
    <aside class="simulator-settings">
      <div class="simulator-section-title">设备与显示 <span>01</span></div>
      <label class="device-field"><span>设备预设</span><select v-model="selectedId" data-testid="simulator-profile" class="preset-select" @change="selectProfile"><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option></select></label>
      <div class="device-two-columns">
        <label class="device-field"><span>宽度 · px</span><input v-model.number="width" data-testid="simulator-width" class="filter-input" type="number" min="1" max="10000" /></label>
        <label class="device-field"><span>高度 · px</span><input v-model.number="height" data-testid="simulator-height" class="filter-input" type="number" min="1" max="10000" /></label>
      </div>
      <label class="device-field"><span>像素比标识 · DPR</span><input v-model.number="dpr" class="filter-input" type="number" min="0" max="10" step="0.1" /></label>
      <div class="device-emulation-actions">
        <button class="button" :class="{ 'is-active': orientation === 'portrait' }" @click="orientation = 'portrait'">竖屏</button>
        <button class="button" data-testid="simulator-landscape" :class="{ 'is-active': orientation === 'landscape' }" @click="orientation = 'landscape'">横屏</button>
      </div>
      <label class="device-field"><span>画布缩放</span><select v-model="zoom" class="preset-select"><option value="fit">适应窗口</option><option value="1">100%</option><option value="0.75">75%</option><option value="0.5">50%</option></select></label>
      <div class="simulator-section-title">输入与身份 <span>02</span></div>
      <label class="toolbar-check"><input v-model="touch" data-testid="simulator-touch" type="checkbox" />模拟单指触摸</label>
      <p class="device-emulation-note">鼠标点击与拖动转为触摸事件；不改变 CSS pointer / hover 媒体查询。</p>
      <label class="device-field"><span>最大触摸点数</span><input v-model.number="maxTouchPoints" class="filter-input" type="number" min="0" max="10" /></label>
      <details class="simulator-identity"><summary>浏览器身份</summary>
        <label class="device-field"><span>User-Agent</span><textarea v-model="userAgent" class="filter-input device-user-agent" /></label>
        <label class="device-field"><span>Platform</span><input v-model="platform" class="filter-input" /></label>
      </details>
      <button class="button button-primary" data-testid="simulator-apply" :disabled="busy" @click="apply">{{ busy ? "正在应用…" : "应用并载入" }}</button>
      <p class="device-emulation-note">参数应用后会重新载入地址栏网页。设备预设可在扩展的「设备模拟」中保存。</p>
      <details class="simulator-boundaries"><summary>兼容性说明</summary><p>此画布使用真实 iframe，支持清晰渲染、键盘和响应式布局。DPR、screen 与方向是页面属性模拟；CSS 分辨率、pointer/hover 媒体查询仍由桌面浏览器决定。触摸为鼠标转换的单指事件（非可信硬件事件），支持拖动滚动。需要原生触摸、viewport meta、文本自动放大或多点手势时，请用原页面模拟。</p><p>只对本模拟器的内页放开嵌入限制，其余 CSP 保留。登录、第三方 Cookie、支付跳转及拒绝嵌入的网站可能不兼容。UA 不会切换为 Safari 引擎。</p></details>
    </aside>
    <section ref="stage" class="simulator-stage" aria-label="居中设备画布">
      <div v-if="error" class="simulator-error" role="alert">{{ error }}</div>
      <div v-if="missingOrigin && !error" class="simulator-error simulator-permission">
        <span>未开启 CDP 增强：要让内页拿到模拟的 UA、屏幕尺寸和触摸，需要授权访问这个站点。</span>
        <button class="button" type="button" @click="grantOrigin">授权并重新载入</button>
      </div>
      <div v-if="ready" class="simulator-device-space" :style="{ width: `${size.width * scale}px`, height: `${size.height * scale}px` }">
        <div class="simulator-device" :style="{ width: `${size.width}px`, height: `${size.height}px`, transform: `scale(${scale})` }">
          <!-- 禁止业务 frame 顶层导航劫持外壳；允许正常脚本、表单、下载与独立打开窗口。 -->
          <iframe :key="frameKey" :name="frameName" :src="frameUrl" title="模拟网页" data-testid="simulator-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads" />
        </div>
        <div class="simulator-caption">{{ size.width }} × {{ size.height }} · {{ Math.round(scale * 100) }}% · {{ applied.touch ? "Touch" : "Mouse" }}</div>
      </div>
      <div v-else-if="!error" class="simulator-loading">正在准备设备…</div>
    </section>
    <footer class="simulator-footer"><span>真实网页 · 独立标签页 · 原页面保留</span><button class="button" @click="reloadFrame">重新载入地址栏网页</button><span>页面空白？检查地址，或在普通标签页打开。</span></footer>
  </main>
</template>
