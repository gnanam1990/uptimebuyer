// Runtime-only local PKI for the LOCAL_STAND_IN mTLS boundary (copied from the F0 spike), generated with openssl.
// Keys are written to a 0700 temp dir only long enough to be read into the launcher's memory, then removed.
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];

function run(dir, args) {
  execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function issue(dir, ca, name, subject, ext) {
  writeFileSync(path.join(dir, `${name}.ext`), ext);
  run(dir, ['req', ...EC, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', subject]);
  run(dir, [
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    `${ca}.pem`,
    '-CAkey',
    `${ca}.key`,
    '-CAcreateserial',
    '-out',
    `${name}.pem`,
    '-days',
    '1',
    '-extfile',
    `${name}.ext`,
  ]);
  const cert = readFileSync(path.join(dir, `${name}.pem`), 'utf8');
  return {
    key: readFileSync(path.join(dir, `${name}.key`), 'utf8'),
    cert,
    fingerprint256: new X509Certificate(cert).fingerprint256,
  };
}

// Returns a CA certificate, a server credential for 127.0.0.1 and one client credential. The CA key is discarded.
export function makeLocalPki(prefix, clientCn) {
  const dir = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  try {
    run(dir, ['req', '-x509', ...EC, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', `/CN=${prefix}-ca`]);
    const caCert = readFileSync(path.join(dir, 'ca.pem'), 'utf8');
    const server = issue(
      dir,
      'ca',
      'server',
      '/CN=127.0.0.1',
      'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
    );
    const client = issue(dir, 'ca', 'client', `/CN=${clientCn}`, 'extendedKeyUsage=clientAuth\n');
    return { caCert, server, client, keygenDir: dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
