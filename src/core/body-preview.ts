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
    const isText = (!contentEncoding || contentEncoding === 'identity') && TEXT_CONTENT_TYPE.test(contentType);

    return {
      body: isText ? buffer.toString('utf8') : buffer.toString('base64'),
      totalBytes: this.totalBytes,
      encoding: isText ? 'text' : 'binary',
      truncated: this.totalBytes > this.previewBytes,
    };
  }
}
