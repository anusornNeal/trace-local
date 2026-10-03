import { open, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Do not steal stale locks: doing so races with other processes and can split the CA identity. */
export async function withCertificateInitializationLock<T>(
  directory: string,
  initialize: () => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, '.ca-initialize.lock');
  const deadline = Date.now() + timeoutMs;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`CA initialization is locked at ${lockPath}. Stop other Trace Local processes using this data directory. If a previous process crashed, remove this lock only after those processes have stopped.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, owner: randomUUID(), createdAt: new Date().toISOString() }));
    return await initialize();
  } finally {
    try { await handle.close(); }
    finally { await rm(lockPath, { force: true }); }
  }
}
