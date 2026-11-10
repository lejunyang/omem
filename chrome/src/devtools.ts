chrome.devtools.panels.create(
  "高级网络",
  "icons/panel.svg",
  "panel.html",
  () => {
    // Panel creation is intentionally side-effect free; panel.ts owns network capture.
  }
);
