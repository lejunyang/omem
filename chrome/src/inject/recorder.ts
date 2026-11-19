// 录制：页面里的记录脚本。ISOLATED world 内容脚本，由后台在被录的标签页里按需注入（每次页面加载完再注一次，幂等）。
// 只看本人的操作（点击、填写、提交、按 Enter），把元素的名字、角色、路径、所在区块发给后台；不改页面。
// 「指出元素」时在 Shadow DOM 里画一个高亮框，本人点一下就记下那个元素（这一下不传给页面），Esc 取消。
// 只在顶层页面里记：iframe 里的操作不记（后台注入时没有 allFrames）。
import { clipText, cssPath, type ElementLike } from "../shared/element-context";
import { isSensitiveField, type StepAction, VALUE_LIMIT } from "../shared/recording";
import { nearestHeading } from "./dom-context";

interface RecorderApi {
  start(): void;
  stop(): void;
  point(): void;
}

declare global {
  interface Window {
    __omemRecorder?: RecorderApi;
  }
}

if (!window.__omemRecorder) window.__omemRecorder = createRecorder();

const CLICKABLE = 'button,a,input,select,textarea,summary,label,[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"],[tabindex]';
const ROLE_BY_TAG: Record<string, string> = { BUTTON: "button", A: "link", TEXTAREA: "textbox", SELECT: "combobox", IMG: "img", SUMMARY: "button", DIALOG: "dialog", OUTPUT: "status" };
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "tel", "url", "number", "password", "date", "datetime-local", "month", "week", "time"]);

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : ["button", "submit", "reset"].includes(type) ? "button" : "textbox";
  }
  if ((el as HTMLElement).isContentEditable) return "textbox";
  return ROLE_BY_TAG[el.tagName] ?? el.tagName.toLowerCase();
}

