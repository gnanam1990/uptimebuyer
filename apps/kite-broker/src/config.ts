// Broker secret configuration (INV-06, INV-13). The ONLY way the broker receives the paid credential, the database
// URL and its verification keys: a JSON document read once from an inherited file descriptor (a pipe the launcher or
// secret manager writes and closes) or from a 0600 secret file owned by the broker's uid. Never from env, argv or a
// log line. The parsed values are frozen and the raw bytes are zeroed after parsing.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { DEFAULT_KPASS_READ_TIMEOUT_MS } from './adapters/kite-passport.js';
import { z } from 'zod';

const B64 = z.string().regex(/^[A-Za-z0-9_-]{16,4096}$/);
const KeyId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const Capability = z.strictObject({ lookupByClientOperation: z.boolean(), sameKeyReplay: z.boolean() });
const MerchantId = z.string().regex(/^mer_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/);

/**
 * The KITE_PASSPORT adapter section: paths and policy only. No Kite credential is ever in it (kpass keeps its login in
 * `<stateRoot>/.kite-passport`). Merchant endpoints map the product's merchant id to the exact URL (query included)
 * and method; nothing else is ever paid.
 */
export const KitePassportAdapterSchema = z.strictObject({
  kind: z.literal('KITE_PASSPORT'),
  kpassBinary: z.string().min(1).max(1024).startsWith('/'),
  stateRoot: z.string().min(1).max(1024).startsWith('/'),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.int().min(1_000).max(300_000),
  readTimeoutMs: z.int().min(1_000).max(120_000).optional(),
  merchantEndpoints: z.record(
    MerchantId,
    // Only GET is executable today; POST is refused until a body contract exists (PR #21 review 1).
    z.strictObject({ url: z.string().url().max(2048), method: z.literal('GET') }),
  ),
  sameKeyReplayVerified: z.boolean().optional(),
  manualReconciliationAccepted: z.boolean().optional(),
});
export type KitePassportAdapterConfig = z.output<typeof KitePassportAdapterSchema>;

/** The operator's KITE_PASSPORT adapter file (outside the repository, 0600): see config/broker.kite-passport.example.json. */
export const KiteAdapterFileSchema = z.strictObject({
  schema: z.literal('uptimebuyer-kite-broker-adapter.v1'),
  adapter: KitePassportAdapterSchema,
});

export const BrokerSecretConfigSchema = z.strictObject({
  databaseUrl: z.string().min(1).max(2048),
  referenceKeyring: z.record(KeyId, B64),
  authorityPublicKeys: z.record(KeyId, B64),
  compatibilitySigning: z.strictObject({ keyId: KeyId, keyring: z.record(KeyId, B64) }),
  adapter: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('NONE') }),
    z.strictObject({
      kind: z.literal('LOCAL_STAND_IN'),
      baseUrl: z.string().url(),
      serverCertFingerprint256: z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
      caCert: z.string().min(1).max(16_384),
      clientCert: z.string().min(1).max(16_384),
      clientKey: z.string().min(1).max(16_384),
      capability: z.string().min(32).max(512),
      reconciliation: Capability,
      timeoutMs: z.int().min(100).max(120_000),
    }),
    KitePassportAdapterSchema,
  ]),
  sendLeaseMs: z.int().min(100).max(3_600_000).optional(),
  reconcileBaseMs: z.int().min(50).max(3_600_000).optional(),
  /** TEST mode enables named crash points for the process-level T-040 probes; production refuses them. */
  mode: z.enum(['PRODUCTION', 'TEST']).default('PRODUCTION'),
  testFaults: z
    .array(z.string().regex(/^[A-Z_]{3,64}$/))
    .max(8)
    .optional(),
});
export type BrokerSecretConfig = z.output<typeof BrokerSecretConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly reasonCode: string) {
    super(`broker configuration rejected: ${reasonCode}`);
    this.name = 'ConfigError';
  }
}

