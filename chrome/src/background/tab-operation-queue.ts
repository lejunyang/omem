// 同一 tab 的开启、关闭和延迟重放必须串行；否则已在途的重放会在关闭之后写回旧状态。
// 不同 tab 互不阻塞，失败也不能永久卡住后续恢复操作。
export function createTabOperationQueue() {
  const pending = new Map<number, Promise<unknown>>();
  function run<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const task = (pending.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    pending.set(tabId, task);
    void task.finally(() => { if (pending.get(tabId) === task) pending.delete(tabId); }).catch(() => undefined);
    return task;
  }
  return Object.assign(run, { has: (tabId: number) => pending.has(tabId) });
}
