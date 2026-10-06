import { spawn } from 'node:child_process';

export interface WindowsFirewallOptions {
  programPath: string;
  scriptPath: string;
  proxyPort: number;
  caPort: number;
  skip?: boolean;
}

export interface WindowsFirewallResult {
  ready: boolean;
  repaired: boolean;
  warning?: string;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      resolve({ code: null, stdout, stderr: stderr || error.message });
    });
    child.once('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function scriptArgs(options: WindowsFirewallOptions, action: 'status' | 'install'): string[] {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    options.scriptPath,
    '-Action',
    action,
    '-ProgramPath',
    options.programPath,
    '-ProxyPort',
    String(options.proxyPort),
    '-CaPort',
    String(options.caPort),
  ];
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function checkStatus(options: WindowsFirewallOptions): Promise<boolean> {
  const result = await runProcess('powershell.exe', scriptArgs(options, 'status'));
  return result.code === 0;
}

async function runElevatedInstall(options: WindowsFirewallOptions): Promise<ProcessResult> {
  const childArgs = scriptArgs(options, 'install').map(psLiteral).join(', ');
  const command = [
    `$p = Start-Process -FilePath 'powershell.exe'`,
    `-ArgumentList @(${childArgs})`,
    '-Verb RunAs -Wait -PassThru;',
    'exit $p.ExitCode',
  ].join(' ');

  return runProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ]);
}

export async function ensureWindowsFirewallReady(
  options: WindowsFirewallOptions,
): Promise<WindowsFirewallResult> {
  if (process.platform !== 'win32' || options.skip) {
    return { ready: true, repaired: false };
  }

  if (await checkStatus(options)) {
    return { ready: true, repaired: false };
  }

  const elevated = await runElevatedInstall(options);
  if (elevated.code !== 0) {
    const details = (elevated.stderr || elevated.stdout).trim();
    return {
      ready: false,
      repaired: false,
      warning: details
        ? `Windows Firewall access was not enabled: ${details}`
        : 'Windows Firewall access was not enabled. Mobile devices may not be able to reach TraceLocal.',
    };
  }

  if (await checkStatus(options)) {
    return { ready: true, repaired: true };
  }

  return {
    ready: false,
    repaired: false,
    warning: 'Windows Firewall access could not be verified after elevation. Mobile devices may not be able to reach TraceLocal.',
  };
}
