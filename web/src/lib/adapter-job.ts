import type { Ref } from "vue";
import { get } from "../api";

/** An install or upgrade of a backend's npm package running on the server (src/agents/adapter.ts). */
export type AdapterJob = {
  id: string;
  package: string;
  action: "install" | "upgrade";
  via: "osdk" | "npm";
  command: string;
  startedAt: string;
  finishedAt?: string;
  running: boolean;
  ok?: boolean;
  before: string | null;
  after?: string | null;
  output: string;
  message?: string;
  probe?: any;
};

export const lastLine = (text: string) => text.trim().split("\n").at(-1)?.slice(0, 200) ?? "";

/** How long it has been running, for the line under the button. */
export function jobElapsed(j: AdapterJob, now = Date.now()) {
  const s = Math.max(0, Math.round(((j.finishedAt ? Date.parse(j.finishedAt) : now) - Date.parse(j.startedAt)) / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/**
 * Follow a job until it ends: `follow(job)` keeps `target` current by asking every few seconds, and calls
 * `onDone` once when a job it saw running has finished (a job already finished when first seen is only shown).
 */
export function followAdapterJob(target: Ref<AdapterJob | null>, onDone: (job: AdapterJob) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let following = "";
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    following = "";
  };
  const tick = async (id: string, startedAt: string) => {
    if (following !== `${id}@${startedAt}`) return;
    try {
      const r = await get<{ job: AdapterJob | null }>(`/api/agents/${encodeURIComponent(id)}/adapter?quick=1`);
      if (following !== `${id}@${startedAt}`) return;
      const j = r.job;
      if (!j || j.startedAt !== startedAt) return stop();
      target.value = j;
      if (!j.running) {
        stop();
        onDone(j);
        return;
      }
    } catch {}
    timer = setTimeout(() => void tick(id, startedAt), 3000);
  };
  const follow = (job: AdapterJob) => {
    target.value = job;
    const key = `${job.id}@${job.startedAt}`;
    if (!job.running || following === key) return;
    stop();
    following = key;
    timer = setTimeout(() => void tick(job.id, job.startedAt), 2000);
  };
  return Object.assign(follow, { stop });
}
