// 拾取界面的样式，放进 Shadow DOM。颜色与扩展其他界面一致（omem 的 token），不跟随页面主题，保证在任何页面上都看得清。
export const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer, .layer * { pointer-events: none; }
.layer > div, .layer > span { position: fixed; }
.box-margin { background: rgba(246, 178, 107, 0.28); }
.box-padding { background: rgba(147, 196, 125, 0.32); outline: 1px solid rgba(47, 91, 211, 0.9); }
.box-content { background: rgba(111, 168, 220, 0.38); }
.primary { outline: 2px solid #2f5bd3; outline-offset: 0; background: rgba(47, 91, 211, 0.08); }
.secondary { outline: 1.5px dashed #b4322e; background: rgba(180, 50, 46, 0.06); }
.region { outline: 2px solid #2f5bd3; background: rgba(47, 91, 211, 0.08); box-shadow: 0 0 0 100vmax rgba(20, 22, 26, 0.28); }
.label {
  padding: 2px 6px; border-radius: 4px; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis;
  font: 500 11px/16px Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: #fff;
}
.label.accent { background: #2f5bd3; }
.label.muted { background: #b4322e; min-width: 18px; text-align: center; }
.label.dark { background: rgba(31, 35, 40, 0.88); }
.measure { position: fixed; background: #e5484d; }
.measure.h { height: 1px; }
.measure.v { width: 1px; }
.measure.h::before, .measure.h::after { content: ""; position: absolute; top: -4px; width: 1px; height: 9px; background: #e5484d; }
.measure.h::before { left: 0; } .measure.h::after { right: 0; }
.measure.v::before, .measure.v::after { content: ""; position: absolute; left: -4px; height: 1px; width: 9px; background: #e5484d; }
.measure.v::before { top: 0; } .measure.v::after { bottom: 0; }
.measure.transient { opacity: 0.75; }
.measure-tag {
  position: fixed; transform: translate(-50%, -50%); padding: 0 5px; border-radius: 4px; background: #e5484d; color: #fff;
  font: 600 11px/16px Inter, system-ui, sans-serif;
}

.region-catcher { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; }
.region-catcher[hidden] { display: none; }

.toolbar, .card, .toast {
  pointer-events: auto; position: fixed; color: #1f2328; background: #ffffff; border: 1px solid #e4e1da;
  box-shadow: 0 1px 2px rgba(20, 20, 20, 0.04), 0 8px 28px rgba(20, 20, 20, 0.14);
  font: 13px/1.5 Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
}
.toolbar {
  top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  padding: 6px; border-radius: 12px; white-space: nowrap; max-width: calc(100vw - 24px);
}
.toolbar[hidden], .card[hidden], .toast[hidden] { display: none; }
button {
  all: unset; box-sizing: border-box; cursor: pointer; height: 28px; padding: 0 10px; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px; font: inherit; color: inherit;
}
button:hover { background: rgba(31, 35, 40, 0.06); }
button:focus-visible { outline: 2px solid #2f5bd3; outline-offset: 1px; }
button:disabled { opacity: 0.4; cursor: default; background: none; }
button.primary { background: #1f2328; color: #fff; }
button.primary:hover:not(:disabled) { opacity: 0.88; }
button.icon { width: 28px; padding: 0; color: #7a7f88; }
button.icon.small { width: 20px; height: 20px; font-size: 11px; }
.seg { display: inline-flex; padding: 2px; border-radius: 9px; background: #f0eee9; }
.seg button { height: 26px; color: #4b5059; }
.seg button.on { background: #fff; color: #1f2328; box-shadow: 0 1px 2px rgba(20, 20, 20, 0.08); font-weight: 600; }
.check { display: inline-flex; align-items: center; gap: 4px; color: #4b5059; cursor: pointer; user-select: none; }
.check input { accent-color: #2f5bd3; margin: 0; }
.hint { color: #7a7f88; font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

.card {
  top: 64px; right: 12px; width: 300px; max-height: calc(100vh - 80px); overflow: auto; border-radius: 12px; padding: 12px 14px;
}
.card.left { right: auto; left: 12px; }
.card header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.card header code { font: 600 12px/1.4 "JetBrains Mono", "SF Mono", Consolas, monospace; color: #2f5bd3; word-break: break-all; }
.card header span { color: #7a7f88; font-size: 12px; flex-shrink: 0; }
.card .text { margin: 0 0 8px; color: #4b5059; font-size: 12px; }
.card section { border-top: 1px solid #efede8; padding: 8px 0 2px; }
.card h4 { margin: 0 0 4px; font-size: 11px; font-weight: 600; color: #7a7f88; letter-spacing: 0.04em; }
.card dl { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 3px 8px; margin: 0; font-size: 12px; }
.card dt { color: #7a7f88; }
.card dd { margin: 0; display: flex; align-items: center; gap: 6px; min-width: 0; word-break: break-all; font-family: "JetBrains Mono", "SF Mono", Consolas, monospace; font-size: 11.5px; }
.swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12); }
.spacing { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 12px; }
.spacing li { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto 20px; align-items: center; gap: 6px; }
.spacing b { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; background: #b4322e; color: #fff; font-size: 11px; }
.spacing code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.spacing span { color: #e5484d; font-weight: 600; }
.card .tip { margin: 8px 0 0; color: #7a7f88; font-size: 12px; }
.card footer { display: flex; justify-content: flex-end; margin-top: 8px; }
.card footer button { border: 1px solid #e4e1da; height: 26px; font-size: 12px; }

.toast { right: 16px; bottom: 16px; display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border-radius: 10px; }
.toast.ok span::before { content: "✓ "; color: #2c7a4b; font-weight: 700; }
.toast.error { color: #b4322e; padding-right: 14px; }
.toast button { height: 26px; color: #2f5bd3; font-weight: 600; }
`;
