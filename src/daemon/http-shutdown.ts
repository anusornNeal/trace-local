import type http from 'node:http';
import type { Socket } from 'node:net';

const sockets = new WeakMap<http.Server, Set<Socket>>();

export function trackHttpSockets(server: http.Server): void {
  const clients = new Set<Socket>();
  sockets.set(server, clients);
  server.on('connection', (socket) => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
  });
}

export async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      for (const socket of sockets.get(server) ?? []) socket.destroy();
      server.closeAllConnections();
    }, 1_000);
    server.close((error) => {
      clearTimeout(deadline);
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
