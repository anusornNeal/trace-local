import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  CertificateAuthorityManager,
  defaultTraceLocalDataDir,
  type CertificateAuthorityMetadata,
} from '../certificates/ca-manager';
import { CaTokenServer } from '../certificates/ca-token-server';
import { SessionStore } from '../core/session-store';
import { DeviceSessionStore } from '../devices/device-session-store';
import type {
  CreateMapRuleInput,
  DaemonStatus,
  UpdateMapRuleInput,
} from '../core/types';
import { buildHar } from '../export/har';
import { MapRuleStore } from '../map-local/rule-store';
import { InterceptProxy } from '../proxy/intercept-proxy';
import { PairingTokenStore, PAIRING_PROTOCOL_VERSION } from '../pairing/pairing-store';
import {
  parseRuleStateDocument,
  RuleStateRepository,
} from '../state/rule-state';
import { getPrimaryLanAddress, getLanAddresses } from './lan-addresses';

const VERSION = '0.1.0';
const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

export interface TraceLocalDaemonOptions {
  controlHost?: string;
  controlPort?: number;
  proxyPort?: number;
  maxSessions?: number;
  maxBodyPreviewBytes?: number;
  dataDir?: string;
  allowRemote?: boolean;
  additionalTrustedCaCerts?: string[];
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sendJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(
  response: http.ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    totalBytes += chunk.length;
    if (totalBytes > MAX_CONTROL_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }

  if (totalBytes === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON body must be an object');
  }
  return value as Record<string, unknown>;
}

const UI_ASSETS: Record<
  string,
  { file: string; contentType: string }
> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
};

