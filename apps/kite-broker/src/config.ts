// Broker secret configuration (INV-06, INV-13). The ONLY way the broker receives the paid credential, the database
// URL and its verification keys: a JSON document read once from an inherited file descriptor (a pipe the launcher or
// secret manager writes and closes) or from a 0600 secret file owned by the broker's uid. Never from env, argv or a
// log line. The parsed values are frozen and the raw bytes are zeroed after parsing.
import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

const B64 = z.string().regex(/^[A-Za-z0-9_-]{16,4096}$/);
const KeyId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const Capability = z.strictObject({ lookupByClientOperation: z.boolean(), sameKeyReplay: z.boolean() });

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
    z.strictObject({
      kind: z.literal('KITE_PASSPORT'),
      kpassBinary: z.string().min(1).max(1024),
      stateRoot: z.string().min(1).max(1024),
      baseUrl: z.string().url().optional(),
      timeoutMs: z.int().min(1_000).max(300_000),
      merchantEndpoints: z.record(
        z.string(),
        z.strictObject({ url: z.string().url(), method: z.enum(['GET', 'POST']) }),
      ),
      sameKeyReplayVerified: z.boolean().optional(),
    }),
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
  const timeout = r.data.adapter.kind === 'NONE' ? 0 : r.data.adapter.timeoutMs;
  if (r.data.mode === 'PRODUCTION' && (r.data.sendLeaseMs ?? 60_000) < timeout + 1_000)
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

/** Read a 0600 secret file owned by this uid (group/other bits refused). */
export function loadSecretFromFile(path: string): BrokerSecretConfig {
  const st = statSync(path);
  if (!st.isFile()) throw new ConfigError('SECRET_FILE_NOT_REGULAR');
  if ((st.mode & 0o077) !== 0) throw new ConfigError('SECRET_FILE_MODE_TOO_OPEN');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    throw new ConfigError('SECRET_FILE_NOT_OWNED');
  const fd = openSync(path, 'r');
  try {
    return parse(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}
