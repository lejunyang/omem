import { Cron } from "croner";
import type { ScheduleTiming } from "../../../../packages/contracts/src/schedules.js";

/** Croner calculates civil time/DST; persistence and timers belong to the service. */
export function nextScheduleRun(timing: ScheduleTiming, after: Date): string {
  if (timing.type === "interval")
    return new Date(
      after.getTime() + timing.everyMinutes * 60_000,
    ).toISOString();
  // The user-facing contract is the usual five-field cron, with minute precision.
  if (timing.expression.trim().split(/\s+/).length !== 5)
    throw Error("Cron 需要五个字段：分钟、小时、日、月、星期");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timing.timezone }).format(after);
  } catch {
    throw Error("时区无效，请使用 Asia/Shanghai 等 IANA 时区");
  }
  let cron: Cron | undefined;
  try {
    cron = new Cron(timing.expression, {
      timezone: timing.timezone,
      paused: true,
    });
    const next = cron.nextRun(after);
    if (!next) throw Error("该 Cron 没有下一次可执行时间");
    return next.toISOString();
  } catch (error) {
    throw Error(
      `Cron 设置无效：${error instanceof Error ? error.message : "无法解析"}`,
    );
  } finally {
    cron?.stop();
  }
}