async function tryServeUiAsset(
  pathname: string,
  response: http.ServerResponse,
): Promise<boolean> {
  const asset = UI_ASSETS[pathname];
  if (!asset) return false;

  const filePath = path.resolve(__dirname, '..', 'ui', asset.file);

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': asset.contentType,
      'content-length': body.length,
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    response.end(body);
  } catch (error) {
    sendJson(response, 503, {
      error: 'ui_unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return true;
}

export class TraceLocalDaemon {
  readonly store: SessionStore;
  readonly rules: MapRuleStore;
  readonly caManager: CertificateAuthorityManager;
  readonly ruleState: RuleStateRepository;
  readonly caTokenServer: CaTokenServer;
  readonly pairingTokens: PairingTokenStore;
  readonly deviceSessions: DeviceSessionStore;
  readonly dataDir: string;
  proxy?: InterceptProxy;

  private controlServer?: http.Server;
  private mobileCaServer?: http.Server;
  private controlPort = 0;
  private mobileCaPort = 0;
  private caMetadata?: CertificateAuthorityMetadata;
  private startupWarnings: string[] = [];
  private readonly eventClients = new Set<http.ServerResponse>();

  constructor(private readonly options: TraceLocalDaemonOptions = {}) {
    this.dataDir = options.dataDir ?? defaultTraceLocalDataDir();
    this.store = new SessionStore(options.maxSessions ?? 500);
    this.rules = new MapRuleStore();
    this.caManager = new CertificateAuthorityManager(this.dataDir);
    this.ruleState = new RuleStateRepository(this.dataDir);
    this.caTokenServer = new CaTokenServer();
    this.pairingTokens = new PairingTokenStore();
    this.deviceSessions = new DeviceSessionStore();
    this.store.subscribe((event) => this.broadcastEvent(event.type, event));
  }

  get status(): DaemonStatus {
    return {
      version: VERSION,
      controlPort: this.controlPort,
      proxy: this.proxy?.status ?? {
        running: false,
        port: 0,
        proxyUrl: null,
        lanUrl: null,
        caCertPath: this.caManager.certPath,
      },
      sessions: this.store.size,
      rules: this.rules.size,
      warnings: [...this.startupWarnings],
    };
  }

  async start(): Promise<DaemonStatus> {
    if (this.controlServer && this.proxy) return this.status;

    this.startupWarnings = [];
    const persistedRules = await this.ruleState.loadRecovering();
    this.rules.hydrate(persistedRules.rules);
    if (persistedRules.warning) {
      this.startupWarnings.push(persistedRules.warning);
      console.warn(persistedRules.warning);
    }

    const ca = await this.caManager.ensure();
    this.caMetadata = {
      certPath: ca.certPath,
      publicCertPath: ca.publicCertPath,
      fingerprint256: ca.fingerprint256,
      expiresAt: ca.expiresAt,
    };

    const proxy = new InterceptProxy(this.store, {
      port: this.options.proxyPort,
      maxBodyPreviewBytes: this.options.maxBodyPreviewBytes,
      ruleStore: this.rules,
      ca,
      allowRemote: this.options.allowRemote,
      additionalTrustedCaCerts: this.options.additionalTrustedCaCerts,
    });
    await proxy.start();
    this.proxy = proxy;

    const controlHost = this.options.controlHost ?? '127.0.0.1';
    const controlPort = this.options.controlPort ?? 4040;
    this.controlServer = http.createServer((request, response) => {
      void this.handleControlRequest(request, response).catch((error) => {
        if (!response.headersSent) {
          sendJson(response, 500, {
            error: 'internal_error',
            message: error instanceof Error ? error.message : String(error),
          });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const controlServer = this.controlServer!;
        const onError = (error: Error) => {
          controlServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          controlServer.off('error', onError);
          resolve();
        };
        controlServer.once('error', onError);
        controlServer.once('listening', onListening);
        controlServer.listen(controlPort, controlHost);
      });
    } catch (error) {
      this.controlServer = undefined;
      this.proxy = undefined;
      await proxy.stop();
      throw error;
    }

    const address = this.controlServer.address() as AddressInfo;
    this.controlPort = address.port;
    await this.startMobileCaServer();
    return this.status;
  }

  async stop(): Promise<void> {
    const controlServer = this.controlServer;
    const mobileCaServer = this.mobileCaServer;
    const proxy = this.proxy;
    this.controlServer = undefined;
    this.mobileCaServer = undefined;
    this.proxy = undefined;

    for (const client of this.eventClients) {
      client.end();
    }
    this.eventClients.clear();

    if (controlServer) {
      await new Promise<void>((resolve, reject) => {
        controlServer.close((error) => (error ? reject(error) : resolve()));
      });
    }

    if (mobileCaServer) {
      await new Promise<void>((resolve) => mobileCaServer.close(() => resolve()));
    }

    if (proxy) await proxy.stop();
    this.controlPort = 0;
    this.mobileCaPort = 0;
  }

  private async refreshProxyRules(): Promise<void> {
    await this.proxy?.refreshRules();
  }

  private async persistRuleMutation<T>(mutate: () => T): Promise<T> {
    const before = this.rules.list();

    try {
      const result = mutate();
      await this.ruleState.save(this.rules.list());
      await this.refreshProxyRules();
      this.broadcastEvent('rules-changed', { rules: this.rules.list() });
      return result;
    } catch (error) {
      this.rules.hydrate(before);
      await this.ruleState.save(before).catch(() => undefined);
      await this.refreshProxyRules().catch(() => undefined);
      throw error;
    }
  }

  private sendEvent(
    response: http.ServerResponse,
    type: string,
    data: unknown,
  ): void {
    response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcastEvent(type: string, data: unknown): void {
    for (const response of [...this.eventClients]) {
      try {
        this.sendEvent(response, type, data);
      } catch {
        this.eventClients.delete(response);
      }
    }
  }

  private openEventStream(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 1000\n\n');

    this.eventClients.add(response);
    this.sendEvent(response, 'status', this.status);

    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(': heartbeat\n\n');
      }
    }, 15_000);
    heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      this.eventClients.delete(response);
    };

    request.once('close', cleanup);
    response.once('close', cleanup);
  }

  private async startMobileCaServer(): Promise<void> {
    const lanAddress = getPrimaryLanAddress();
    if (!lanAddress) {
      this.startupWarnings.push('Mobile CA setup is unavailable because no LAN address was found.');
      return;
    }

    const server = http.createServer((request, response) => {
      void this.handleMobileCaRequest(request, response).catch((error) => {
        if (!response.headersSent) {
          sendJson(response, 500, { error: 'mobile_ca_error', message: error instanceof Error ? error.message : String(error) });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', () => resolve());
      });
      this.mobileCaServer = server;
      this.mobileCaPort = (server.address() as AddressInfo).port;
    } catch (error) {
      this.mobileCaPort = 0;
      this.startupWarnings.push(`Mobile CA setup could not bind to the LAN: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    }
  }

  private async handleMobileCaRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (method === 'GET' && url.pathname.startsWith('/pair/')) {
      if (url.searchParams.get('v') !== String(PAIRING_PROTOCOL_VERSION)) {
        sendJson(response, 400, { error: 'unsupported_pairing_protocol' });
        return;
      }

      const token = url.pathname.slice('/pair/'.length);
      const pairing = this.pairingTokens.redeem(token);
      if (!pairing) {
        sendJson(response, 410, { error: 'pairing_token_expired_or_used' });
        return;
      }

      this.deviceSessions.authorizePairing(pairing.pairingId, pairing.expiresAt);

      const metadata = this.caMetadata ?? (await this.caManager.metadata());
      this.caMetadata = metadata;
      const lanAddress = getPrimaryLanAddress();
      const proxyPort = this.proxy?.status.port ?? 0;
      if (!lanAddress || proxyPort === 0) {
        sendJson(response, 503, { error: 'pairing_endpoint_unavailable' });
        return;
      }

      sendJson(response, 200, {
        protocolVersion: PAIRING_PROTOCOL_VERSION,
        pairingId: pairing.pairingId,
        desktopId: this.desktopId(metadata.fingerprint256),
        proxyAddress: lanAddress + ':' + proxyPort,
        caFingerprint256: metadata.fingerprint256,
        issuedAt: pairing.createdAt,
        expiresAt: pairing.expiresAt,
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/device/session') {
      const body = asObject(await readJsonBody(request));
      const pairingId = typeof body.pairingId === 'string' ? body.pairingId : '';
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const platform = body.platform === 'android' || body.platform === 'ios' ? body.platform : 'other';
      if (!pairingId || !deviceId || !name) { sendJson(response, 400, { error: 'invalid_device_identity' }); return; }
      const session = this.deviceSessions.connect(pairingId, { deviceId, name, platform });
      if (!session) { sendJson(response, 401, { error: 'pairing_not_authorized' }); return; }
      this.broadcastEvent('devices-changed', { devices: this.deviceSessions.list() });
      sendJson(response, 201, { session, heartbeatIntervalMs: 10000, staleAfterMs: 45000, restoreRoutingOnDisconnect: true });
      return;
    }

    const heartbeatMatch = url.pathname.match(/^\/device\/session\/([^/]+)\/heartbeat$/);
    if (method === 'POST' && heartbeatMatch) {
      const heartbeat = this.deviceSessions.heartbeat(decodeURIComponent(heartbeatMatch[1]));
      if (!heartbeat) { sendJson(response, 404, { error: 'device_session_not_found', restoreRouting: true }); return; }
      sendJson(response, 200, heartbeat);
      return;
    }

    const disconnectedMatch = url.pathname.match(/^\/device\/session\/([^/]+)\/disconnected$/);
    if (method === 'POST' && disconnectedMatch) {
      const removed = this.deviceSessions.acknowledgeDisconnected(decodeURIComponent(disconnectedMatch[1]));
      if (!removed) { sendJson(response, 404, { error: 'device_session_not_found' }); return; }
      this.broadcastEvent('devices-changed', { devices: this.deviceSessions.list() });
      sendJson(response, 200, { disconnected: true });
      return;
    }
    if (method !== 'GET' || !url.pathname.startsWith('/ca/')) {
      sendText(response, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    const token = url.pathname.slice('/ca/'.length);
    if (!this.caTokenServer.validateToken(token)) {
      sendText(response, 404, 'text/plain; charset=utf-8', 'Invalid or expired token');
      return;
    }
    const material = await this.caManager.ensure();
    response.writeHead(200, {
      'content-type': 'application/x-pem-file; charset=utf-8',
      'content-length': Buffer.byteLength(material.cert),
      'content-disposition': 'attachment; filename=\"tracelocal-ca.crt\"',
      'cache-control': 'no-store',
    });
    response.end(material.cert);
  }

  private desktopId(fingerprint256: string): string {
    const compact = fingerprint256.replace(/[^A-Fa-f0-9]/g, '').toLowerCase();
    return 'trace-local-' + compact.slice(0, 16);
  }

  private async handleControlRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (method === 'GET' && (await tryServeUiAsset(url.pathname, response))) {
      return;
    }

    if (method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/status')) {
      sendJson(response, 200, this.status);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/events') {
      this.openEventStream(request, response);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/export/har') {
      const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '500', 10);
      const limit = Number.isFinite(rawLimit) ? Math.max(0, rawLimit) : 500;
      sendJson(response, 200, buildHar(this.store.records(limit)));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/ca') {
      const metadata = this.caMetadata ?? (await this.caManager.metadata());
      this.caMetadata = metadata;
      sendJson(response, 200, metadata);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/ca/cert') {
      const material = await this.caManager.ensure();
      sendText(response, 200, 'application/x-pem-file; charset=utf-8', material.cert);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/ca/trust-probe') {
      const body = asObject(await readJsonBody(request));
      const supplied = typeof body.fingerprint256 === 'string' ? body.fingerprint256.trim() : '';
      const metadata = this.caMetadata ?? (await this.caManager.metadata());
      this.caMetadata = metadata;
      const expected = metadata.fingerprint256;
      const suppliedBytes = Buffer.from(supplied);
      const expectedBytes = Buffer.from(expected);
      const trusted = suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
      sendJson(response, 200, { trusted, fingerprint256: expected, publicCertPath: metadata.publicCertPath });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/devices') { sendJson(response, 200, { devices: this.deviceSessions.list() }); return; }

    if (method === 'DELETE' && url.pathname === '/api/devices') {
      const devices = this.deviceSessions.requestDisconnectAll();
      this.broadcastEvent('devices-changed', { devices: this.deviceSessions.list() });
      sendJson(response, 200, { requested: devices.length, devices });
      return;
    }

    const deviceDeleteMatch = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (method === 'DELETE' && deviceDeleteMatch) {
      const session = this.deviceSessions.requestDisconnect(decodeURIComponent(deviceDeleteMatch[1]));
      if (!session) { sendJson(response, 404, { error: 'device_session_not_found' }); return; }
      this.broadcastEvent('devices-changed', { devices: this.deviceSessions.list() });
      sendJson(response, 200, { requested: true, session });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/pairing/token') {
      const lanAddress = getPrimaryLanAddress();
      const proxyPort = this.proxy?.status.port ?? 0;
      const metadata = this.caMetadata ?? (await this.caManager.metadata());
      this.caMetadata = metadata;

      if (!lanAddress || this.mobileCaPort === 0 || proxyPort === 0) {
        sendJson(response, 503, { error: 'pairing_unavailable', message: 'No LAN-reachable pairing endpoint is available.' });
        return;
      }

      const pairing = this.pairingTokens.create();
      const pairingUrl = 'http://' + lanAddress + ':' + this.mobileCaPort + '/pair/' + pairing.token + '?v=' + PAIRING_PROTOCOL_VERSION;
      const qrSvg = await QRCode.toString(pairingUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 240 });

      sendJson(response, 201, {
        protocolVersion: PAIRING_PROTOCOL_VERSION,
        url: pairingUrl,
        qrSvg,
        expiresAt: pairing.expiresAt,
        ttlSeconds: Math.max(0, Math.floor((pairing.expiresAt - Date.now()) / 1000)),
        desktopId: this.desktopId(metadata.fingerprint256),
        proxyAddress: lanAddress + ':' + proxyPort,
        caFingerprint256: metadata.fingerprint256,
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/ca/mobile-token') {
      const lanAddress = getPrimaryLanAddress();
      if (!lanAddress || this.mobileCaPort === 0) {
        sendJson(response, 503, { error: 'mobile_ca_unavailable', message: 'No LAN-reachable CA setup endpoint is available.' });
        return;
      }
      const token = this.caTokenServer.createToken();
      const lanAddresses = getLanAddresses();
      const proxyHost = lanAddress;
      const proxyPort = this.proxy?.status.port || 0;
      const baseUrl = `http://${proxyHost}:${this.mobileCaPort}`;
      const tokenUrl = `${baseUrl}/ca/${token.token}`;

      sendJson(response, 201, {
        token: token.token,
        url: tokenUrl,
        expiresAt: token.expiresAt,
        ttlSeconds: Math.floor((token.expiresAt - Date.now()) / 1000),
        lanAddresses: lanAddresses.map((addr) => ({
          address: addr.address,
          family: addr.family,
          interface: addr.interface,
        })),
        proxyAddress: `${proxyHost}:${proxyPort}`,
      });
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/ca/')) {
      const token = url.pathname.slice('/ca/'.length);
      if (!this.caTokenServer.validateToken(token)) {
        sendText(response, 404, 'text/plain; charset=utf-8', 'Invalid or expired token');
        return;
      }

      const clientIp = request.socket.remoteAddress || 'unknown';
      this.caTokenServer.trackClient(clientIp);

      const material = await this.caManager.ensure();
      response.writeHead(200, {
        'content-type': 'application/x-pem-file; charset=utf-8',
        'content-length': Buffer.byteLength(material.cert),
        'content-disposition': 'attachment; filename="tracelocal.crt"',
        'cache-control': 'no-store',
      });
      response.end(material.cert);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/ca/mobile-status') {
      const lanAddress = getPrimaryLanAddress();
      const proxyPort = this.proxy?.status.port || 0;
      sendJson(response, 200, {
        activeClients: this.deviceSessions.size,
        proxyActiveClients: this.proxy?.getActiveClientCount() ?? 0,
        devices: this.deviceSessions.list(),
        proxyAddress: lanAddress ? `${lanAddress}:${proxyPort}` : null,
        lanAddresses: getLanAddresses().map((addr) => ({
          address: addr.address,
          family: addr.family,
        })),
      });
      return;
    }

    if (url.pathname === '/api/sessions' && method === 'GET') {
      const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
      const limit = Number.isFinite(rawLimit) ? Math.max(0, rawLimit) : 100;
      sendJson(response, 200, { sessions: this.store.list(limit), total: this.store.size });
      return;
    }

    if (url.pathname === '/api/sessions' && method === 'DELETE') {
      sendJson(response, 200, { removed: this.store.clear() });
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
      const session = this.store.get(id);
      if (!session) {
        sendJson(response, 404, { error: 'session_not_found', id });
        return;
      }
      sendJson(response, 200, session);
      return;
    }

    if (url.pathname === '/api/rules/export' && method === 'GET') {
      sendJson(response, 200, this.ruleState.document(this.rules.list()));
      return;
    }

    if (url.pathname === '/api/rules/import' && method === 'POST') {
      try {
        const document = parseRuleStateDocument(await readJsonBody(request));
        const rules = await this.persistRuleMutation(() => this.rules.hydrate(document.rules));
        sendJson(response, 200, { imported: rules.length, rules });
      } catch (error) {
        sendJson(response, 400, {
          error: 'invalid_rule_state',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url.pathname === '/api/rules' && method === 'GET') {
      sendJson(response, 200, { rules: this.rules.list() });
      return;
    }

    if (url.pathname === '/api/rules' && method === 'POST') {
      try {
        const input = asObject(await readJsonBody(request)) as unknown as CreateMapRuleInput;
        const rule = await this.persistRuleMutation(() => this.rules.create(input));
        sendJson(response, 201, rule);
      } catch (error) {
        sendJson(response, 400, {
          error: 'invalid_rule',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url.pathname.startsWith('/api/rules/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/rules/'.length));

      if (method === 'PATCH') {
        try {
          const input = asObject(await readJsonBody(request)) as unknown as UpdateMapRuleInput;
          if (!this.rules.get(id)) {
            sendJson(response, 404, { error: 'rule_not_found', id });
            return;
          }
          const rule = await this.persistRuleMutation(() => this.rules.update(id, input)!);
          sendJson(response, 200, rule);
        } catch (error) {
          sendJson(response, 400, {
            error: 'invalid_rule',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (method === 'DELETE') {
        if (!this.rules.get(id)) {
          sendJson(response, 404, { error: 'rule_not_found', id });
          return;
        }
        await this.persistRuleMutation(() => this.rules.delete(id));
        sendJson(response, 200, { deleted: true, id });
        return;
      }
    }

    sendJson(response, 404, { error: 'not_found' });
  }
}

async function runStandalone(): Promise<void> {
  const daemon = new TraceLocalDaemon({
    controlHost: process.env.TRACELOCAL_CONTROL_HOST,
    controlPort: parseNonNegativeInt(process.env.TRACELOCAL_CONTROL_PORT, 4040),
    proxyPort: parseNonNegativeInt(process.env.TRACELOCAL_PROXY_PORT, 8888),
    maxSessions: parseNonNegativeInt(process.env.TRACELOCAL_MAX_SESSIONS, 500),
    maxBodyPreviewBytes: parseNonNegativeInt(
      process.env.TRACELOCAL_BODY_PREVIEW_BYTES,
      64 * 1024,
    ),
    dataDir: process.env.TRACELOCAL_DATA_DIR,
    allowRemote: process.env.TRACELOCAL_ALLOW_REMOTE === '1',
  });

  const status = await daemon.start();
  process.stdout.write(
    `Trace Local daemon running\nControl: http://127.0.0.1:${status.controlPort}\nProxy: ${status.proxy.proxyUrl}\nCA: ${status.proxy.caCertPath}\nState: ${daemon.ruleState.filePath}\n`,
  );

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (require.main === module) {
  void runStandalone().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
