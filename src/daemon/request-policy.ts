import type http from 'node:http';

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
}

/** Native clients omit browser headers; browser callers must use this exact listener origin. */
export function requestPolicyError(
  request: http.IncomingMessage,
  port: number,
  configuredHost: string,
): { status: number; error: string } | undefined {
  const authority = request.headers.host;
  if (!authority || /[\s/@?#\\]/.test(authority)
      || request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) {
    return { status: 403, error: 'untrusted_host' };
  }
  let endpoint: URL;
  try {
    endpoint = new URL(`http://${authority}`);
    if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
        || Number(endpoint.port || 80) !== port) throw new Error('invalid authority');
  } catch {
    return { status: 403, error: 'untrusted_host' };
  }
  const trusted = new Set(['127.0.0.1', '::1', 'localhost']);
  const bindHost = normalizeHost(configuredHost);
  if (bindHost !== '0.0.0.0' && bindHost !== '::') trusted.add(bindHost);
  if (request.socket.localAddress) trusted.add(normalizeHost(request.socket.localAddress));
  if (!trusted.has(normalizeHost(endpoint.hostname))) return { status: 403, error: 'untrusted_host' };

  const origin = request.headers.origin;
  if (origin !== undefined && origin !== endpoint.origin) return { status: 403, error: 'untrusted_origin' };
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { status: 403, error: 'untrusted_fetch_site' };

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET')) {
    const contentType = request.headers['content-type'];
    const hasBody = Number(request.headers['content-length'] || 0) > 0 || request.headers['transfer-encoding'] !== undefined;
    if ((hasBody || contentType !== undefined) && contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return { status: 415, error: 'json_content_type_required' };
    }
  }
  return undefined;
}
