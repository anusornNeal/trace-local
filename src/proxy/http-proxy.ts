import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BodyPreviewCollector } from '../core/body-preview';
import { SessionStore } from '../core/session-store';
import type { ProxyStatus, SessionRecord } from '../core/types';
import { readMappedFile } from '../map-local/file-response';
import { MapRuleStore } from '../map-local/rule-store';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function connectionScopedHeaders(headers: http.IncomingHttpHeaders): Set<string> {
  const values = headers.connection;
  const joined = Array.isArray(values) ? values.join(',') : values ?? '';
  return new Set(
    joined
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function sanitizeHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const dynamicHopByHop = connectionScopedHeaders(headers);
  const result: http.OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(normalized) && !dynamicHopByHop.has(normalized)) {
      result[name] = value;
    }
  }

  return result;
}

function copyHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  return { ...headers };
}

function resolveTarget(request: http.IncomingMessage): URL {
  const rawUrl = request.url ?? '/';
  if (/^https?:\/\//i.test(rawUrl)) {
    return new URL(rawUrl);
  }

  const host = request.headers.host;
  if (!host) {
    throw new Error('Missing Host header');
  }

  return new URL(rawUrl, `http://${host}`);
}

export interface HttpCaptureProxyOptions {
  host?: string;
  port?: number;
  maxBodyPreviewBytes?: number;
  upstreamTimeoutMs?: number;
  ruleStore?: MapRuleStore;
}

interface CapturedResponse {
  statusCode?: number;
  statusMessage?: string;
  headers: http.IncomingHttpHeaders;
}

export class HttpCaptureProxy {
  private server?: http.Server;
  private currentStatus: ProxyStatus = {
    running: false,
    port: 0,
    proxyUrl: null,
    caCertPath: '',
  };

  constructor(
    private readonly store: SessionStore,
    private readonly options: HttpCaptureProxyOptions = {},
  ) {}

  get status(): ProxyStatus {
    return { ...this.currentStatus };
  }

