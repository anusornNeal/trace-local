import { Buffer } from 'node:buffer';
import type {
  AbortedRequest,
  BodyData,
  CompletedRequest,
  CompletedResponse,
  InitiatedRequest,
  InitiatedResponse,
  Mockttp,
} from 'mockttp';
import { BodyPreviewCollector } from '../core/body-preview';
import { SessionStore } from '../core/session-store';
import type { ProxyStatus, SessionRecord } from '../core/types';
import type { CertificateAuthorityMaterial } from '../certificates/ca-manager';
import { readMappedFile } from '../map-local/file-response';
import { matchesMapRule } from '../map-local/matcher';
import { MapRuleStore } from '../map-local/rule-store';

interface CaptureState {
  request: InitiatedRequest;
  requestBody: BodyPreviewCollector;
  responseBody: BodyPreviewCollector;
  response?: InitiatedResponse;
  mapRuleId?: string;
}

export interface InterceptProxyOptions {
  port?: number;
  maxBodyPreviewBytes?: number;
  ruleStore: MapRuleStore;
  ca: CertificateAuthorityMaterial;
  allowRemote?: boolean;
  additionalTrustedCaCerts?: string[];
}

function cloneHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  return { ...headers };
}

function isLoopback(remoteIpAddress: string | undefined): boolean {
  if (!remoteIpAddress) {
    return false;
  }

  const normalized = remoteIpAddress.toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1'
  );
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export class InterceptProxy {
  private server?: Mockttp;
  private currentStatus: ProxyStatus;
  private readonly captures = new Map<string, CaptureState>();
  private readonly endpointToMapRule = new Map<string, string>();
  private readonly mapErrors = new Map<string, string>();
  private refreshChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SessionStore,
    private readonly options: InterceptProxyOptions,
  ) {
    this.currentStatus = {
      running: false,
      port: 0,
      proxyUrl: null,
      caCertPath: options.ca.certPath,
    };
  }

  get status(): ProxyStatus {
    return { ...this.currentStatus };
  }

  async start(): Promise<ProxyStatus> {
    if (this.server) {
      return this.status;
    }

    const { getLocal } = await import('mockttp');
    const server = getLocal({
      https: {
        key: this.options.ca.key,
        cert: this.options.ca.cert,
      },
      http2: 'fallback',
      recordTraffic: false,
      maxBodySize: this.options.maxBodyPreviewBytes ?? 64 * 1024,
      suggestChanges: false,
    });

    await server.start(this.options.port ?? 8888);
    this.server = server;
    await this.applyRulesAndSubscriptions();

    this.currentStatus = {
      running: true,
      port: server.port,
      proxyUrl: `http://127.0.0.1:${server.port}`,
      caCertPath: this.options.ca.certPath,
    };

    return this.status;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await server.stop();
    }
    this.captures.clear();
    this.endpointToMapRule.clear();
    this.mapErrors.clear();
    this.currentStatus = {
      ...this.currentStatus,
      running: false,
      proxyUrl: null,
    };
  }

  async refreshRules(): Promise<void> {
    this.refreshChain = this.refreshChain.then(async () => {
      if (!this.server) {
        return;
      }
      await this.applyRulesAndSubscriptions();
    });
    return this.refreshChain;
  }

  private async applyRulesAndSubscriptions(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    server.reset();
    this.endpointToMapRule.clear();
    await this.subscribeCaptureEvents(server);

    if (!this.options.allowRemote) {
      await server
        .forAnyRequest()
        .matching((request) => !isLoopback(request.remoteIpAddress))
        .thenReply(
          403,
          'Trace Local proxy only accepts local clients by default. Start with --allow-remote to accept LAN clients.',
          { 'content-type': 'text/plain; charset=utf-8' },
        );
    }

    for (const rule of this.options.ruleStore.list()) {
      if (!rule.enabled) {
        continue;
      }

      const endpoint = await server
        .forAnyRequest()
        .matching((request) =>
          matchesMapRule(rule, {
            method: request.method,
            url: request.url,
            host: hostFromUrl(request.url),
            path: request.path,
          }),
        )
        .thenCallback(async (request) => {
          try {
            const mapped = await readMappedFile(rule.filePath, rule.contentType);
            return {
              statusCode: rule.statusCode,
              statusMessage: 'Mapped',
              headers: {
                'content-type': mapped.contentType,
                'x-tracelocal-map-rule': rule.id,
              },
              body: mapped.body,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.mapErrors.set(request.id, message);
            return {
              statusCode: 500,
              statusMessage: 'Map Local Error',
              headers: {
                'content-type': 'text/plain; charset=utf-8',
                'x-tracelocal-map-rule': rule.id,
              },
              body: `Map Local failed: ${message}\n`,
            };
          }
        });

      this.endpointToMapRule.set(endpoint.id, rule.id);
    }

    await server.forAnyRequest().thenPassThrough({
      additionalTrustedCAs: this.options.additionalTrustedCaCerts?.map((cert) => ({ cert })),
    });
  }

  private async subscribeCaptureEvents(server: Mockttp): Promise<void> {
    await server.on('request-initiated', (request) => {
      this.captures.set(request.id, {
        request,
        requestBody: new BodyPreviewCollector(this.options.maxBodyPreviewBytes),
        responseBody: new BodyPreviewCollector(this.options.maxBodyPreviewBytes),
      });
    });

    await server.on('request-body-data', (data: BodyData) => {
      this.captures.get(data.id)?.requestBody.append(Buffer.from(data.content));
    });

    await server.on('request', (request: CompletedRequest) => {
      let state = this.captures.get(request.id);
      if (!state) {
        state = {
          request,
          requestBody: new BodyPreviewCollector(this.options.maxBodyPreviewBytes),
          responseBody: new BodyPreviewCollector(this.options.maxBodyPreviewBytes),
        };
        if (request.body.buffer.length > 0) {
          state.requestBody.append(request.body.buffer);
        }
        this.captures.set(request.id, state);
      } else {
        state.request = request;
      }

      if (request.matchedRuleId) {
        state.mapRuleId = this.endpointToMapRule.get(request.matchedRuleId);
      }
    });

    await server.on('response-initiated', (response: InitiatedResponse) => {
      const state = this.captures.get(response.id);
      if (state) {
        state.response = response;
      }
    });

    await server.on('response-body-data', (data: BodyData) => {
      this.captures.get(data.id)?.responseBody.append(Buffer.from(data.content));
    });

    await server.on('response', (response: CompletedResponse) => {
      const state = this.captures.get(response.id);
      if (!state) {
        return;
      }
      state.response = response;
      this.finalizeCapture(response.id);
    });

    await server.on('abort', (request: AbortedRequest) => {
      let state = this.captures.get(request.id);
      if (!state) {
        state = {
          request,
          requestBody: new BodyPreviewCollector(this.options.maxBodyPreviewBytes),
          responseBody: new BodyPreviewCollector(this.options.maxBodyPreviewBytes),
        };
        this.captures.set(request.id, state);
      }
      this.finalizeCapture(
        request.id,
        request.error?.message || request.error?.code || 'Request aborted',
      );
    });
  }

  private finalizeCapture(id: string, explicitError?: string): void {
    const state = this.captures.get(id);
    if (!state) {
      return;
    }

    const request = state.request;
    const response = state.response;
    const completedAt = Date.now();
    const startedAt = request.timingEvents.startTime || completedAt;
    const requestPreview = state.requestBody.snapshot(
      request.headers['content-type'],
      request.headers['content-encoding'],
    );
    const responsePreview = state.responseBody.snapshot(
      response?.headers['content-type'],
      response?.headers['content-encoding'],
    );

    const mapError = this.mapErrors.get(id);
    const record: SessionRecord = {
      id,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      protocol: request.protocol,
      httpVersion: request.httpVersion,
      method: request.method,
      url: request.url,
      host: hostFromUrl(request.url),
      path: request.path,
      statusCode: response?.statusCode,
      statusMessage: response?.statusMessage,
      requestHeaders: cloneHeaders(request.headers),
      responseHeaders: response ? cloneHeaders(response.headers) : undefined,
      requestBody: requestPreview.body,
      responseBody: responsePreview.body,
      requestBodyBytes: requestPreview.totalBytes,
      responseBodyBytes: responsePreview.totalBytes,
      requestBodyEncoding: requestPreview.encoding,
      responseBodyEncoding: responsePreview.encoding,
      mapped: Boolean(state.mapRuleId),
      mapRuleId: state.mapRuleId,
      error: explicitError || mapError,
    };

    this.store.add(record);
    this.captures.delete(id);
    this.mapErrors.delete(id);
  }
}
