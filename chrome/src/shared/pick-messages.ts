import type { PageContext } from "./element-context";
import type { PickElement, PickKind, PickRect, PickSpacing } from "./pick";

// popup / 侧栏 / 页面内容脚本 与后台之间的拾取消息。

export type PickStartMode = "element" | "region" | "viewport" | "page";

export interface PickCommitPayload {
  kind: PickKind;
  /** 要截的区域（视口坐标）；整页时忽略 */
  clip: PickRect;
  /** 记录用的页面坐标矩形 */
  rect: PickRect;
  elements: PickElement[];
  spacings: PickSpacing[];
  pageUrl: string;
  pageTitle: string;
  pageContext?: PageContext;
  viewport: { width: number; height: number };
  /** 整页：文档尺寸和逐屏截图的滚动位置（已由内容脚本按计划截好，见 pick:grab） */
  page?: { width: number; height: number; truncated: boolean };
}

export type PickMessage =
  | { type: "omem-pick:start"; mode: PickStartMode; tabId?: number }
  | { type: "omem-pick:open-basket"; windowId?: number }
  | { type: "omem-pick:grab-begin" }
  | { type: "omem-pick:grab"; scrollY: number }
  | { type: "omem-pick:commit"; payload: PickCommitPayload }
  | { type: "omem-pick:cdp-page"; width: number; height: number };

export function isPickMessageType(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("omem-pick:") && type !== "omem-pick:changed";
}

export interface PickResponse {
  ok: boolean;
  error?: string;
  /** 需要用户先授予当前页面的访问权限（从侧栏发起、又没有 activeTab 时） */
  needsPermission?: boolean;
  seq?: number;
  id?: string;
}
