import type { SessionRecord } from '../core/types';

function harHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Array<{ name: string; value: string }> {
  if (!headers) return [];

  return Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => ({ name, value: String(item) }));
  });
}

function httpVersion(value: string): string {
  if (/^HTTP\//i.test(value)) return value;
  return `HTTP/${value || '1.1'}`;
}

function queryString(url: string): Array<{ name: string; value: string }> {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function buildEntry(record: SessionRecord): Record<string, unknown> {
  const duration = Math.max(0, record.durationMs ?? 0);
  const requestMimeType = headerValue(record.requestHeaders, 'content-type') ?? '';
  const responseMimeType = headerValue(record.responseHeaders, 'content-type') ?? '';

  const request: Record<string, unknown> = {
    method: record.method,
    url: record.url,
    httpVersion: httpVersion(record.httpVersion),
    cookies: [],
    headers: harHeaders(record.requestHeaders),
    queryString: queryString(record.url),
    headersSize: -1,
    bodySize: record.requestBodyBytes,
  };

  if (record.requestBody !== null && record.requestBody !== undefined) {
    request.postData = {
      mimeType: requestMimeType,
      text: record.requestBody,
      ...(record.requestBodyEncoding === 'binary' ? { encoding: 'base64' } : {}),
    };
  }

  const content: Record<string, unknown> = {
    size: record.responseBodyBytes ?? 0,
    mimeType: responseMimeType,
  };

  if (record.responseBody !== null && record.responseBody !== undefined) {
    content.text = record.responseBody;
    if (record.responseBodyEncoding === 'binary') {
      content.encoding = 'base64';
    }
  }

  return {
    startedDateTime: new Date(record.startedAt).toISOString(),
    time: duration,
    request,
    response: {
      status: record.statusCode ?? 0,
      statusText: record.statusMessage ?? '',
      httpVersion: httpVersion(record.httpVersion),
      cookies: [],
      headers: harHeaders(record.responseHeaders),
      content,
      redirectURL: headerValue(record.responseHeaders, 'location') ?? '',
      headersSize: -1,
      bodySize: record.responseBodyBytes ?? -1,
    },
    cache: {},
    timings: {
      send: 0,
      wait: duration,
      receive: 0,
    },
    comment: record.error
      ? `Trace Local error: ${record.error}`
      : record.mapped
        ? `Trace Local Map Local rule: ${record.mapRuleId ?? 'unknown'}`
        : '',
    _traceLocal: {
      id: record.id,
      protocol: record.protocol,
      mapped: record.mapped,
      mapRuleId: record.mapRuleId,
      error: record.error,
    },
  };
}

export function buildHar(records: SessionRecord[]): Record<string, unknown> {
  const ordered = [...records].sort((a, b) => a.startedAt - b.startedAt);

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'Trace Local',
        version: '0.1.0',
      },
      entries: ordered.map(buildEntry),
    },
  };
}
