/**
 * The process's memory over time, so a leak can be told from a plateau. A native arena (the local
 * embedding model keeps its peak) or a loaded vector matrix grows once and stays; a leak keeps the
 * V8 heap climbing between samples long after the work that caused it.
 */

type Sample = { at: string; rssMb: number; heapUsedMb: number; externalMb: number; arrayBuffersMb: number };
const samples: Sample[] = [];
const EVERY_MS = 10 * 60_000;
const KEEP = 6 * 24 * 2; // two days

const mb = (n: number) => Math.round(n / 1024 / 1024);

export function memoryNow(): Sample & { heapTotalMb: number } {
  const m = process.memoryUsage();
  return { at: new Date().toISOString(), rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers) };
}

let started = false;
export function startMemoryWatch() {
  if (started) return;
  started = true;
  const take = () => {
    const { heapTotalMb: _, ...s } = memoryNow();
    samples.push(s);
    if (samples.length > KEEP) samples.shift();
  };
  take();
  setInterval(take, EVERY_MS).unref();
}

/**
 * Samples thinned to at most `points`, and the V8 heap's lowest value in the first and last
 * quarter of the window: a floor that keeps rising is the sign of a leak.
 */
export function memoryHistory(points = 24) {
  const step = Math.max(1, Math.ceil(samples.length / points));
  const thin = samples.filter((_, i) => i % step === 0 || i === samples.length - 1);
  const q = Math.max(1, Math.floor(samples.length / 4));
  const floor = (list: Sample[]) => (list.length ? Math.min(...list.map((s) => s.heapUsedMb)) : null);
  return { everyMinutes: EVERY_MS / 60_000, heapFloorFirstQuarterMb: floor(samples.slice(0, q)), heapFloorLastQuarterMb: floor(samples.slice(-q)), samples: thin };
}
