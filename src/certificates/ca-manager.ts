import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withCertificateInitializationLock } from './initialization-lock';

export interface CertificateAuthorityMaterial {
  key: string;
  cert: string;
  keyPath: string;
  certPath: string;
  publicCertPath: string;
  fingerprint256: string;
  expiresAt: string;
}

export interface CertificateAuthorityMetadata {
  certPath: string;
  publicCertPath: string;
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
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function inspectPair(key: string, cert: string): Omit<
  CertificateAuthorityMaterial,
  'key' | 'cert' | 'keyPath' | 'certPath' | 'publicCertPath'
> {
  const certificate = new X509Certificate(cert);
  if (!certificate.ca || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error('CA certificate must be a currently valid certificate authority');
  }
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
  readonly publicCertPath: string;

  private material?: CertificateAuthorityMaterial;
  private ensuring?: Promise<CertificateAuthorityMaterial>;

  constructor(private readonly dataDir = defaultTraceLocalDataDir()) {
    this.certDir = path.join(dataDir, 'certificates');
    this.keyPath = path.join(this.certDir, 'ca-key.pem');
    this.certPath = path.join(this.certDir, 'ca-cert.pem');
    this.publicCertPath = path.join(this.certDir, 'tracelocal-ca.crt');
  }

  async ensure(): Promise<CertificateAuthorityMaterial> {
    if (this.material) {
      if (Date.parse(this.material.expiresAt) <= Date.now()) {
        throw new Error('Trace Local CA has expired; restart Trace Local to renew it before downloading certificates or pairing.');
      }
      return { ...this.material };
    }

    if (!this.ensuring) {
      this.material = undefined;
      this.ensuring = this.loadOrGenerate().finally(() => { this.ensuring = undefined; });
    }
    return { ...await this.ensuring };
  }

  private async loadOrGenerate(): Promise<CertificateAuthorityMaterial> {
    return withCertificateInitializationLock(this.certDir, () => this.loadOrGenerateLocked());
  }

  private async loadOrGenerateLocked(): Promise<CertificateAuthorityMaterial> {

    const existing = await this.tryReadValidPair();
    if (existing) {
      await atomicWrite(this.publicCertPath, existing.cert, 0o644);
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
    await atomicWrite(this.publicCertPath, generated.cert, 0o644);

    const material: CertificateAuthorityMaterial = {
      key: generated.key,
      cert: generated.cert,
      keyPath: this.keyPath,
      certPath: this.certPath,
      publicCertPath: this.publicCertPath,
      ...inspection,
    };

    this.material = material;
    return { ...material };
  }

  async metadata(): Promise<CertificateAuthorityMetadata> {
    const material = await this.ensure();
    return {
      certPath: material.certPath,
      publicCertPath: material.publicCertPath,
      fingerprint256: material.fingerprint256,
      expiresAt: material.expiresAt,
    };
  }

  private async tryReadValidPair(): Promise<CertificateAuthorityMaterial | undefined> {
    const reads = await Promise.allSettled([
      readFile(this.keyPath, 'utf8'),
      readFile(this.certPath, 'utf8'),
    ]);
    for (const result of reads) {
      if (result.status === 'rejected' && (result.reason as NodeJS.ErrnoException).code !== 'ENOENT') throw result.reason;
    }
    if (reads[0].status !== 'fulfilled' || reads[1].status !== 'fulfilled') return undefined;
    const [key, cert] = [reads[0].value, reads[1].value];

    try {
      const inspection = inspectPair(key, cert);

      return {
        key,
        cert,
        keyPath: this.keyPath,
        certPath: this.certPath,
        publicCertPath: this.publicCertPath,
        ...inspection,
      };
    } catch {
      return undefined;
    }
  }
}
