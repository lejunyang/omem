import type { RecordedRequest, RecordingSession, StepAction } from "./recording";

// 录制的消息：侧栏 ↔ 后台、页面里的记录脚本 → 后台、DevTools 页面 → 后台。

export const RECORD_CHANGED_MESSAGE = "omem-record:changed";
/** 本人在页面上指了一个元素（或按 Esc 取消，element 为 null），转给侧栏 */
export const RECORD_POINTED_MESSAGE = "omem-record:pointed-relay";

export type RecordMessage =
  | { type: "omem-record:state" }
  | { type: "omem-record:start"; goal: string; tabId: number }
  | { type: "omem-record:add-tab"; tabId: number }
  | { type: "omem-record:stop" }
  | { type: "omem-record:resume" }
  | { type: "omem-record:discard" }
  | { type: "omem-record:set-goal"; goal: string }
  | { type: "omem-record:point"; tabId?: number }
  | { type: "omem-record:mark"; note: string; element: StepAction | null; tabId?: number }
  | { type: "omem-record:delete-step"; id: string }
  | { type: "omem-record:keepalive" }
  // 页面里的记录脚本
  | { type: "omem-record:event"; event: StepAction & { at: number } }
  | { type: "omem-record:pointed"; element: StepAction | null }
  // DevTools 页面：开着时补上请求体和响应体
  | { type: "omem-record:har"; tabId: number; entries: RecordedRequest[] };

export interface RecordStateResponse {
  ok: true;
  session: RecordingSession | null;
}

export type RecordResponse = RecordStateResponse | { ok: boolean; error?: string; needsPermission?: boolean };

const TYPES = new Set([
  "omem-record:state",
  "omem-record:start",
  "omem-record:add-tab",
  "omem-record:stop",
  "omem-record:resume",
  "omem-record:discard",
  "omem-record:set-goal",
  "omem-record:point",
  "omem-record:mark",
  "omem-record:delete-step",
  "omem-record:keepalive",
  "omem-record:event",
  "omem-record:pointed",
  "omem-record:har"
]);

export const isRecordMessage = (message: unknown): message is RecordMessage => TYPES.has(String((message as { type?: unknown } | null)?.type));
