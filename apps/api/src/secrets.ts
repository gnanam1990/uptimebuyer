// API secret wiring (M14; T-057, INV-06). The environment carries secret REFERENCES only: the authority signer's key id
// and the path of its PKCS#8 Ed25519 key file, the webhook verifier root (a directory of per-reference key files), and
// - only when a broker socket is configured - the execution-reference signer's key id and key file for Kite session
// activation. Each file must be a regular file readable by its owner only (readSecretFile). A missing or unusable
// reference stops startup with an error naming the variable and a reason code, never a value. The broker socket is not
// a secret; without it issuance still works and sessions stay PREPARED until activated (no broker egress from here).
import { createPrivateKey, type KeyObject } from 'node:crypto';
import path from 'node:path';
import {
  BROKER_ROUTES,
  authorityReference,
  postReference,
  type AuthoritySigner,
  type ReferenceSigner,
} from '@uptimebuyer/commerce';
import { FileSecretStore, SecretFileError, readSecretFile, type CredentialResolver } from '@uptimebuyer/data';
import type { SessionActivator } from './app.js';

export const REQUIRED_SECRET_REFERENCES = Object.freeze([
  'UB_AUTHORITY_SIGNER_KEY_ID',
  'UB_AUTHORITY_SIGNER_KEY_FILE',
  'UB_WEBHOOK_VERIFIER_ROOT',
] as const);

export class ApiSecretConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiSecretConfigError';
  }
}

export interface ApiSecrets {
  authority: { signer: AuthoritySigner; sessions: SessionActivator | null };
  credentials: CredentialResolver;
}

const KEY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const reason = (e: unknown) => (e instanceof SecretFileError ? e.reasonCode : 'UNREADABLE');
const unusable = (name: string, code: string) => new ApiSecretConfigError(`unusable secret reference ${name}: ${code}`);

function filePath(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]!;
  // A reference is an absolute path; anything else (for example a pasted key) is refused without being echoed.
  if (!path.isAbsolute(v) || v.length > 1024 || /[\r\n]/.test(v)) throw unusable(name, 'NOT_A_FILE_REFERENCE');
  return v;
}

function loadSigner(env: Record<string, string | undefined>): AuthoritySigner {
  const keyId = env.UB_AUTHORITY_SIGNER_KEY_ID!;
  if (!KEY_ID.test(keyId)) throw unusable('UB_AUTHORITY_SIGNER_KEY_ID', 'INVALID_KEY_ID');
  let pem: Buffer;
  try {
    pem = readSecretFile(filePath(env, 'UB_AUTHORITY_SIGNER_KEY_FILE'), { maxBytes: 16_384 });
  } catch (e) {
    if (e instanceof ApiSecretConfigError) throw e;
    throw unusable('UB_AUTHORITY_SIGNER_KEY_FILE', reason(e));
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw unusable('UB_AUTHORITY_SIGNER_KEY_FILE', 'NOT_A_PRIVATE_KEY');
  } finally {
    pem.fill(0);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw unusable('UB_AUTHORITY_SIGNER_KEY_FILE', 'NOT_ED25519');
  return Object.freeze({ keyId, privateKey });
}

function loadReferenceSigner(env: Record<string, string | undefined>): ReferenceSigner {
  const missing = ['UB_REFERENCE_SIGNER_KEY_ID', 'UB_REFERENCE_SIGNER_KEY_FILE'].filter((k) => !env[k]);
  if (missing.length)
    throw new ApiSecretConfigError(
      `missing secret reference ${missing.join(', ')} (required with UB_KITE_BROKER_SOCKET; see .env.example)`,
    );
  const keyId = env.UB_REFERENCE_SIGNER_KEY_ID!;
  if (!KEY_ID.test(keyId)) throw unusable('UB_REFERENCE_SIGNER_KEY_ID', 'INVALID_KEY_ID');
  let text: string;
  try {
    text = readSecretFile(filePath(env, 'UB_REFERENCE_SIGNER_KEY_FILE'), { maxBytes: 4_096 }).toString('utf8').trim();
  } catch (e) {
    if (e instanceof ApiSecretConfigError) throw e;
    throw unusable('UB_REFERENCE_SIGNER_KEY_FILE', reason(e));
  }
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw unusable('UB_REFERENCE_SIGNER_KEY_FILE', 'NOT_BASE64URL');
  const key = Buffer.from(text, 'base64url');
  if (key.length < 32) throw unusable('UB_REFERENCE_SIGNER_KEY_FILE', 'KEY_TOO_SHORT');
  return Object.freeze({ keyId, key: new Uint8Array(key) });
}

/** Session activation through the broker's unix socket with a signed execution reference (never the broker itself). */
export class BrokerSessionActivator implements SessionActivator {
  constructor(
    private readonly socketPath: string,
    private readonly signer: ReferenceSigner,
  ) {}
  async activate(input: { tenantId: string; executionAuthorityId: string }): Promise<void> {
    await postReference(
      this.socketPath,
      BROKER_ROUTES.ACTIVATE_SESSION,
      authorityReference(this.signer, input.tenantId, input.executionAuthorityId),
    );
  }
}

export function loadApiSecrets(env: Record<string, string | undefined>): ApiSecrets {
  const missing = REQUIRED_SECRET_REFERENCES.filter((k) => !env[k]);
  if (missing.length)
    throw new ApiSecretConfigError(`missing secret reference ${missing.join(', ')} (see .env.example)`);
  const signer = loadSigner(env);
  let credentials: FileSecretStore;
  try {
    credentials = new FileSecretStore(filePath(env, 'UB_WEBHOOK_VERIFIER_ROOT'));
  } catch (e) {
    if (e instanceof ApiSecretConfigError) throw e;
    throw unusable('UB_WEBHOOK_VERIFIER_ROOT', reason(e));
  }
  let sessions: SessionActivator | null = null;
  const socket = env.UB_KITE_BROKER_SOCKET;
  if (socket) {
    if (!path.isAbsolute(socket) || socket.length > 100) throw unusable('UB_KITE_BROKER_SOCKET', 'INVALID_SOCKET_PATH');
    sessions = new BrokerSessionActivator(socket, loadReferenceSigner(env));
  }
  return { authority: { signer, sessions }, credentials };
}