/**
 * The shortest send lease for an adapter: everything one send may take, plus a 1 s margin. A KITE_PASSPORT send is a
 * session-status read (readTimeoutMs) followed by the paid call (timeoutMs).
 */
export function minimumSendLeaseMs(adapter: BrokerSecretConfig['adapter']): number {
  if (adapter.kind === 'NONE') return 1_000;
  if (adapter.kind === 'KITE_PASSPORT')
    return adapter.timeoutMs + (adapter.readTimeoutMs ?? DEFAULT_KPASS_READ_TIMEOUT_MS) + 1_000;
  return adapter.timeoutMs + 1_000;
}

function parse(buf: Buffer): BrokerSecretConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new ConfigError('SECRET_CONFIG_NOT_JSON');
  } finally {
    buf.fill(0);
  }
  const r = BrokerSecretConfigSchema.safeParse(raw);
  // Report the failing paths only, never a value.
  if (!r.success)
    throw new ConfigError(`SECRET_CONFIG_INVALID:${r.error.issues.map((i) => i.path.join('.')).join(',')}`);
  if (r.data.mode === 'PRODUCTION' && r.data.testFaults?.length) throw new ConfigError('TEST_FAULTS_IN_PRODUCTION');
  // A send lease shorter than the adapter timeout would let a sweep relabel a still-running send as UNKNOWN.
  if (r.data.mode === 'PRODUCTION' && (r.data.sendLeaseMs ?? 60_000) < minimumSendLeaseMs(r.data.adapter))
    throw new ConfigError('SEND_LEASE_SHORTER_THAN_ADAPTER_TIMEOUT');
  return Object.freeze(r.data);
}

/** Read the whole secret document from an inherited fd (closed afterwards). */
export function loadSecretFromFd(fd: number): BrokerSecretConfig {
  const st = fstatSync(fd);
  if (!st.isFIFO() && !st.isFile() && !st.isSocket()) throw new ConfigError('SECRET_FD_NOT_A_PIPE_OR_FILE');
  const buf = readFileSync(fd);
  closeSync(fd);
  return parse(buf);
}

/** Owner, mode and type checks on an OPEN descriptor (never on a path that could be swapped afterwards). */
function assertPrivateFd(fd: number) {
  const st = fstatSync(fd);
  if (!st.isFile()) throw new ConfigError('SECRET_FILE_NOT_REGULAR');
  if ((st.mode & 0o077) !== 0) throw new ConfigError('SECRET_FILE_MODE_TOO_OPEN');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    throw new ConfigError('SECRET_FILE_NOT_OWNED');
}

function openPrivate(path: string, flags: number): number {
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (e) {
    // O_NOFOLLOW on a symlink fails with ELOOP: a symlink is not the regular file this must be.
    throw new ConfigError(
      (e as NodeJS.ErrnoException).code === 'ELOOP' ? 'SECRET_FILE_NOT_REGULAR' : 'SECRET_FILE_UNREADABLE',
    );
  }
  try {
    assertPrivateFd(fd);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/** Read a 0600 secret file owned by this uid (group/other bits refused); checked and read through one descriptor. */
export function loadSecretFromFile(path: string): BrokerSecretConfig {
  const fd = openPrivate(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    return parse(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the operator's KITE_PASSPORT adapter file: opened once with O_NOFOLLOW (a symlink is refused), owner, mode and
 * type checked with fstat on that descriptor, and read from the same descriptor (no check-then-reopen race).
 */
export function loadKiteAdapterFile(path: string): KitePassportAdapterConfig {
  const fd = openPrivate(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let buf: Buffer;
  try {
    buf = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new ConfigError('SECRET_CONFIG_NOT_JSON');
  } finally {
    buf.fill(0);
  }
  const r = KiteAdapterFileSchema.safeParse(raw);
  if (!r.success)
    throw new ConfigError(`SECRET_CONFIG_INVALID:${r.error.issues.map((i) => i.path.join('.')).join(',')}`);
  return Object.freeze(r.data.adapter);
}