  async start(): Promise<ProxyStatus> {
    if (this.server) {
      return this.status;
    }

    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? 8888;

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    this.server.on('connect', (_request, socket) => {
      socket.end('HTTP/1.1 501 Not Implemented\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nHTTPS CONNECT is not supported in Trace Local MVP 1.\n');
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

    const address = this.server.address() as AddressInfo;
    this.currentStatus = {
      running: true,
      port: address.port,
      proxyUrl: `http://${host}:${address.port}`,
      caCertPath: '',
    };

    return this.status;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    this.currentStatus = {
      ...this.currentStatus,
      running: false,
      proxyUrl: null,
    };
  }

  private async handleRequest(
    request: http.IncomingMessage,
    clientResponse: http.ServerResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    const requestBody = new BodyPreviewCollector(this.options.maxBodyPreviewBytes);
    const responseBody = new BodyPreviewCollector(this.options.maxBodyPreviewBytes);

    let target: URL;
    try {
      target = resolveTarget(request);
    } catch (error) {
      clientResponse.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      clientResponse.end('Invalid proxy request');
      return;
    }

    if (target.protocol !== 'http:') {
      clientResponse.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' });
      clientResponse.end('Only HTTP forwarding is supported in Trace Local MVP 1');
      return;
    }

    const id = randomUUID();
    let completed = false;

    const finalize = (
      response?: CapturedResponse,
      error?: Error,
      mapRuleId?: string,
    ) => {
      if (completed) {
        return;
      }
      completed = true;

      const completedAt = Date.now();
      const requestPreview = requestBody.snapshot(
        request.headers['content-type'],
        request.headers['content-encoding'],
      );
      const responsePreview = responseBody.snapshot(
        response?.headers['content-type'],
        response?.headers['content-encoding'],
      );

      const record: SessionRecord = {
        id,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        protocol: target.protocol.replace(':', ''),
        httpVersion: request.httpVersion,
        method: request.method ?? 'GET',
        url: target.toString(),
        host: target.host,
        path: `${target.pathname}${target.search}`,
        statusCode: response?.statusCode,
        statusMessage: response?.statusMessage,
        requestHeaders: copyHeaders(request.headers),
        responseHeaders: response ? copyHeaders(response.headers) : undefined,
        requestBody: requestPreview.body,
        responseBody: responsePreview.body,
        requestBodyBytes: requestPreview.totalBytes,
        responseBodyBytes: responsePreview.totalBytes,
        requestBodyEncoding: requestPreview.encoding,
        responseBodyEncoding: responsePreview.encoding,
        mapped: Boolean(mapRuleId),
        mapRuleId,
        error: error?.message,
      };

      this.store.add(record);
    };

    request.on('data', (chunk: Buffer) => requestBody.append(chunk));

    const matchedRule = this.options.ruleStore?.findMatch({
      method: request.method ?? 'GET',
      url: target.toString(),
      host: target.host,
      path: `${target.pathname}${target.search}`,
    });

    if (matchedRule) {
      const finalizeMappedError = (error: Error) => {
        if (!clientResponse.headersSent) {
          const diagnostic = Buffer.from(`Map Local failed: ${error.message}\n`);
          responseBody.append(diagnostic);
          const headers = {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': String(diagnostic.length),
          };
          clientResponse.writeHead(500, headers);
          clientResponse.end(diagnostic);
          finalize(
            { statusCode: 500, statusMessage: 'Map Local Error', headers },
            error,
            matchedRule.id,
          );
        } else {
          clientResponse.destroy(error);
          finalize(undefined, error, matchedRule.id);
        }
      };

      request.once('end', () => {
        void (async () => {
          try {
            const mapped = await readMappedFile(matchedRule.filePath, matchedRule.contentType);
            responseBody.append(mapped.body);
            const headers = {
              'content-type': mapped.contentType,
              'content-length': String(mapped.body.length),
              'x-tracelocal-map-rule': matchedRule.id,
            };

            clientResponse.writeHead(matchedRule.statusCode, headers);
            clientResponse.end(mapped.body);
            finalize(
              {
                statusCode: matchedRule.statusCode,
                statusMessage: 'Mapped',
                headers,
              },
              undefined,
              matchedRule.id,
            );
          } catch (error) {
            finalizeMappedError(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        })();
      });

      request.once('aborted', () => {
        finalizeMappedError(new Error('Client request aborted before Map Local response'));
      });
      request.once('error', (error) => {
        finalizeMappedError(error);
      });
      return;
    }

    const upstreamRequest = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 80,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: {
          ...sanitizeHeaders(request.headers),
          host: target.host,
        },
      },
      (upstreamResponse) => {
        const responseHeaders = sanitizeHeaders(upstreamResponse.headers);
        clientResponse.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          responseHeaders,
        );

        upstreamResponse.on('data', (chunk: Buffer) => responseBody.append(chunk));
        upstreamResponse.on('end', () => finalize(upstreamResponse));
        upstreamResponse.on('aborted', () => {
          const error = new Error('Upstream response aborted');
          finalize(upstreamResponse, error);
          clientResponse.destroy(error);
        });
        upstreamResponse.on('close', () => {
          if (!upstreamResponse.complete) {
            const error = new Error('Upstream response closed before completion');
            finalize(upstreamResponse, error);
            clientResponse.destroy(error);
          }
        });
        upstreamResponse.on('error', (error) => {
          finalize(upstreamResponse, error);
          clientResponse.destroy(error);
        });
        upstreamResponse.pipe(clientResponse);
      },
    );

    const upstreamTimeoutMs = this.options.upstreamTimeoutMs ?? 30_000;
    if (upstreamTimeoutMs > 0) {
      upstreamRequest.setTimeout(upstreamTimeoutMs, () => {
        upstreamRequest.destroy(
          new Error(`Upstream request timed out after ${upstreamTimeoutMs}ms`),
        );
      });
    }

    upstreamRequest.on('error', (error) => {
      finalize(undefined, error);
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      if (!clientResponse.writableEnded) {
        clientResponse.end('Upstream request failed');
      }
    });

    request.on('aborted', () => {
      const error = new Error('Client request aborted');
      upstreamRequest.destroy(error);
      finalize(undefined, error);
    });

    request.on('error', (error) => {
      upstreamRequest.destroy(error);
      finalize(undefined, error);
    });

    clientResponse.on('close', () => {
      if (!clientResponse.writableEnded && !completed) {
        const error = new Error('Client response closed before completion');
        upstreamRequest.destroy(error);
        finalize(undefined, error);
      }
    });

    request.pipe(upstreamRequest);
  }
}
