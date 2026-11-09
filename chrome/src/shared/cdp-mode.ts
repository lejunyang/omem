import { getStorageItems, setStorageItems } from "./extension-storage";

// 「CDP 增强」开关。默认关闭：chrome.debugger 一旦连接，Chrome 会在所有窗口顶部显示「已开始调试此浏览器」，
// 扩展没有办法隐藏（只有启动参数 --silent-debugger-extension-api），所以默认走不连调试器的实现。
export const CDP_MODE_STORAGE_KEY = "advancedNetwork.cdpMode";

export type CdpMode = "off" | "on";

export const DEFAULT_CDP_MODE: CdpMode = "off";

/** 只认 "on"；缺失、旧数据或任何其他值都视为关闭，避免意外连接调试器。 */
export function normalizeCdpMode(value: unknown): CdpMode {
  return value === "on" ? "on" : "off";
}

export async function loadCdpMode(area: chrome.storage.StorageArea = chrome.storage.local): Promise<CdpMode> {
  try {
    const items = await getStorageItems(area, [CDP_MODE_STORAGE_KEY]);
    return normalizeCdpMode(items[CDP_MODE_STORAGE_KEY]);
  } catch {
    return DEFAULT_CDP_MODE;
  }
}

export async function saveCdpMode(mode: CdpMode, area: chrome.storage.StorageArea = chrome.storage.local): Promise<void> {
  await setStorageItems(area, { [CDP_MODE_STORAGE_KEY]: normalizeCdpMode(mode) });
}

/** 后台在 CDP 关闭时拒绝连接调试器，用这个错误名让各处界面显示「需要开启 CDP 增强」而不是报错。 */
export const CDP_DISABLED_ERROR_NAME = "CdpDisabledError";

export const CDP_DISABLED_MESSAGE = "这个功能需要「CDP 增强」。开启后 Chrome 会在顶部显示调试提示条。";

export function createCdpDisabledError(feature?: string): Error {
  const error = new Error(feature ? `${feature}需要「CDP 增强」。` : CDP_DISABLED_MESSAGE);
  error.name = CDP_DISABLED_ERROR_NAME;
  return error;
}

export function isCdpDisabledError(error: unknown): error is Error {
  return error instanceof Error && error.name === CDP_DISABLED_ERROR_NAME;
}
