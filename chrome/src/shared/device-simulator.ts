import type { SimulatorEnvironment } from "./simulator-environment";

export const SIMULATOR_FRAME_NAME = "advanced-network-device-frame";

export interface SimulatorFrameParams {
  environment: SimulatorEnvironment;
  userAgent: string;
  platform: string;
}

// 不用 CDP 时，模拟参数放在 iframe 的 name 里交给内页的环境脚本：name 在内页 document_start 就能同步读到，
// 跨域也不受限制。代价是内页读 window.name 会看到这串参数，极少有页面依赖它。
export function simulatorFrameName(params: SimulatorFrameParams | null): string {
  return params ? `${SIMULATOR_FRAME_NAME}:${JSON.stringify(params)}` : SIMULATOR_FRAME_NAME;
}

export function parseSimulatorFrameName(name: string): SimulatorFrameParams | null {
  const prefix = `${SIMULATOR_FRAME_NAME}:`;
  if (!name.startsWith(prefix)) return null;
  try {
    const value = JSON.parse(name.slice(prefix.length)) as Partial<SimulatorFrameParams>;
    const env = value.environment;
    if (!env || typeof env.width !== "number" || typeof env.height !== "number") return null;
    return {
      environment: {
        width: env.width,
        height: env.height,
        deviceScaleFactor: Number(env.deviceScaleFactor) || 0,
        touchEnabled: Boolean(env.touchEnabled),
        maxTouchPoints: Number(env.maxTouchPoints) || 0,
        landscape: Boolean(env.landscape)
      },
      userAgent: typeof value.userAgent === "string" ? value.userAgent : "",
      platform: typeof value.platform === "string" ? value.platform : ""
    };
  } catch {
    return null;
  }
}

// 模拟器只承载普通网页，拒绝扩展页和脚本协议，避免地址栏变成任意执行入口。
export function normalizeSimulatorUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("仅支持 HTTP / HTTPS 网页。");
  return url.href;
}

// 仅去掉阻止嵌入的响应指令，保留 script-src 等其他 CSP 约束以及重复的响应头。
// 调用方必须先确认这是模拟器的直接子 frame，不能对正常 tab 或嵌套第三方 iframe 使用。
export function allowSimulatorEmbedding(headers: Array<{ name: string; value: string }>) {
  return headers.flatMap((header) => {
    const name = header.name.toLowerCase();
    if (name === "x-frame-options") return [];
    if (name !== "content-security-policy" && name !== "content-security-policy-report-only") return [header];
    const value = header.value.split(",").map((policy) => policy.split(";")
      .filter((directive) => !/^\s*frame-ancestors(?:\s|$)/i.test(directive))
      .map((directive) => directive.trim()).filter(Boolean).join("; ")).filter(Boolean).join(", ");
    return value ? [{ ...header, value }] : [];
  });
}
