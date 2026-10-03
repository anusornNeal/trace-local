export type MapTarget = 'url' | 'host' | 'path';

export interface MapRule {
  id: string;
  order: number;
  enabled: boolean;
  target: MapTarget;
  pattern: string;
  method: string;
  filePath: string;
  statusCode: number;
  contentType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMapRuleInput {
  enabled?: boolean;
  target?: MapTarget;
  pattern: string;
  method?: string;
  filePath: string;
  statusCode?: number;
  contentType?: string;
}

export interface UpdateMapRuleInput {
  enabled?: boolean;
  target?: MapTarget;
  pattern?: string;
  method?: string;
  filePath?: string;
  statusCode?: number;
  contentType?: string | null;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  protocol: string;
  httpVersion: string;
  method: string;
  url: string;
  host: string;
  path: string;
  statusCode?: number;
  statusMessage?: string;
  requestHeaders: Record<string, string | string[] | undefined>;
  responseHeaders?: Record<string, string | string[] | undefined>;
  requestBody?: string | null;
  responseBody?: string | null;
  requestBodyBytes: number;
  responseBodyBytes?: number;
  requestBodyEncoding?: 'text' | 'binary';
  responseBodyEncoding?: 'text' | 'binary';
  mapped: boolean;
  mapRuleId?: string;
  error?: string;
}

export interface SessionSummary {
  id: string;
  startedAt: number;
  durationMs?: number;
  protocol: string;
  method: string;
  url: string;
  host: string;
  path: string;
  statusCode?: number;
  mapped: boolean;
  mapRuleId?: string;
  requestBodyBytes: number;
  responseBodyBytes?: number;
  error?: string;
}

export interface ProxyStatus {
  running: boolean;
  port: number;
  proxyUrl: string | null;
  lanUrl: string | null;
  caCertPath: string;
  error?: string;
}

export interface DaemonStatus {
  version: string;
  controlPort: number;
  proxy: ProxyStatus;
  sessions: number;
  rules: number;
  warnings: string[];
}


export type PairingProtocolVersion = 1;

export interface PairingSetupResponse {
  protocolVersion: PairingProtocolVersion;
  url: string;
  qrSvg: string;
  expiresAt: number;
  ttlSeconds: number;
  desktopId: string;
  proxyAddress: string;
  caFingerprint256: string;
}

export interface PairingPayloadV1 {
  protocolVersion: PairingProtocolVersion;
  pairingId: string;
  desktopId: string;
  proxyAddress: string;
  caFingerprint256: string;
  apiBaseUrl: string;
  caDownloadUrl: string;
  issuedAt: number;
  expiresAt: number;
}

export type DevicePlatform = 'android' | 'ios' | 'other';
export type DeviceSessionState = 'connected' | 'disconnecting';

export interface PairedDeviceSession {
  sessionId: string;
  pairingId: string;
  deviceId: string;
  name: string;
  platform: DevicePlatform;
  connectedAt: number;
  lastHeartbeatAt: number;
  state: DeviceSessionState;
  disconnectRequested: boolean;
}
