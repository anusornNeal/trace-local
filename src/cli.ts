#!/usr/bin/env node

import path from 'node:path';
import { TraceLocalDaemon } from './daemon/server';

function intOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }
  return parsed;
}

async function requestJson(
  controlUrl: string,
  requestPath: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(new URL(requestPath, controlUrl), init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

async function main(): Promise<void> {
  const { Command } = await import('commander');
  const program = new Command();

  program
    .name('tracelocal')
    .description('Local HTTP traffic inspector and Map Local proxy')
    .version('0.1.0');

  program
    .command('start')
    .description('Start the Trace Local daemon and HTTP proxy')
    .option('--control-host <host>', 'control API bind host', '127.0.0.1')
    .option('--control-port <port>', 'control API port', intOption, 4040)
    .option('--proxy-host <host>', 'proxy bind host', '127.0.0.1')
    .option('--proxy-port <port>', 'proxy port', intOption, 8888)
    .option('--max-sessions <count>', 'maximum captures kept in memory', intOption, 500)
    .option('--body-preview-bytes <count>', 'maximum preview bytes per body', intOption, 64 * 1024)
    .option('--upstream-timeout-ms <ms>', 'upstream request timeout', intOption, 30_000)
    .action(async (options) => {
      const daemon = new TraceLocalDaemon({
        controlHost: options.controlHost,
        controlPort: options.controlPort,
        proxyHost: options.proxyHost,
        proxyPort: options.proxyPort,
        maxSessions: options.maxSessions,
        maxBodyPreviewBytes: options.bodyPreviewBytes,
        upstreamTimeoutMs: options.upstreamTimeoutMs,
      });

      const status = await daemon.start();
      console.log(JSON.stringify(status, null, 2));

      const stop = async () => {
        await daemon.stop();
        process.exit(0);
      };
      process.once('SIGINT', () => void stop());
      process.once('SIGTERM', () => void stop());

      await new Promise<void>(() => undefined);
    });

  program
    .command('list')
    .description('List captured sessions')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .option('--limit <count>', 'maximum sessions to return', intOption, 50)
    .action(async (options) => {
      const result = await requestJson(
        options.controlUrl,
        `/api/sessions?limit=${encodeURIComponent(String(options.limit))}`,
      );
      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command('show')
    .argument('<id>', 'capture session id')
    .description('Show one captured session')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (id, options) => {
      const result = await requestJson(
        options.controlUrl,
        `/api/sessions/${encodeURIComponent(id)}`,
      );
      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command('clear')
    .description('Clear captured sessions')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (options) => {
      const result = await requestJson(
        options.controlUrl,
        '/api/sessions',
        jsonRequest('DELETE'),
      );
      console.log(JSON.stringify(result, null, 2));
    });

  const map = program
    .command('map')
    .description('Manage Map Local rules');

  map
    .command('list')
    .description('List Map Local rules')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (options) => {
      const result = await requestJson(options.controlUrl, '/api/rules');
      console.log(JSON.stringify(result, null, 2));
    });

  map
    .command('add')
    .argument('<pattern>', 'glob pattern to match')
    .argument('<file>', 'local response file')
    .description('Add a Map Local rule')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .option('--target <target>', 'url, host, or path', 'url')
    .option('--method <method>', 'HTTP method or *', '*')
    .option('--status <code>', 'response status code', intOption, 200)
    .option('--content-type <value>', 'override response content type')
    .option('--disabled', 'create the rule disabled')
    .action(async (patternValue, file, options) => {
      const result = await requestJson(
        options.controlUrl,
        '/api/rules',
        jsonRequest('POST', {
          pattern: patternValue,
          filePath: path.resolve(file),
          target: options.target,
          method: options.method,
          statusCode: options.status,
          contentType: options.contentType,
          enabled: options.disabled ? false : true,
        }),
      );
      console.log(JSON.stringify(result, null, 2));
    });

  map
    .command('remove')
    .argument('<id>', 'rule id')
    .description('Remove a Map Local rule')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (id, options) => {
      const result = await requestJson(
        options.controlUrl,
        `/api/rules/${encodeURIComponent(id)}`,
        jsonRequest('DELETE'),
      );
      console.log(JSON.stringify(result, null, 2));
    });

  for (const enabled of [true, false]) {
    map
      .command(enabled ? 'enable' : 'disable')
      .argument('<id>', 'rule id')
      .description(`${enabled ? 'Enable' : 'Disable'} a Map Local rule`)
      .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
      .action(async (id, options) => {
        const result = await requestJson(
          options.controlUrl,
          `/api/rules/${encodeURIComponent(id)}`,
          jsonRequest('PATCH', { enabled }),
        );
        console.log(JSON.stringify(result, null, 2));
      });
  }

  await program.parseAsync(process.argv);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
