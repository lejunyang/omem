import { installRecordingBridge } from "./panel/recording-bridge";

chrome.devtools.panels.create(
  "高级网络",
  "icons/panel.svg",
  "panel.html",
  () => {
    // Panel creation is intentionally side-effect free; panel.ts owns network capture.
  }
);

// 录制（侧栏）进行中、DevTools 开着这个标签页时，补上请求体和响应体。
installRecordingBridge();
