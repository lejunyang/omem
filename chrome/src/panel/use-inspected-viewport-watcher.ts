import { onBeforeUnmount, onMounted } from "vue";
import type { DeviceViewportSnapshot } from "../shared/device-emulation-messages";

const DEVTOOLS_PANEL_PORT_NAME = "advanced-network-devtools-panel";
const VIEWPORT_POLL_INTERVAL_MS = 250;
const VIEWPORT_STABLE_NOTIFY_DELAY_MS = 350;

export interface UseInspectedViewportWatcherOptions {
  resolveTabId: () => number;
  isEnabled: () => boolean;
}

export function useInspectedViewportWatcher(options: UseInspectedViewportWatcherOptions): void {
  let port: chrome.runtime.Port | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSnapshot: DeviceViewportSnapshot | null = null;
  let reading = false;

  onMounted(() => {
    connectDevToolsPort();
    startPolling();
  });

  onBeforeUnmount(() => {
    stopPolling();
    disconnectDevToolsPort();
  });

  function connectDevToolsPort(): void {
    // runtime port 是 DevTools 面板生命周期信号；port 断开比 windows.onBoundsChanged 更接近“用户关闭 DevTools”。
    port = chrome.runtime.connect({ name: DEVTOOLS_PANEL_PORT_NAME });
    port.postMessage({
      type: "advanced-network:devtools-panel-connected",
      tabId: options.resolveTabId()
    });
  }

  function disconnectDevToolsPort(): void {
    port?.disconnect();
    port = null;
  }

  function startPolling(): void {
    // DevTools 分界线拖动不会触发 chrome.windows.onBoundsChanged，只能从 inspected page 的 viewport 快照变化推断。
    pollTimer = setInterval(() => {
      void readAndNotifyIfChanged();
    }, VIEWPORT_POLL_INTERVAL_MS);
    void readAndNotifyIfChanged();
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
  }

  async function readAndNotifyIfChanged(): Promise<void> {
    // 未开启模拟或面板不可见时不反复执行被检查页脚本，降低空闲开销。
    if (reading || !options.isEnabled() || document.hidden) {
      return;
    }
    reading = true;
    try {
      const snapshot = await readViewportSnapshot();
      if (!snapshot || snapshotsEqual(snapshot, lastSnapshot)) {
        return;
      }
      lastSnapshot = snapshot;
      scheduleStableNotification(snapshot);
    } finally {
      reading = false;
    }
  }

  function scheduleStableNotification(snapshot: DeviceViewportSnapshot): void {
    // 拖动 DevTools 分界线时 viewport 会连续变化，等待稳定后只通知一次，避免滚动/拖动过程中频繁重放导致闪烁。
    if (notifyTimer) {
      clearTimeout(notifyTimer);
    }
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      void chrome.runtime.sendMessage({
        type: "advanced-network:device-viewport-changed",
        tabId: options.resolveTabId(),
        viewport: snapshot
      }).catch(() => undefined);
    }, VIEWPORT_STABLE_NOTIFY_DELAY_MS);
  }

  function readViewportSnapshot(): Promise<DeviceViewportSnapshot | null> {
    // visualViewport 能更接近 Chrome 实际可视区域；不可用时退回 innerWidth/innerHeight。
    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval(
        `(() => {
          const visualViewport = window.visualViewport;
          return {
            innerWidth: Math.round(window.innerWidth),
            innerHeight: Math.round(window.innerHeight),
            visualWidth: Math.round(visualViewport?.width ?? window.innerWidth),
            visualHeight: Math.round(visualViewport?.height ?? window.innerHeight),
            visualScale: Number((visualViewport?.scale ?? 1).toFixed(3))
          };
        })()`,
        (result, exceptionInfo) => {
          if (exceptionInfo || !result || typeof result !== "object") {
            resolve(null);
            return;
          }
          const value = result as Partial<DeviceViewportSnapshot>;
          if (
            typeof value.innerWidth !== "number" ||
            typeof value.innerHeight !== "number" ||
            typeof value.visualWidth !== "number" ||
            typeof value.visualHeight !== "number" ||
            typeof value.visualScale !== "number"
          ) {
            resolve(null);
            return;
          }
          resolve({
            innerWidth: value.innerWidth,
            innerHeight: value.innerHeight,
            visualWidth: value.visualWidth,
            visualHeight: value.visualHeight,
            visualScale: value.visualScale
          });
        }
      );
    });
  }
}

function snapshotsEqual(next: DeviceViewportSnapshot, previous: DeviceViewportSnapshot | null): boolean {
  if (!previous) {
    return false;
  }
  return (
    next.innerWidth === previous.innerWidth &&
    next.innerHeight === previous.innerHeight &&
    next.visualWidth === previous.visualWidth &&
    next.visualHeight === previous.visualHeight &&
    next.visualScale === previous.visualScale
  );
}
