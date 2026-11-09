import {
  type AvailableViewportSize,
  type DeviceEmulationSettings,
  type DeviceEmulationSource,
  type DeviceEmulationState,
  type DeviceProfile
} from "./device-emulation";

export type DeviceEmulationMessage =
  | {
      type: "advanced-network:get-device-emulation-state";
      tabId: number;
    }
  | {
      type: "advanced-network:set-device-emulation";
      tabId: number;
      profile: DeviceProfile;
      settings: DeviceEmulationSettings;
      source: DeviceEmulationSource;
      availableSize?: AvailableViewportSize;
    }
  | {
      type: "advanced-network:disable-device-emulation";
      tabId: number;
    }
  | {
      type: "advanced-network:refresh-device-emulation";
      tabId: number;
      availableSize?: AvailableViewportSize;
    }
  | {
      type: "advanced-network:device-viewport-changed";
      tabId: number;
      viewport: DeviceViewportSnapshot;
    };

export interface DeviceViewportSnapshot {
  innerWidth: number;
  innerHeight: number;
  visualWidth: number;
  visualHeight: number;
  visualScale: number;
}

export interface DeviceEmulationMessageResponse {
  ok: boolean;
  error?: string;
  debuggerUnavailable?: boolean;
  recoveryHint?: string;
  state?: DeviceEmulationState | null;
  uaRecoveryRequired?: boolean;
}

// background 会同时接收 Mock、用户状态、资源搜索等消息，必须先做轻量 type guard 再分发，避免误处理其他模块消息。
export function isDeviceEmulationMessage(value: unknown): value is DeviceEmulationMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return (
    type === "advanced-network:get-device-emulation-state" ||
    type === "advanced-network:set-device-emulation" ||
    type === "advanced-network:disable-device-emulation" ||
    type === "advanced-network:refresh-device-emulation" ||
    type === "advanced-network:device-viewport-changed"
  );
}
