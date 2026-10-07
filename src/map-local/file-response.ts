import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MapRule } from '../core/types';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

export interface MappedFileResponse {
  body: Buffer;
  contentType: string;
}

function inferInlineContentType(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'application/json; charset=utf-8';
    } catch {}
  }
  return 'text/plain; charset=utf-8';
}

export async function readMappedFile(
  filePath: string,
  explicitContentType?: string,
): Promise<MappedFileResponse> {
  const body = await readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();

  return {
    body,
    contentType:
      explicitContentType?.trim() ||
      CONTENT_TYPES[extension] ||
      'application/octet-stream',
  };
}

export async function readMappedResponse(rule: MapRule): Promise<MappedFileResponse> {
  if (rule.responseBody !== undefined) {
    return {
      body: Buffer.from(rule.responseBody, 'utf8'),
      contentType: rule.contentType?.trim() || inferInlineContentType(rule.responseBody),
    };
  }

  if (rule.filePath) {
    return readMappedFile(rule.filePath, rule.contentType);
  }

  throw new Error('Map Local rule has no response body or file');
}
