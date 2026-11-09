// 不用 CDP 时，Mock、调用栈和居中模拟器的环境脚本都靠内容脚本进入页面。
// 只对用户授权过的站点注册（optional_host_permissions），没授权的站点由 DevTools 面板用 inspectedWindow.eval 补注入。

export const PAGE_HOOK_SCRIPT_ID = "omem-page-hook";
export const PAGE_BRIDGE_SCRIPT_ID = "omem-page-bridge";
export const SIMULATOR_ENV_SCRIPT_ID = "omem-simulator-env";

export const PAGE_HOOK_FILE = "inject/page-hook.js";
export const PAGE_BRIDGE_FILE = "inject/page-bridge.js";
export const SIMULATOR_ENV_FILE = "inject/simulator-env.js";

/** 只保留网页的匹配模式；<all_urls> 之类的宽泛模式也展开成 http/https 两条，避免把脚本注进 file:// 等页面。 */
export function webOriginPatterns(origins: readonly string[] | undefined): string[] {
  const patterns = new Set<string>();
  for (const origin of origins ?? []) {
    if (origin === "<all_urls>" || origin === "*://*/*") {
      patterns.add("http://*/*");
      patterns.add("https://*/*");
      continue;
    }
    if (/^(https?|\*):\/\//.test(origin)) patterns.add(origin);
  }
  return [...patterns].sort();
}

/**
 * 按当前授权和 CDP 开关重新注册内容脚本。
 * CDP 开启时 Mock 走 Fetch 域，页面钩子必须撤掉，否则同一个请求会被改两次；模拟器环境脚本只在模拟器 frame 名带参数时才生效，两种模式都保留。
 */
export async function syncPageHookRegistration(cdpEnabled: boolean): Promise<string[]> {
  const granted = await chrome.permissions.getAll().catch(() => ({ origins: [] as string[] }));
  const matches = webOriginPatterns(granted.origins);
  const registered = await chrome.scripting.getRegisteredContentScripts().catch(() => [] as chrome.scripting.RegisteredContentScript[]);
  const ours = registered.map((script) => script.id).filter((id) => [PAGE_HOOK_SCRIPT_ID, PAGE_BRIDGE_SCRIPT_ID, SIMULATOR_ENV_SCRIPT_ID].includes(id));
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours }).catch(() => undefined);
  if (!matches.length) return [];

  const scripts: chrome.scripting.RegisteredContentScript[] = [
    { id: SIMULATOR_ENV_SCRIPT_ID, js: [SIMULATOR_ENV_FILE], matches, allFrames: true, runAt: "document_start", world: "MAIN", persistAcrossSessions: true }
  ];
  if (!cdpEnabled) {
    scripts.push(
      { id: PAGE_HOOK_SCRIPT_ID, js: [PAGE_HOOK_FILE], matches, allFrames: true, runAt: "document_start", world: "MAIN", persistAcrossSessions: true },
      { id: PAGE_BRIDGE_SCRIPT_ID, js: [PAGE_BRIDGE_FILE], matches, allFrames: true, runAt: "document_start", world: "ISOLATED", persistAcrossSessions: true }
    );
  }
  await chrome.scripting.registerContentScripts(scripts);
  return matches;
}
