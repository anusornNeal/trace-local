#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TraceLocalDaemon } from './daemon/server';

function intOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }
  return parsed;
}

async function request(
  controlUrl: string,
  requestPath: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(new URL(requestPath, controlUrl), init);
  if (!response.ok) {
    const text = await response.text();
    let message = `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload && typeof payload === 'object' && 'message' in payload) {
        message = String((payload as { message: unknown }).message);
      } else if (payload && typeof payload === 'object' && 'error' in payload) {
        message = String((payload as { error: unknown }).error);
      }
    } catch {
      if (text) {
        message = text;
      }
    }
    throw new Error(message);
  }
  return response;
}

async function requestJson(
  controlUrl: string,
  requestPath: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await request(controlUrl, requestPath, init);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function trustInstructions(certPath: string): string[] {
  if (process.platform === 'win32') {
    return [
      'Windows Current User trust store (run only if you intend to trust Trace Local):',
      `certutil -user -addstore Root "${certPath}"`,
    ];
  }

  if (process.platform === 'darwin') {
    return [
      'macOS login keychain (run only if you intend to trust Trace Local):',
      `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certPath}"`,
    ];
  }

  return [
    'Linux system trust (distribution-specific; run only if you intend to trust Trace Local):',
    `sudo cp "${certPath}" /usr/local/share/ca-certificates/tracelocal.crt`,
    'sudo update-ca-certificates',
  ];
}

async function main(): Promise<void> {
  const { Command } = await import('commander');
  const program = new Command();

  program
    .name('tracelocal')
    .description('Local HTTP/HTTPS traffic inspector and Map Local proxy')
    .version('0.1.0');

  program
    .command('start')
    .description('Start the Trace Local daemon and intercepting proxy')
    .option('--control-host <host>', 'control API bind host', '127.0.0.1')
    .option('--control-port <port>', 'control API port', intOption, 4040)
    .option('--proxy-port <port>', 'HTTP/HTTPS proxy port', intOption, 8888)
    .option('--max-sessions <count>', 'maximum captures kept in memory', intOption, 500)
    .option('--body-preview-bytes <count>', 'maximum preview bytes per body', intOption, 64 * 1024)
    .option('--data-dir <path>', 'Trace Local data directory')
    .option('--allow-remote', 'allow LAN/non-loopback clients; disabled by default')
    .action(async (options) => {
      const daemon = new TraceLocalDaemon({
        controlHost: options.controlHost,
        controlPort: options.controlPort,
        proxyPort: options.proxyPort,
        maxSessions: options.maxSessions,
        maxBodyPreviewBytes: options.bodyPreviewBytes,
        dataDir: options.dataDir ? path.resolve(options.dataDir) : undefined,
        allowRemote: Boolean(options.allowRemote),
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

  program
    .command('export-har')
    .argument('[file]', 'optional destination HAR file')
    .description('Export captured traffic as HAR 1.2')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .option('--limit <count>', 'maximum captures to export', intOption, 500)
    .action(async (file, options) => {
      const result = await requestJson(
        options.controlUrl,
        `/api/export/har?limit=${encodeURIComponent(String(options.limit))}`,
      );
      const output = `${JSON.stringify(result, null, 2)}\n`;

      if (file) {
        const destination = path.resolve(file);
        await writeFile(destination, output, 'utf8');
        console.log(destination);
      } else {
        process.stdout.write(output);
      }
    });

  const map = program.command('map').description('Manage Map Local rules');

  map
    .command('list')
    .description('List Map Local rules')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (options) => {
      const result = await requestJson(options.controlUrl, '/api/rules');
      console.log(JSON.stringify(result, null, 2));
    });

  map
    .command('export')
    .argument('[file]', 'optional destination JSON file')
    .description('Export versioned Map Local rule state')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (file, options) => {
      const result = await requestJson(options.controlUrl, '/api/rules/export');
      const output = `${JSON.stringify(result, null, 2)}\n`;

      if (file) {
        const destination = path.resolve(file);
        await writeFile(destination, output, 'utf8');
        console.log(destination);
      } else {
        process.stdout.write(output);
      }
    });

  map
    .command('import')
    .argument('<file>', 'versioned Map Local rule state JSON')
    .description('Replace Map Local rules from an exported state file')
    .requiredOption('--replace', 'confirm replacing the current rule set')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (file, options) => {
      const source = path.resolve(file);
      const document = JSON.parse(await readFile(source, 'utf8'));
      const result = await requestJson(
        options.controlUrl,
        '/api/rules/import',
        jsonRequest('POST', document),
      );
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

  const devices = program.command('devices').description('Inspect and disconnect paired devices');

  devices
    .command('list')
    .description('List paired/connected device sessions')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .option('--json', 'emit compact machine-readable JSON')
    .action(async (options) => {
      const result = await requestJson(options.controlUrl, '/api/devices');
      const output = options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2);
      process.stdout.write(output + '\n');
    });

  devices
    .command('disconnect')
    .argument('[id]', 'device session id')
    .description('Request one device, or all devices, to stop tunneling and restore normal routing')
    .option('--all', 'disconnect all paired device sessions')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .option('--json', 'emit compact machine-readable JSON')
    .action(async (id, options) => {
      if (Boolean(options.all) === Boolean(id)) {
        throw new Error('Specify exactly one device session id or --all');
      }

      const requestPath = options.all
        ? '/api/devices'
        : '/api/devices/' + encodeURIComponent(String(id));
      const result = await requestJson(options.controlUrl, requestPath, jsonRequest('DELETE'));
      const output = options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2);
      process.stdout.write(output + '\n');
    });

  const ca = program.command('ca').description('Inspect the local HTTPS interception CA');

  ca
    .command('status')
    .description('Show public CA metadata')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (options) => {
      console.log(JSON.stringify(await requestJson(options.controlUrl, '/api/ca'), null, 2));
    });

  ca
    .command('path')
    .description('Print the public CA certificate path')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (options) => {
      const metadata = (await requestJson(options.controlUrl, '/api/ca')) as {
        certPath: string;
      };
      console.log(metadata.certPath);
    });

  ca
    .command('cert')
    .description('Print the public CA certificate PEM')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (options) => {
      const response = await request(options.controlUrl, '/api/ca/cert');
      process.stdout.write(await response.text());
    });

  ca
    .command('instructions')
    .description('Print manual OS trust installation guidance; does not install anything')
    .option('--control-url <url>', 'daemon control URL', 'http://127.0.0.1:4040')
    .action(async (options) => {
      const metadata = (await requestJson(options.controlUrl, '/api/ca')) as {
        certPath: string;
      };
      console.log(trustInstructions(metadata.certPath).join('\n'));
    });

  await program.parseAsync(process.argv);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
