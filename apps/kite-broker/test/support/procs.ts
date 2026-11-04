// Separate-process launcher for the M09 isolation and crash tests. The test process plays the secret manager: it mints a
// runtime-only CA, a stand-in server certificate, ONE broker client certificate and a 32-byte bearer capability, hands
// the broker its secret document over an fd-3 pipe (never env/argv/files) and the stand-in only the capability hash.
// Every other spawned process gets a minimal environment and none of that material.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { exportAuthorityPublicKey } from '@uptimebuyer/commerce';
import type { BrokerWorld } from '../helpers.js';
// @ts-expect-error plain ESM helper without type declarations
import { makeLocalPki } from './pki.mjs';

const here = import.meta.dirname;
const appRoot = join(here, '..', '..');
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');

export interface Pki {
  caCert: string;
  server: { key: string; cert: string; fingerprint256: string };
  client: { key: string; cert: string; fingerprint256: string };
}

export interface StandIn {
  proc: ChildProcess;
  port: number;
  url: string;
  command(
    c: Record<string, unknown>,
  ): Promise<{ executeCalls: number; effectsCreated: number; authorized: number; rejected: number; sessions: number }>;
  stop(): Promise<void>;
}

export interface Secrets {
  pki: Pki;
  capability: string;
}

export function mintSecrets(): Secrets {
  return { pki: makeLocalPki('m09-standin', 'kite-broker') as Pki, capability: randomBytes(32).toString('base64url') };
}

function lines(proc: ChildProcess, sink: string[]) {
  const rl = readline.createInterface({ input: proc.stdout! });
  rl.on('line', (l) => sink.push(l));
  proc.stderr?.on('data', (d: Buffer) => sink.push(d.toString('utf8')));
  return rl;
}

export async function launchStandIn(secrets: Secrets): Promise<StandIn> {
  const proc = spawn(process.execPath, [join(here, 'standin.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '' },
  });
  const out: string[] = [];
  const rl = lines(proc, out);
  const fd3 = proc.stdio[3] as NodeJS.WritableStream;
  fd3.end(
    JSON.stringify({
      serverKey: secrets.pki.server.key,
      serverCert: secrets.pki.server.cert,
      caCert: secrets.pki.caCert,
      clientFingerprint256: secrets.pki.client.fingerprint256,
      capabilityHash: createHash('sha256').update(secrets.capability).digest('hex'),
    }),
  );
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`stand-in did not start: ${out.join('\n')}`)), 10_000);
    rl.on('line', (l) => {
      const m = JSON.parse(l);
      if (m.event === 'listening') {
        clearTimeout(t);
        resolve(m.port);
      }
    });
  });
  let seq = 0;
  return {
    proc,
    port,
    url: `https://127.0.0.1:${port}`,
    command(c) {
      const s = ++seq;
      return new Promise((resolve) => {
        const on = (l: string) => {
          const m = JSON.parse(l);
          if (m.event === 'stats' && m.seq === s) {
            rl.off('line', on);
            resolve(m);
          }
        };
        rl.on('line', on);
        proc.stdin!.write(`${JSON.stringify({ ...c, seq: s })}\n`);
      });
    },
    async stop() {
      proc.kill('SIGKILL');
      await new Promise((r) => proc.once('exit', r));
    },
  };
}

export interface BrokerProc {
  proc: ChildProcess;
  socketPath: string;
  log: string[];
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface BrokerLaunch {
  standIn: StandIn | null;
  reconciliation?: { lookupByClientOperation: boolean; sameKeyReplay: boolean };
  testFaults?: string[];
  sendLeaseMs?: number;
  reconcileBaseMs?: number;
  socketDir?: string;
}

export function brokerSecretDocument(w: BrokerWorld, secrets: Secrets, l: BrokerLaunch) {
  return {
    databaseUrl: w.db.url,
    referenceKeyring: { [w.referenceSigner.keyId]: b64(w.referenceSigner.key) },
    authorityPublicKeys: { [w.authoritySigner.keyId]: exportAuthorityPublicKey(w.authoritySigner) },
    compatibilitySigning: {
      keyId: w.signing.keyId,
      keyring: Object.fromEntries(Object.entries(w.signing.keyring).map(([k, v]) => [k, b64(v as Uint8Array)])),
    },
    adapter: l.standIn
      ? {
          kind: 'LOCAL_STAND_IN',
          baseUrl: l.standIn.url,
          serverCertFingerprint256: secrets.pki.server.fingerprint256,
          caCert: secrets.pki.caCert,
          clientCert: secrets.pki.client.cert,
          clientKey: secrets.pki.client.key,
          capability: secrets.capability,
          reconciliation: l.reconciliation ?? { lookupByClientOperation: true, sameKeyReplay: true },
          timeoutMs: 2_000,
        }
      : { kind: 'NONE' },
    sendLeaseMs: l.sendLeaseMs ?? 3_500,
    reconcileBaseMs: l.reconcileBaseMs ?? 200,
    mode: l.testFaults?.length ? 'TEST' : 'PRODUCTION',
    ...(l.testFaults?.length ? { testFaults: l.testFaults } : {}),
  };
}

export async function launchBroker(w: BrokerWorld, secrets: Secrets, l: BrokerLaunch): Promise<BrokerProc> {
  const socketDir = l.socketDir ?? mkdtempSync(join(tmpdir(), 'm09-broker-'));
  const socketPath = join(socketDir, 'broker.sock');
  const proc = spawn(
    process.execPath,
    [
      '--disable-sigusr1',
      '--experimental-transform-types',
      '--no-warnings',
      '--import',
      join(here, 'ts-register.mjs'),
      join(appRoot, 'src', 'main.ts'),
      '--socket',
      socketPath,
      '--secret-fd',
      '3',
      '--sweep-ms',
      '300',
    ],
    { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } },
  );
  const log: string[] = [];
  lines(proc, log);
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
  (proc.stdio[3] as NodeJS.WritableStream).end(JSON.stringify(brokerSecretDocument(w, secrets, l)));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`broker did not start: ${log.join('\n')}`)), 30_000);
    const tick = setInterval(() => {
      if (log.some((x) => x.includes('broker.listening'))) {
        clearTimeout(t);
        clearInterval(tick);
        resolve();
      }
    }, 50);
    void exited.then((code) => {
      clearTimeout(t);
      clearInterval(tick);
      if (!log.some((x) => x.includes('broker.listening')))
        reject(new Error(`broker exited ${code}: ${log.join('\n')}`));
    });
  });
  return {
    proc,
    socketPath,
    log,
    exited,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
        await exited;
      }
    },
  };
}

export const cleanupDir = (dir: string) => rmSync(dir, { recursive: true, force: true });

/** Run a probe process (worker/API/model-shaped) with a minimal env; returns its JSON report. */
export async function runProbe(role: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const proc = spawn(process.execPath, [join(here, 'probe.mjs'), role], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', ...env },
    cwd: appRoot,
  });
  const chunks: Buffer[] = [];
  const err: Buffer[] = [];
  proc.stdout!.on('data', (d: Buffer) => chunks.push(d));
  proc.stderr!.on('data', (d: Buffer) => err.push(d));
  const code = await new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
  if (code !== 0) throw new Error(`probe ${role} failed (${code}): ${Buffer.concat(err).toString('utf8')}`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
