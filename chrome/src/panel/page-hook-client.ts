import type { MockGroup, MockRule } from "../shared/mock-rules";
import type { RequestInitiator } from "../shared/network";
import { type HookRulesPayload, hookRequestKey, PAGE_HOOK_GLOBAL } from "../shared/page-hook-protocol";

// 面板这一侧和页面钩子打交道：没授权的站点由这里用 inspectedWindow.eval 注入钩子、下发规则、读调用栈。
// 已授权站点的钩子由内容脚本注入，这里重复注入是幂等的（钩子发现已安装就只补发 ready）。

let hookSource: Promise<string> | null = null;

function evalInInspected<T>(expression: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      resolve(exceptionInfo ? undefined : (result as T));
    });
  });
}

export async function injectPageHook(): Promise<boolean> {
  hookSource ??= fetch(chrome.runtime.getURL("inject/page-hook.js")).then((response) => response.text());
  try {
    const source = await hookSource;
    await evalInInspected(`${source}\n;true`);
    return Boolean(await evalInInspected<boolean>(`Boolean(window[${JSON.stringify(PAGE_HOOK_GLOBAL)}])`));
  } catch {
    return false;
  }
}

export async function pushRulesToPageHook(rules: MockRule[], groups: MockGroup[]): Promise<void> {
  // 没有桥时「JS 修改响应」无法送进沙箱，scriptBridge=false 让钩子放行这类规则。
  const payload: HookRulesPayload = { rules: rules.filter((rule) => rule.enabled), groups, scriptBridge: false };
  const json = JSON.stringify(JSON.stringify(payload));
  await evalInInspected(`window[${JSON.stringify(PAGE_HOOK_GLOBAL)}]?.setRules(${json}); true`);
}

export async function readHookInitiator(method: string, url: string): Promise<RequestInitiator | null> {
  const key = JSON.stringify(hookRequestKey(method, url));
  return (await evalInInspected<RequestInitiator | null>(`window[${JSON.stringify(PAGE_HOOK_GLOBAL)}]?.initiator(${key}) ?? null`)) ?? null;
}

export async function readHookMocked(method: string, url: string): Promise<boolean> {
  const key = JSON.stringify(hookRequestKey(method, url));
  return Boolean(await evalInInspected<boolean>(`window[${JSON.stringify(PAGE_HOOK_GLOBAL)}]?.mocked(${key}) ?? false`));
}

/** 被检查页面的站点是否已授权（已授权才会在 document_start 注入，Mock 从第一个请求就生效）。 */
export async function inspectedOriginPattern(): Promise<string | null> {
  const href = await evalInInspected<string>("location.href");
  try {
    const url = new URL(href ?? "");
    return /^https?:$/.test(url.protocol) ? `${url.origin}/*` : null;
  } catch {
    return null;
  }
}
