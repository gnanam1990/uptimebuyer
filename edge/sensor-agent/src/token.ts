// Device token minting for the reference agent: the short-lived HS256 device token that @uptimebuyer/data's
// authenticateDevice verifies (typ, issuer, audience, kid = sub = device id, unique jti, bounded lifetime). Real
// firmware implements the same claims; T-016 proves these tokens authenticate against the gateway.
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

const DEVICE_TOKEN = { typ: 'ub-device+jwt', issuer: 'urn:uptimebuyer:device', audience: 'urn:uptimebuyer:device' };

export function createDeviceTokenProvider(
  deviceId: string,
  deviceKey: Uint8Array,
  opts: { ttlSeconds?: number } = {},
): () => Promise<string> {
  if (!(deviceKey instanceof Uint8Array) || deviceKey.byteLength < 32)
    throw new Error('Device credential key must be at least 32 bytes.');
  const ttl = Math.min(Math.max(opts.ttlSeconds ?? 120, 1), 900);
  return async () => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: DEVICE_TOKEN.typ, kid: deviceId })
      .setIssuer(DEVICE_TOKEN.issuer)
      .setAudience(DEVICE_TOKEN.audience)
      .setSubject(deviceId)
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .setJti(randomUUID())
      .sign(deviceKey);
  };
}
