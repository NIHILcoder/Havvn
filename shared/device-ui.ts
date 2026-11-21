import type { DeviceScope, DeviceJson } from "./device-pairing";
export interface DeviceEndpoint {
  host: string;
  port: number;
}
export interface DeviceUiConfig {
  version: 1;
  enabled: boolean;
  listen: DeviceEndpoint;
  remote: DeviceEndpoint | null;
  scopes: DeviceScope[];
  categories: Record<string, string>;
}
export interface DeviceLocalRecord {
  scope: DeviceScope;
  recordId: string;
  value: DeviceJson;
  deleted: boolean;
}
export interface DeviceCapture {
  records: DeviceLocalRecord[];
  issues: Array<{ scope: DeviceScope; recordId: string; code: string }>;
}
export interface DeviceUiConfirmation {
  id: string;
  self: string;
  peer: string;
  scopes: DeviceScope[];
  endpoint: DeviceEndpoint | null;
  expiresAt: number;
}
export interface DeviceUiRecord {
  scope: DeviceScope;
  recordId: string;
  heads: string;
  issue: string | null;
  variants: Array<{
    author: string;
    sequence: number;
    deleted: boolean;
    value: DeviceJson;
  }>;
}
export interface DeviceUiState {
  lastApplied?: { at: number; scope: DeviceScope } | null;
  enabled: boolean;
  status:
    | "off"
    | "opening"
    | "unpaired"
    | "inviting"
    | "confirming"
    | "pending"
    | "prepared"
    | "offline"
    | "connecting"
    | "online"
    | "revoked"
    | "error";
  error: string | null;
  self: string | null;
  peer: string | null;
  grant: string | null;
  scopes: DeviceScope[];
  approved: boolean;
  config: DeviceUiConfig;
  addresses: string[];
  confirmation: DeviceUiConfirmation | null;
  outbox: number;
  pending: number;
  conflicts: number;
  recovering: boolean;
  records: DeviceUiRecord[];
  inventory: { preferences: number; views: number; playback: number };
  localRecords: DeviceLocalRecord[];
  issues: DeviceCapture["issues"];
  snapshotOffer: {
    id: string;
    scope: DeviceScope;
    records: number;
    watermark: number;
  } | null;
}
export type DeviceUiRequest =
  | { kind: "enable"; enabled: boolean }
  | {
      kind: "configure";
      listen: DeviceEndpoint;
      remote: DeviceEndpoint | null;
      scopes: DeviceScope[];
    }
  | { kind: "invite" }
  | { kind: "join"; text: string }
  | { kind: "confirm"; id: string; accept: boolean }
  | { kind: "approve"; grant: string }
  | { kind: "revoke" }
  | { kind: "cancel" }
  | { kind: "reconnect" }
  | { kind: "narrow"; scopes: DeviceScope[] }
  | { kind: "map-category"; source: string; target: string }
  | {
      kind: "preview";
      scope: DeviceScope;
      recordId: string;
      author?: string;
      sequence?: number;
      local?: boolean;
    }
  | {
      kind: "resolve";
      scope: DeviceScope;
      recordId: string;
      heads: string;
      author?: string;
      sequence?: number;
      local?: boolean;
      beforeStamp: string;
    }
  | { kind: "snapshot" }
  | { kind: "reset"; confirmation: string };
export type DeviceSnapshotDecision = {
  kind: "accept-snapshot";
  id: string;
  accept: boolean;
};
export interface DeviceUiResult {
  invitationExpiresAt?: number;
  state: DeviceUiState;
  invitation?: string;
  preview?: {
    scope: DeviceScope;
    recordId: string;
    heads: string;
    beforeStamp: string;
    before: string;
    after: string;
    issue: string | null;
    author?: string;
    sequence?: number;
    local?: boolean;
  };
}
export interface DevicesApi {
  state(): Promise<DeviceUiState>;
  start(): Promise<DeviceUiState>;
  command(
    request: DeviceUiRequest | DeviceSnapshotDecision,
  ): Promise<DeviceUiResult>;
  changed(callback: () => void): () => void;
  localChanged(): void;
  activeMedia(selectors: Array<{ identity: string; path: string }>): void;
}
