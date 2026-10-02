import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface CertificateAuthorityMaterial {
  key: string;
  cert: string;
  keyPath: string;
  certPath: string;
  fingerprint256: string;
  expiresAt: string;
}

export interface CertificateAuthorityMetadata {
  certPath: string;
  fingerprint256: string;
  expiresAt: string;
}

export function defaultTraceLocalDataDir(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'TraceLocal');
  }
  return path.join(os.homedir(), '.tracelocal');
}

async function atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, { encoding: 'utf8', mode });
  await rm(filePath, { force: true });
  await rename(tempPath, filePath);
}

function inspectPair(key: string, cert: string): Omit<
  CertificateAuthorityMaterial,
  'key' | 'cert' | 'keyPath' | 'certPath'
> {
  const certificate = new X509Certificate(cert);
  const privateKey = createPrivateKey(key);
  const privatePublicKey = createPublicKey(privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const certificatePublicKey = certificate.publicKey.export({
    type: 'spki',
    format: 'der',
  });

  if (!Buffer.from(privatePublicKey).equals(Buffer.from(certificatePublicKey))) {
    throw new Error('CA private key does not match certificate');
  }

  return {
    fingerprint256: certificate.fingerprint256,
    expiresAt: new Date(certificate.validTo).toISOString(),
  };
}

export class CertificateAuthorityManager {
  readonly certDir: string;
  readonly keyPath: string;
  readonly certPath: string;

  private material?: CertificateAuthorityMaterial;

  constructor(private readonly dataDir = defaultTraceLocalDataDir()) {
    this.certDir = path.join(dataDir, 'certificates');
    this.keyPath = path.join(this.certDir, 'ca-key.pem');
    this.certPath = path.join(this.certDir, 'ca-cert.pem');
  }

  async ensure(): Promise<CertificateAuthorityMaterial> {
    if (this.material) {
      return { ...this.material };
    }

    await mkdir(this.certDir, { recursive: true });

    const existing = await this.tryReadValidPair();
    if (existing) {
      this.material = existing;
      return { ...existing };
    }

    const { generateCACertificate } = await import('mockttp');
    const generated = await generateCACertificate({
      subject: {
        commonName: 'Trace Local Local Development CA',
        organizationName: 'Trace Local',
      },
      bits: 2048,
    });

    const inspection = inspectPair(generated.key, generated.cert);
    await atomicWrite(this.keyPath, generated.key, 0o600);
    await atomicWrite(this.certPath, generated.cert, 0o644);

    const material: CertificateAuthorityMaterial = {
      key: generated.key,
      cert: generated.cert,
      keyPath: this.keyPath,
      certPath: this.certPath,
      ...inspection,
    };

    this.material = material;
    return { ...material };
  }

  async metadata(): Promise<CertificateAuthorityMetadata> {
    const material = await this.ensure();
    return {
      certPath: material.certPath,
      fingerprint256: material.fingerprint256,
      expiresAt: material.expiresAt,
    };
  }

  private async tryReadValidPair(): Promise<CertificateAuthorityMaterial | undefined> {
    try {
      const [key, cert] = await Promise.all([
        readFile(this.keyPath, 'utf8'),
        readFile(this.certPath, 'utf8'),
      ]);
      const inspection = inspectPair(key, cert);

      return {
        key,
        cert,
        keyPath: this.keyPath,
        certPath: this.certPath,
        ...inspection,
      };
    } catch {
      return undefined;
    }
  }
}
