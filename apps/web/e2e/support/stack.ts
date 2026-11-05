// Playwright global setup/teardown for the M12 browser tests (T-049..T-052). Starts two separate processes:
// 1. the seed harness (m12-e2e-stack.ts in the broker app test support folder): a throwaway database seeded through the real
//    module packages, a test-only OIDC provider and a labelled SIMULATOR feed;
// 2. apps/api (src/main.ts) over that database, serving the built web app (apps/web/dist) from the same origin.
// The browser therefore sees API truth; nothing in the page comes from a fixture file. Fails (never skips) without
// DATABASE_URL or without a built bundle.
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..', '..', '..', '..');
const register = join(repo, 'apps', 'kite-broker', 'test', 'support', 'ts-register.mjs');
const nodeArgs = ['--experimental-transform-types', '--no-warnings', '--import', register];

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

function waitFor(proc: ChildProcess, marker: string, timeoutMs: number, log: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`timed out waiting for ${marker}\n${log.join('')}`)), timeoutMs);
    const onData = (d: Buffer) => {
      const s = d.toString('utf8');
      log.push(s);
      for (const line of s.split('\n'))
        if (line.startsWith(marker)) {
          clearTimeout(timer);
          ok(line.slice(marker.length).trim());
        }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', (d: Buffer) => log.push(d.toString('utf8')));
    proc.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`process exited (${code}) before ${marker}\n${log.join('')}`));
    });
  });
}

export default async function globalSetup() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('DATABASE_URL must be set for the M12 browser tests (CI provides a Postgres service).');
  const webRoot = join(repo, 'apps', 'web', 'dist');
  if (!existsSync(join(webRoot, 'index.html'))) throw new Error('apps/web/dist is missing: run the web build first.');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH ?? '', DATABASE_URL: databaseUrl, UB_E2E_WEB_ORIGIN: origin };

  const stackLog: string[] = [];
  const stack = spawn(
    process.execPath,
    [...nodeArgs, join(repo, 'apps', 'kite-broker', 'test', 'support', 'm12-e2e-stack.ts')],
    {
      cwd: join(repo, 'apps', 'kite-broker'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const manifest = JSON.parse(await waitFor(stack, 'M12_STACK_READY ', 600_000, stackLog));

  // M14: apps/api reads its secrets from files the environment only references. The harness generates a throwaway
  // Ed25519 authority signer and an empty webhook verifier root at runtime (0600/0700, never committed).
  const secretDir = mkdtempSync(join(tmpdir(), 'ub-e2e-secrets-'));
  const signerFile = join(secretDir, 'authority-signer.pem');
  writeFileSync(
    signerFile,
    generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  );
  chmodSync(signerFile, 0o600);
  const verifierRoot = join(secretDir, 'webhook-verifiers');
  mkdirSync(verifierRoot, { mode: 0o700 });

  const apiLog: string[] = [];
  const api = spawn(process.execPath, [...nodeArgs, join(repo, 'apps', 'api', 'src', 'main.ts')], {
    cwd: join(repo, 'apps', 'api'),
    env: {
      PATH: process.env.PATH ?? '',
      DATABASE_URL: manifest.databaseUrl,
      UB_API_HOST: '127.0.0.1',
      UB_API_PORT: String(port),
      UB_OIDC_ISSUER: manifest.idp.issuer,
      UB_OIDC_AUDIENCE: manifest.idp.audience,
      UB_OIDC_JWKS_URL: manifest.idp.jwksUrl,
      UB_OIDC_AUTHORIZATION_ENDPOINT: manifest.idp.authorizationEndpoint,
      UB_OIDC_TOKEN_ENDPOINT: manifest.idp.tokenEndpoint,
      UB_OIDC_CLIENT_ID: manifest.idp.clientId,
      UB_ENVIRONMENT_LABEL: 'SEEDED_TEST_DATA',
      UB_WEB_ROOT: webRoot,
      UB_OBJECT_STORE_ROOT: manifest.storeRoot,
      UB_AUTHORITY_SIGNER_KEY_ID: 'e2e-authority-k1',
      UB_AUTHORITY_SIGNER_KEY_FILE: signerFile,
      UB_WEBHOOK_VERIFIER_ROOT: verifierRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(api, '{"event":"api.listening"', 60_000, apiLog).catch(async (e) => {
    stack.kill('SIGTERM');
    throw e;
  });

  process.env.UB_E2E_BASE_URL = origin;
  process.env.UB_E2E_MANIFEST = JSON.stringify(manifest);
  process.env.UB_E2E_ARTIFACTS = mkdtempSync(join(tmpdir(), 'ub-m12-e2e-'));

  return async () => {
    api.kill('SIGTERM');
    stack.kill('SIGTERM');
    await new Promise((r) => stack.once('exit', r));
    rmSync(secretDir, { recursive: true, force: true });
  };
}
