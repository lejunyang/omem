import type { UserStateProfile } from "./user-state-profiles";

export interface UserStateMessageResponse {
  ok: boolean;
  error?: string;
  matchedTabs?: number;
}

export type UserStateMessage =
  | {
      type: "advanced-network:user-state-apply-profile";
      profile: UserStateProfile;
    }
  | {
      type: "advanced-network:user-state-disable-profile";
    }
  | {
      type: "advanced-network:user-state-capture";
      profile: UserStateProfile;
    }
  | {
      type: "advanced-network:user-state-storage-changed";
      profileId: string;
      operationId?: string;
      source: "browser" | "extension";
      tabId?: number;
      frameId?: number;
      url: string;
      origin: string;
      topLevelSite: string;
      frameUrl: string;
      area: "localStorage" | "sessionStorage";
      action: "setItem" | "removeItem" | "clear" | "snapshot";
      key?: string | null;
      value?: string | null;
      snapshot?: Record<string, string>;
    };

export function isUserStateMessage(value: unknown): value is UserStateMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === "advanced-network:user-state-apply-profile" ||
    type === "advanced-network:user-state-disable-profile" ||
    type === "advanced-network:user-state-capture" ||
    type === "advanced-network:user-state-storage-changed"
  );
}
