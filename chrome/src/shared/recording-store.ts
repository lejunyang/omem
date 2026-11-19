import type { RecordedRequest, RecordedStep, RecordingSession } from "./recording";

// 录制存扩展自己的 IndexedDB（同拾取篮）：一次录制可能有上千个请求和几十张截图，chrome.storage 放不下。
// 后台写，侧栏读（同一个扩展源）。service worker 随时可能被回收，所以每个事件都直接写进库，
// 内存里只缓存当前录制的元信息，醒来时从这里读回。同一时间只有一次录制。

const DB_NAME = "omem-record";
const DB_VERSION = 1;
const SESSION = "session";
const STEPS = "steps";
const REQUESTS = "requests";
const IMAGES = "images";
const SESSION_KEY = "current";

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION)) db.createObjectStore(SESSION);
      if (!db.objectStoreNames.contains(STEPS)) db.createObjectStore(STEPS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(REQUESTS)) db.createObjectStore(REQUESTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
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

async function store(name: string, mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export async function getSession(): Promise<RecordingSession | null> {
  return ((await done((await store(SESSION)).get(SESSION_KEY))) as RecordingSession | undefined) ?? null;
}

export async function putSession(session: RecordingSession): Promise<void> {
  await done((await store(SESSION, "readwrite")).put(session, SESSION_KEY));
}

export async function putStep(step: RecordedStep): Promise<void> {
  await done((await store(STEPS, "readwrite")).put(step));
}

export async function getStep(id: string): Promise<RecordedStep | null> {
  return ((await done((await store(STEPS)).get(id))) as RecordedStep | undefined) ?? null;
}

/** 删掉一步和它的截图。 */
export async function deleteStep(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STEPS, IMAGES], "readwrite");
  tx.objectStore(STEPS).delete(id);
  tx.objectStore(IMAGES).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSteps(): Promise<RecordedStep[]> {
  const steps = (await done((await store(STEPS)).getAll())) as RecordedStep[];
  return steps.sort((a, b) => a.at - b.at);
}

export async function putRequest(request: RecordedRequest): Promise<void> {
  await done((await store(REQUESTS, "readwrite")).put(request));
}

export async function listRequests(): Promise<RecordedRequest[]> {
  return (await done((await store(REQUESTS)).getAll())) as RecordedRequest[];
}


export async function putImage(key: string, blob: Blob): Promise<void> {
  await done((await store(IMAGES, "readwrite")).put({ key, blob }));
}

export async function getImage(key: string): Promise<Blob | null> {
  return (((await done((await store(IMAGES)).get(key))) as { blob: Blob } | undefined) ?? null)?.blob ?? null;
}

/** 上传成功或放弃后清空。 */
export async function clearRecording(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSION, STEPS, REQUESTS, IMAGES], "readwrite");
  for (const name of [SESSION, STEPS, REQUESTS, IMAGES]) tx.objectStore(name).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
