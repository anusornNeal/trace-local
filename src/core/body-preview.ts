import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export interface BodyPreviewSnapshot {
  body: string | null;
  totalBytes: number;
  encoding?: 'text' | 'binary';
  truncated: boolean;
}

const TEXT_CONTENT_TYPE = /^(text\/|application\/(json|.*\+json|xml|.*\+xml|x-www-form-urlencoded|javascript|graphql))/i;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decompressPreview(
  buffer: Buffer,
  contentEncoding: string | undefined,
  maxOutputLength: number,
): Buffer | null {
  if (!contentEncoding || contentEncoding === 'identity') return buffer;

  try {
    if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
      return gunzipSync(buffer, { maxOutputLength });
    }
    if (contentEncoding === 'deflate') {
      return inflateSync(buffer, { maxOutputLength });
    }
    if (contentEncoding === 'br') {
      return brotliDecompressSync(buffer, { maxOutputLength });
    }
  } catch {
    return null;
  }

  return null;
}

export class BodyPreviewCollector {
  private readonly chunks: Buffer[] = [];
  private previewBytes = 0;
  private totalBytes = 0;

  constructor(private readonly maxPreviewBytes = 64 * 1024) {
    if (!Number.isInteger(maxPreviewBytes) || maxPreviewBytes < 0) {
      throw new Error('maxPreviewBytes must be a non-negative integer');
    }
  }

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += buffer.length;

    const remaining = this.maxPreviewBytes - this.previewBytes;
    if (remaining <= 0) {
      return;
    }

    const previewChunk = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
    this.chunks.push(Buffer.from(previewChunk));
    this.previewBytes += previewChunk.length;
  }

  snapshot(
    contentTypeHeader?: string | string[],
    contentEncodingHeader?: string | string[],
  ): BodyPreviewSnapshot {
    if (this.totalBytes === 0) {
      return {
        body: null,
        totalBytes: 0,
        truncated: false,
      };
    }

    const buffer = Buffer.concat(this.chunks);
    const contentType = firstHeaderValue(contentTypeHeader)?.split(';', 1)[0]?.trim() ?? '';
    const contentEncoding = firstHeaderValue(contentEncodingHeader)?.trim().toLowerCase();
    const isTextType = TEXT_CONTENT_TYPE.test(contentType);
    const truncated = this.totalBytes > this.previewBytes;

    let textBuffer: Buffer | null = null;
    if (isTextType) {
      if (!contentEncoding || contentEncoding === 'identity') {
        textBuffer = buffer;
      } else if (!truncated) {
        const maxDecodedBytes = Math.max(this.maxPreviewBytes * 4, 256 * 1024);
        textBuffer = decompressPreview(buffer, contentEncoding, maxDecodedBytes);
      }
    }

    if (textBuffer) {
      return {
        body: textBuffer.toString('utf8'),
        totalBytes: this.totalBytes,
        encoding: 'text',
        truncated,
      };
    }

    return {
      body: buffer.toString('base64'),
      totalBytes: this.totalBytes,
      encoding: 'binary',
      truncated,
    };
  }
}
