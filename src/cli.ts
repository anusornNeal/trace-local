#!/usr/bin/env node

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
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(new URL(path, controlUrl), init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
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
    .action(async (options) => {
      const daemon = new TraceLocalDaemon({
        controlHost: options.controlHost,
        controlPort: options.controlPort,
        proxyHost: options.proxyHost,
        proxyPort: options.proxyPort,
        maxSessions: options.maxSessions,
        maxBodyPreviewBytes: options.bodyPreviewBytes,
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
      const result = await requestJson(options.controlUrl, '/api/sessions', {
        method: 'DELETE',
      });
      console.log(JSON.stringify(result, null, 2));
    });

  await program.parseAsync(process.argv);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
