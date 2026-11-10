export type StorageItems = Record<string, unknown>;

export interface StorageAreaLike {
  get(
    keys?: string | string[] | StorageItems | null,
    callback?: (items: StorageItems) => void
  ): Promise<StorageItems> | void;
  set(items: StorageItems, callback?: () => void): Promise<void> | void;
}

export interface RuntimeLike {
  lastError?: {
    message?: string;
  };
}

export async function getStorageItems(
  area: StorageAreaLike,
  keys?: string | string[] | StorageItems | null,
  runtime: RuntimeLike = chrome.runtime
): Promise<StorageItems> {
  // chrome.storage 在 DevTools 扩展上下文中可能是 callback 或 Promise 形态，统一包装后 UI 层不需要关心运行时差异。
  return new Promise((resolve, reject) => {
    const done = (items: StorageItems = {}) => {
      const error = runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? "读取 chrome.storage.local 失败"));
        return;
      }
      resolve(items);
    };

    const maybePromise = area.get(keys, done);
    if (isPromiseLike<StorageItems>(maybePromise)) {
      maybePromise.then(resolve, reject);
    }
  });
}

export async function setStorageItems(
  area: StorageAreaLike,
  items: StorageItems,
  runtime: RuntimeLike = chrome.runtime
): Promise<void> {
  // 写入也要读取 lastError；否则权限或 quota 失败会被静默吞掉，导致面板以为持久化成功。
  return new Promise((resolve, reject) => {
    const done = () => {
      const error = runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? "写入 chrome.storage.local 失败"));
        return;
      }
      resolve();
    };

    const maybePromise = area.set(items, done);
    if (isPromiseLike<void>(maybePromise)) {
      maybePromise.then(resolve, reject);
    }
  });
}

export async function setStorageItemsAndVerify(
  area: StorageAreaLike,
  items: StorageItems,
  runtime: RuntimeLike = chrome.runtime
): Promise<void> {
  // 写后读回用于捕获 DevTools 重开后“看似保存但 key 不存在”的问题，尤其是 storage 结构迁移期间。
  await setStorageItems(area, items, runtime);
  const keys = Object.keys(items);
  const stored = await getStorageItems(area, keys, runtime);
  const missingKey = keys.find((key) => !(key in stored));
  if (missingKey) {
    throw new Error(`写入 chrome.storage.local 后未读回 ${missingKey}`);
  }
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(value) && typeof (value as Promise<T>).then === "function";
}
