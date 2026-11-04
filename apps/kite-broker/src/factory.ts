// Build a broker from its parsed secret configuration. The only place adapters are constructed: a paid adapter exists
// only when the configuration explicitly names one; otherwise the broker is UNSUPPORTED for every paid action and
// performs no network I/O at all.
import { importAuthorityPublicKey } from '@uptimebuyer/commerce';
import type { Db } from '@uptimebuyer/data';
import { KitePassportAdapter } from './adapters/kite-passport.js';
import { UnconfiguredAdapter, type PaidAdapter } from './adapters/port.js';
import { LocalStandInAdapter } from './adapters/standin.js';
import { KiteBroker, type BrokerHooks } from './broker.js';
import type { BrokerSecretConfig } from './config.js';
import type { BrokerLog } from './log.js';

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64url'));
const ring = (r: Record<string, string>) =>
  Object.freeze(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, bytes(v)])));

export function adapterFrom(cfg: BrokerSecretConfig['adapter'], log: BrokerLog): PaidAdapter {
  switch (cfg.kind) {
    case 'NONE':
      return new UnconfiguredAdapter();
    case 'LOCAL_STAND_IN':
      log.registerSecret(cfg.capability);
      log.registerSecret(cfg.clientKey);
      return new LocalStandInAdapter(
        {
          baseUrl: cfg.baseUrl,
          serverCertFingerprint256: cfg.serverCertFingerprint256,
          caCert: cfg.caCert,
          clientCert: cfg.clientCert,
          clientKey: cfg.clientKey,
          capability: cfg.capability,
        },
        { capability: cfg.reconciliation, timeoutMs: cfg.timeoutMs },
      );
    case 'KITE_PASSPORT':
      return new KitePassportAdapter({
        kpassBinary: cfg.kpassBinary,
        stateRoot: cfg.stateRoot,
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
        timeoutMs: cfg.timeoutMs,
        merchantEndpoints: cfg.merchantEndpoints,
        sameKeyReplayVerified: cfg.sameKeyReplayVerified === true,
      });
  }
}

export function brokerFrom(pool: Db, cfg: BrokerSecretConfig, log: BrokerLog, hooks?: BrokerHooks): KiteBroker {
  for (const v of Object.values(cfg.referenceKeyring)) log.registerSecret(v);
  for (const v of Object.values(cfg.compatibilitySigning.keyring)) log.registerSecret(v);
  log.registerSecret(cfg.databaseUrl);
  return new KiteBroker(pool, {
    referenceKeyring: ring(cfg.referenceKeyring),
    authorityKeys: Object.freeze(
      Object.fromEntries(Object.entries(cfg.authorityPublicKeys).map(([k, v]) => [k, importAuthorityPublicKey(v)])),
    ),
    compatibilitySigning: { keyId: cfg.compatibilitySigning.keyId, keyring: ring(cfg.compatibilitySigning.keyring) },
    adapter: adapterFrom(cfg.adapter, log),
    ...(hooks ? { hooks } : {}),
    ...(cfg.sendLeaseMs ? { sendLeaseMs: cfg.sendLeaseMs } : {}),
    ...(cfg.reconcileBaseMs ? { reconcileBaseMs: cfg.reconcileBaseMs } : {}),
  });
}
