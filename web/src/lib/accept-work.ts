/**
 * 设置 → 设备 → 接别的设备派来的活（components/AcceptWorkSettings.vue）：`node.acceptWork` 是这台的档位，
 * `node.acceptWorkFrom` 按配对令牌的标识（`GET /api/peers` 的 paired[].id）单独设。服务端把 `node` 浅合并，
 * `acceptWorkFrom` 整份替换（docs/v2/mesh.md 4.6），所以改一个来源要交完整的映射，改全局档位不带它。
 */
export type AcceptWork = "off" | "read" | "write";
export type SourceChoice = AcceptWork | "inherit";

export const ACCEPT_LABEL: Record<AcceptWork, string> = { off: "不接", read: "只接只读", write: "也接要写的" };

export const levelOf = (v: unknown): AcceptWork => (v === "read" || v === "write" ? v : "off");

/** The whole map after one source is set, or taken out to follow the device's level again. */
export function withSource(map: Record<string, AcceptWork> | undefined, id: string, choice: SourceChoice): Record<string, AcceptWork> {
  const next = { ...(map ?? {}) };
  if (choice === "inherit") delete next[id];
  else next[id] = choice;
  return next;
}

/** What a source ends up with, in words: its own setting, or the device's (“跟随：只接只读”). */
export function effectiveText(global: AcceptWork, own: AcceptWork | undefined): string {
  return own ? ACCEPT_LABEL[own] : `跟随：${ACCEPT_LABEL[global]}`;
}
