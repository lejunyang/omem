export interface SimulatorEnvironment {
  width: number;
  height: number;
  deviceScaleFactor: number;
  touchEnabled: boolean;
  maxTouchPoints: number;
  landscape: boolean;
}

// 该函数由 CDP 放到业务 iframe 的 MAIN world，必须自包含，不能依赖扩展的模块闭包。
// 属性和单指事件模拟不是浏览器引擎模拟：CSS resolution、isTrusted 和 Safari 行为仍以真实浏览器为准。
export function installSimulatorEnvironment(config: SimulatorEnvironment): void {
  const marker = "__advancedNetworkSimulatorEnvironment";
  if (Object.prototype.hasOwnProperty.call(window, marker)) return;
  Object.defineProperty(window, marker, { value: true });
  const override = (object: object, key: string, value: unknown) => {
    try { Object.defineProperty(object, key, { configurable: true, get: () => value }); } catch { /* 浏览器不可配置属性保留原值。 */ }
  };
  if (config.deviceScaleFactor > 0) override(window, "devicePixelRatio", config.deviceScaleFactor);
  for (const key of ["width", "availWidth"]) override(screen, key, config.width);
  for (const key of ["height", "availHeight"]) override(screen, key, config.height);
  override(screen.orientation, "type", config.landscape ? "landscape-primary" : "portrait-primary");
  override(screen.orientation, "angle", config.landscape ? 90 : 0);
  override(window, "orientation", config.landscape ? 90 : 0);
  const enabled = config.touchEnabled && config.maxTouchPoints > 0;
  override(navigator, "maxTouchPoints", enabled ? config.maxTouchPoints : 0);
  if (!enabled) return;
  // 常见触摸探测同时检查事件处理器属性；保留业务后续赋值能力。
  for (const name of ["ontouchstart", "ontouchmove", "ontouchend", "ontouchcancel"]) {
    if (!(name in window)) Object.defineProperty(window, name, { configurable: true, writable: true, value: null });
  }

  let active: { target: Element; x: number; y: number; lastX: number; lastY: number; moved: boolean; canceled: boolean } | null = null;
  let suppressClick = false;

  // 只转换鼠标单指交互；真实触摸输入交由浏览器处理，避免双重派发。
  const dispatch = (type: string, event: PointerEvent) => {
    if (!active) return true;
    const point = new Touch({ identifier: 1, target: active.target, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY, pageX: event.pageX, pageY: event.pageY, radiusX: 1, radiusY: 1, force: .5 });
    const ended = type === "touchend" || type === "touchcancel";
    return active.target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: ended ? [] : [point], targetTouches: ended ? [] : [point], changedTouches: [point] }));
  };

  // 手指拖动优先滚动最近可滚动容器；touchmove 被业务 preventDefault 时由业务接管。
  const scroll = (element: Element, dx: number, dy: number) => {
    let current: Element | null = element;
    while (current) {
      const style = getComputedStyle(current);
      const canY = /auto|scroll/.test(style.overflowY) && current.scrollHeight > current.clientHeight;
      const canX = /auto|scroll/.test(style.overflowX) && current.scrollWidth > current.clientWidth;
      if (canX || canY) {
        const x = current.scrollLeft, y = current.scrollTop;
        current.scrollBy(canX ? dx : 0, canY ? dy : 0);
        if (current.scrollTop !== y || current.scrollLeft !== x) return;
      }
      current = current.parentElement;
    }
    window.scrollBy(dx, dy);
  };
  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || !(event.target instanceof Element)) return;
    suppressClick = false;
    active = { target: event.target, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, canceled: false };
    active.canceled = !dispatch("touchstart", event);
    try { event.target.setPointerCapture(event.pointerId); } catch { /* 元素可能被业务 touchstart 处理器移除。 */ }
    // 保留原生 focus/文本选择；只有业务显式阻止 touchstart 时才阻止鼠标默认行为。
    if (active.canceled) event.preventDefault();
  }, true);
  document.addEventListener("pointermove", (event) => {
    if (!active || event.pointerType !== "mouse") return;
    active.moved ||= Math.hypot(event.clientX - active.x, event.clientY - active.y) > 5;
    const accepted = dispatch("touchmove", event);
    if (active.moved && accepted && !active.canceled) scroll(active.target, active.lastX - event.clientX, active.lastY - event.clientY);
    active.lastX = event.clientX; active.lastY = event.clientY;
    if (active.moved || !accepted) event.preventDefault();
  }, { capture: true, passive: false });
  document.addEventListener("pointerup", (event) => {
    if (!active || event.pointerType !== "mouse") return;
    const accepted = dispatch("touchend", event);
    suppressClick = active.moved || active.canceled || !accepted;
    active = null;
  }, true);
  document.addEventListener("pointercancel", (event) => { dispatch("touchcancel", event); active = null; }, true);
  document.addEventListener("click", (event) => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener("blur", () => {
    if (active) dispatch("touchcancel", new PointerEvent("pointercancel", { clientX: active.lastX, clientY: active.lastY }));
    active = null;
  });
}
