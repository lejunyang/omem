import type { PickRecord } from "./pick";

// 拾取篮存扩展自己的 IndexedDB：截图是 Blob，chrome.storage.local 有 10 MB 上限且只能存 JSON。
// 后台（service worker）写入，侧栏读取、改说明、删除；两边是同一个扩展源，共用这个库。

const DB_NAME = "omem-pick";
// 版本 2：版本 1 的库可能是别处无版本号 open() 时建的空库（没有表），升级时补建。
const DB_VERSION = 2;
const RECORDS = "records";
const META = "meta";

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: "id" }).createIndex("createdAt", "createdAt");
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => {
      const db = request.result;
      // 另一个上下文升级版本时关掉旧连接，下次重新打开。
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 新记录：在同一个事务里取递增编号，保证并发截图时编号不重复。 */
export async function addPickRecord(record: Omit<PickRecord, "seq">): Promise<PickRecord> {
  const db = await openDb();
  const tx = db.transaction([RECORDS, META], "readwrite");
  const meta = tx.objectStore(META);
  const last = ((await done(meta.get("seq"))) as number | undefined) ?? 0;
  const saved: PickRecord = { ...record, seq: last + 1 };
  meta.put(saved.seq, "seq");
  tx.objectStore(RECORDS).put(saved);
  await committed(tx);
  return saved;
}

export async function listPickRecords(): Promise<PickRecord[]> {
  const db = await openDb();
  const records = (await done(db.transaction(RECORDS).objectStore(RECORDS).getAll())) as PickRecord[];
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function updatePickNote(id: string, note: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(RECORDS, "readwrite");
  const store = tx.objectStore(RECORDS);
  const record = (await done(store.get(id))) as PickRecord | undefined;
  if (record) store.put({ ...record, note });
  await committed(tx);
}

export async function deletePickRecords(ids: string[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(RECORDS, "readwrite");
  for (const id of ids) tx.objectStore(RECORDS).delete(id);
  await committed(tx);
}

/** 清空时编号也归零，下一条从 #1 开始。 */
export async function clearPickRecords(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([RECORDS, META], "readwrite");
  tx.objectStore(RECORDS).clear();
  tx.objectStore(META).delete("seq");
  await committed(tx);
}

export const PICK_CHANGED_MESSAGE = "omem-pick:changed";

/** 通知其他界面（侧栏）记录有变化；没有界面在听时 sendMessage 会报错，忽略即可。 */
export function broadcastPickChanged(): void {
  void chrome.runtime.sendMessage({ type: PICK_CHANGED_MESSAGE }).catch(() => undefined);
}
