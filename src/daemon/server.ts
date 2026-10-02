import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CertificateAuthorityManager,
  type CertificateAuthorityMetadata,
} from '../certificates/ca-manager';
import { SessionStore } from '../core/session-store';
import type {
  CreateMapRuleInput,
  DaemonStatus,
  UpdateMapRuleInput,
} from '../core/types';
import { MapRuleStore } from '../map-local/rule-store';
import { InterceptProxy } from '../proxy/intercept-proxy';

const VERSION = '0.1.0';
const MAX_CONTROL_BODY_BYTES = 64 * 1024;

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
  if (value === undefined) {
    return fallback;
  }
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

  if (totalBytes === 0) {
    return {};
  }

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

export class TraceLocalDaemon {
  readonly store: SessionStore;
  readonly rules: MapRuleStore;
  readonly caManager: CertificateAuthorityManager;
  proxy?: InterceptProxy;

  private controlServer?: http.Server;
  private controlPort = 0;
  private caMetadata?: CertificateAuthorityMetadata;

  constructor(private readonly options: TraceLocalDaemonOptions = {}) {
    this.store = new SessionStore(options.maxSessions ?? 500);
    this.rules = new MapRuleStore();
    this.caManager = new CertificateAuthorityManager(options.dataDir);
  }

  get status(): DaemonStatus {
    return {
      version: VERSION,
      controlPort: this.controlPort,
      proxy: this.proxy?.status ?? {
        running: false,
        port: 0,
        proxyUrl: null,
        caCertPath: this.caManager.certPath,
      },
      sessions: this.store.size,
      rules: this.rules.size,
    };
  }

  async start(): Promise<DaemonStatus> {
    if (this.controlServer && this.proxy) {
      return this.status;
    }

    const ca = await this.caManager.ensure();
    this.caMetadata = {
      certPath: ca.certPath,
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
    return this.status;
  }

  async stop(): Promise<void> {
    const controlServer = this.controlServer;
    const proxy = this.proxy;
    this.controlServer = undefined;
    this.proxy = undefined;

    if (controlServer) {
      await new Promise<void>((resolve, reject) => {
        controlServer.close((error) => (error ? reject(error) : resolve()));
      });
    }

    if (proxy) {
      await proxy.stop();
    }
    this.controlPort = 0;
  }

  private async refreshProxyRules(): Promise<void> {
    await this.proxy?.refreshRules();
  }

  private async handleControlRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/status')) {
      sendJson(response, 200, this.status);
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

    if (url.pathname === '/api/sessions' && method === 'GET') {
      const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
      const limit = Number.isFinite(rawLimit) ? Math.max(0, rawLimit) : 100;
      sendJson(response, 200, {
        sessions: this.store.list(limit),
        total: this.store.size,
      });
      return;
    }

    if (url.pathname === '/api/sessions' && method === 'DELETE') {
      const removed = this.store.clear();
      sendJson(response, 200, { removed });
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

    if (url.pathname === '/api/rules' && method === 'GET') {
      sendJson(response, 200, { rules: this.rules.list() });
      return;
    }

    if (url.pathname === '/api/rules' && method === 'POST') {
      try {
        const input = asObject(await readJsonBody(request)) as unknown as CreateMapRuleInput;
        const rule = this.rules.create(input);
        await this.refreshProxyRules();
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
          const rule = this.rules.update(id, input);
          if (!rule) {
            sendJson(response, 404, { error: 'rule_not_found', id });
            return;
          }
          await this.refreshProxyRules();
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
        if (!this.rules.delete(id)) {
          sendJson(response, 404, { error: 'rule_not_found', id });
          return;
        }
        await this.refreshProxyRules();
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
    `Trace Local daemon running\nControl: http://127.0.0.1:${status.controlPort}\nProxy: ${status.proxy.proxyUrl}\nCA: ${status.proxy.caCertPath}\n`,
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
