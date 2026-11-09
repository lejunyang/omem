export const NETWORK_CONTROL_STORAGE_KEY = "advancedNetwork.networkControls";

export type ThrottlingProfileId = "none" | "offline" | "fast-3g" | "slow-3g";

export interface ThrottlingProfile {
  id: ThrottlingProfileId;
  label: string;
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
}

export interface NetworkControlSettings {
  preserveLog: boolean;
  disableCache: boolean;
  throttlingProfile: ThrottlingProfileId;
}

export interface CdpNetworkConditions {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
}

export const DEFAULT_NETWORK_CONTROL_SETTINGS: NetworkControlSettings = {
  preserveLog: false,
  disableCache: false,
  throttlingProfile: "none"
};

export const THROTTLING_PROFILES: ThrottlingProfile[] = [
  {
    id: "none",
    label: "无限制",
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  },
  {
    id: "offline",
    label: "离线",
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0
  },
  {
    id: "fast-3g",
    label: "Fast 3G",
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8
  },
  {
    id: "slow-3g",
    label: "Slow 3G",
    offline: false,
    latency: 400,
    downloadThroughput: (500 * 1024) / 8,
    uploadThroughput: (500 * 1024) / 8
  }
];

export function normalizeNetworkControlSettings(value: unknown): NetworkControlSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_NETWORK_CONTROL_SETTINGS;
  }

  const candidate = value as Partial<NetworkControlSettings>;
  return {
    preserveLog:
      typeof candidate.preserveLog === "boolean"
        ? candidate.preserveLog
        : DEFAULT_NETWORK_CONTROL_SETTINGS.preserveLog,
    disableCache:
      typeof candidate.disableCache === "boolean"
        ? candidate.disableCache
        : DEFAULT_NETWORK_CONTROL_SETTINGS.disableCache,
    throttlingProfile: isThrottlingProfileId(candidate.throttlingProfile)
      ? candidate.throttlingProfile
      : DEFAULT_NETWORK_CONTROL_SETTINGS.throttlingProfile
  };
}

export function getThrottlingProfile(profileId: ThrottlingProfileId): ThrottlingProfile {
  return THROTTLING_PROFILES.find((profile) => profile.id === profileId) ?? THROTTLING_PROFILES[0];
}

export function toCdpNetworkConditions(profileId: ThrottlingProfileId): CdpNetworkConditions {
  const profile = getThrottlingProfile(profileId);
  return {
    offline: profile.offline,
    latency: profile.latency,
    downloadThroughput: profile.downloadThroughput,
    uploadThroughput: profile.uploadThroughput
  };
}

function isThrottlingProfileId(value: unknown): value is ThrottlingProfileId {
  return THROTTLING_PROFILES.some((profile) => profile.id === value);
}