/** 元素的名字，和 aad 的录制脚本取法相同：aria-label、关联的 label、title、placeholder；输入框用 id，其他用文字。 */
function labelOf(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  const byIds = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
  const labels = "labels" in el ? Array.from((el as HTMLInputElement).labels ?? []).map((label) => label.innerText || label.textContent || "").join(" ") : "";
  const isField = ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
  const text = isField ? el.id || el.getAttribute("name") || "" : (el as HTMLElement).innerText || el.textContent || "";
  const value = el.getAttribute("aria-label") || byIds || labels || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || (el.tagName === "INPUT" && ["button", "submit"].includes((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : "") || text;
  return clipText(value, 120).value;
}

function isTextEntry(el: Element): boolean {
  if (el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable) return true;
  return el.tagName === "INPUT" && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}

function sensitive(el: Element): boolean {
  const input = el as HTMLInputElement;
  return isSensitiveField({ type: input.type ?? null, autocomplete: el.getAttribute("autocomplete"), name: el.getAttribute("name"), id: el.id, label: labelOf(el), placeholder: el.getAttribute("placeholder") });
}

/** 发给后台的元素描述。 */
function describe(el: Element, kind: StepAction["kind"]): StepAction {
  return {
    kind,
    label: labelOf(el),
    role: roleOf(el),
    tag: (el as HTMLElement).isContentEditable ? "contenteditable" : el.tagName.toLowerCase(),
    type: (el as HTMLInputElement).type || undefined,
    selector: cssPath(el as unknown as ElementLike),
    heading: nearestHeading(el),
    text: clipText(el instanceof HTMLElement ? el.innerText : el.textContent ?? "", 160).value || undefined,
    url: location.href,
    title: document.title
  };
}

function fieldValue(el: Element): string {
  if (el.tagName === "SELECT") {
    const select = el as HTMLSelectElement;
    return Array.from(select.selectedOptions).map((option) => option.label || option.text).join("、");
  }
  if ((el as HTMLElement).isContentEditable) return (el as HTMLElement).innerText || el.textContent || "";
  return String((el as HTMLInputElement).value ?? "");
}

function send(event: StepAction): void {
  void chrome.runtime.sendMessage({ type: "omem-record:event", event: { ...event, at: Date.now() } }).catch(() => undefined);
}

function createRecorder(): RecorderApi {
  let active = false;
  let pointing = false;
  // 打字时每个字都会触发 input：同一个输入框停下 700 毫秒或离开时才发一次（后台再把连续的合成一步）。
  const pendingInputs = new Map<Element, number>();
  let host: HTMLElement | null = null;
  let box: HTMLDivElement | null = null;
  let hint: HTMLDivElement | null = null;

  const pathOf = (event: Event) => (event.composedPath?.()[0] as Element | undefined) ?? (event.target as Element | null);
  const ours = (el: Element | null | undefined) => !!el && !!host && (el === host || host.contains(el));

  function flushInput(el: Element): void {
    const timer = pendingInputs.get(el);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingInputs.delete(el);
    const secret = sensitive(el);
    const value = fieldValue(el);
    send({ ...describe(el, "input"), text: undefined, value: secret ? null : value.slice(0, VALUE_LIMIT), protected: secret });
  }

  const flushAll = () => [...pendingInputs.keys()].forEach(flushInput);

  const onClick = (event: MouseEvent) => {
    const origin = pathOf(event);
    if (!active || pointing || !origin?.tagName || ours(origin)) return;
    const el = origin.closest?.(CLICKABLE) ?? origin;
    // 点进文本框只是为了打字，填写会单独记一步。
    if (isTextEntry(el)) return;
    flushAll();
    send(describe(el, "click"));
  };

  const onInput = (event: Event) => {
    const el = pathOf(event);
    if (!active || !el?.tagName || ours(el)) return;
    const field = el.closest?.("input,textarea,select,[contenteditable]") ?? el;
    if (!(["INPUT", "TEXTAREA", "SELECT"].includes(field.tagName) || (field as HTMLElement).isContentEditable)) return;
    // 勾选框、单选框的点击已经记了；选择框换了选项立刻记。
    if (field.tagName === "INPUT" && ["checkbox", "radio", "button", "submit", "reset"].includes((field as HTMLInputElement).type)) return;
    clearTimeout(pendingInputs.get(field));
    pendingInputs.set(field, window.setTimeout(() => flushInput(field), 700));
    if (event.type === "change") flushInput(field);
  };

  const onBlur = (event: FocusEvent) => {
    const el = pathOf(event);
    if (el && pendingInputs.has(el)) flushInput(el);
  };

  const onSubmit = (event: SubmitEvent) => {
    const form = event.target as HTMLFormElement | null;
    if (!active || !form?.tagName) return;
    flushAll();
    const action = describe(form, "submit");
    send({ ...action, label: form.getAttribute("aria-label") || form.getAttribute("name") || form.id || (event.submitter ? labelOf(event.submitter) : "") || action.heading, text: undefined });
  };

  const onKeydown = (event: KeyboardEvent) => {
    const el = pathOf(event);
    if (pointing && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      endPoint(null);
      return;
    }
    if (!active || pointing || event.key !== "Enter" || event.isComposing || !el?.tagName || ours(el)) return;
    if (pendingInputs.has(el)) flushInput(el);
    send({ ...describe(el, "enter"), text: undefined });
  };

  // ---------- 指出元素（给标记用） ----------

  function ensureOverlay(): void {
    if (host) return;
    host = document.createElement("omem-record-root");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .box { position: fixed; border: 2px solid #e5484d; background: rgba(229, 72, 77, 0.08); border-radius: 3px; pointer-events: none; display: none; }
      .hint { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); padding: 6px 12px; border-radius: 999px; background: #1f2328; color: #fff;
        font: 13px/1.4 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.2); display: none; }
    </style><div class="box"></div><div class="hint">点一下要标记的元素 · Esc 取消</div>`;
    box = root.querySelector(".box");
    hint = root.querySelector(".hint");
    document.documentElement.appendChild(host);
  }

  const onPointMove = (event: MouseEvent) => {
    const el = pathOf(event);
    if (!pointing || !box || !el?.getBoundingClientRect || ours(el)) return;
    const rect = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px` });
  };

  // 指的这一下不传给页面：按下、抬起、点击都在捕获阶段拦掉。
  const swallow = (event: Event) => {
    if (!pointing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onPointClick = (event: MouseEvent) => {
    if (!pointing) return;
    swallow(event);
    const el = pathOf(event);
    endPoint(el?.tagName && !ours(el) ? describe(el, "mark") : null);
  };

  function endPoint(element: StepAction | null): void {
    pointing = false;
    if (box) box.style.display = "none";
    if (hint) hint.style.display = "none";
    void chrome.runtime.sendMessage({ type: "omem-record:pointed", element }).catch(() => undefined);
  }

  const listeners: Array<[string, EventListener]> = [
    ["click", onPointClick as EventListener],
    ["mousedown", swallow],
    ["mouseup", swallow],
    ["pointerdown", swallow],
    ["pointerup", swallow],
    ["mousemove", onPointMove as EventListener],
    ["click", onClick as EventListener],
    ["input", onInput],
    ["change", onInput],
    ["focusout", onBlur as EventListener],
    ["submit", onSubmit as EventListener],
    ["keydown", onKeydown as EventListener]
  ];
  // 挂在 window 的捕获阶段：比页面自己挂在 document 上的监听先到，指出元素时能拦住那一下。
  for (const [name, handler] of listeners) window.addEventListener(name, handler, true);
  addEventListener("pagehide", flushAll);

  return {
    start() {
      active = true;
    },
    stop() {
      flushAll();
      active = false;
      if (pointing) endPoint(null);
    },
    point() {
      ensureOverlay();
      pointing = true;
      if (hint) hint.style.display = "block";
    }
  };
}
