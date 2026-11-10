import type { MockGroup, MockRule } from "./mock-rules";
import type { InitiatorStackFrame, RequestInitiator } from "./network";

// 页面钩子（MAIN world）与桥（ISOLATED world）之间用 document 上的 CustomEvent 通信，detail 一律是 JSON 字符串：
// 对象跨 world 传递时可能拿不到属性，字符串最稳。页面自己的脚本也能发这些事件，所以桥只转发规则 id，
// 后台按 id 从 storage 读脚本执行，页面伪造的事件最多影响它自己。

export const PAGE_HOOK_GLOBAL = "__omemPageHook";
export const HOOK_EVENT_READY = "omem:hook-ready";
export const HOOK_EVENT_RULES = "omem:hook-rules";
export const HOOK_EVENT_MOCKED = "omem:hook-mocked";
export const HOOK_EVENT_SCRIPT = "omem:hook-script";
export const HOOK_EVENT_SCRIPT_RESULT = "omem:hook-script-result";

export interface HookRulesPayload {
  rules: MockRule[];
  groups: MockGroup[];
  /** 桥能把「JS 修改响应」送去后台沙箱；面板 eval 注入时没有桥，这类规则只能放行。 */
  scriptBridge: boolean;
}

/** 面板通过 inspectedWindow.eval 读写的页面钩子接口。 */
export interface PageHookApi {
  version: number;
  setRules(json: string): void;
  initiator(key: string): RequestInitiator | null;
  mocked(key: string): boolean;
}

export function hookRequestKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

const V8_FRAME = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * 把 V8 的 `new Error().stack` 解析成和 CDP initiator 一样的结构。
 * 行列号转成 0 起（和 CDP 一致，界面统一 +1 显示）；跳过前 skip 帧（钩子自己的包装函数）。
 */
export function parseV8Stack(stack: string | undefined, skip = 0): InitiatorStackFrame[] {
  if (!stack) return [];
  const frames: InitiatorStackFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = V8_FRAME.exec(line);
    if (!match) continue;
    const [, fn, url, lineNumber, columnNumber] = match;
    if (!url || url === "<anonymous>" || url.startsWith("native")) continue;
    frames.push({
      functionName: fn?.replace(/^async\s+/, "") || "(anonymous)",
      url,
      lineNumber: Number(lineNumber) - 1,
      columnNumber: Number(columnNumber) - 1
    });
  }
  return frames.slice(skip);
}

export function initiatorFromStack(frames: InitiatorStackFrame[]): RequestInitiator {
  const top = frames[0];
  return {
    type: "script",
    url: top?.url ?? "",
    lineNumber: top?.lineNumber ?? null,
    columnNumber: top?.columnNumber ?? null,
    stack: frames
  };
}
