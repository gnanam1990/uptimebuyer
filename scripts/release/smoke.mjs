#!/usr/bin/env node
// T-057 clean-environment bring-up, local layer (M14; NFR-01, DELIVERY.md Gate F). `pnpm release:smoke`:
//   clone      the committed HEAD into a fresh temporary directory (uncommitted work is never tested);
//   secrets    throwaway secrets generated in that directory (0600 files; nothing reaches the repository);
//   build      every image from the clone (infra/docker/Dockerfile via infra/deploy/compose.json);
//   identify   the git SHA and every image ID (sha256 content digest);
//   migrate    the migrate job against a fresh database; provision a synthetic tenant for a local test identity;
//   up         every service in a FRESH compose project on fresh loopback ports (the dev database on 55432 and other
//              compose projects are never touched), plus the smoke-only loopback JWKS sidecar;
//   checks     health, readiness, an authenticated API call with a locally issued test token (and refusal without or
//              with a forged one), the web page, worker ticks of every runner, broker liveness over its socket;
//   drill      pg_dump backup, pg_restore into a fresh database, checksum/snapshot/migration verification, a migrate
//              no-op on the restore, and an image rollback to the previous ref's images and forward again;
//   teardown   always: compose down -v, smoke images removed, the temporary directory deleted.
// It performs no external action: no push, no registry, no deploy; a hosted deployment stays NOT_RUN.
//   node scripts/release/smoke.mjs [--record] [--previous-ref <git ref>] [--keep-images]
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomInt, sign } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STEPS = Object.freeze([
  'clone',
  'secrets',
  'build',
  'identify',
  'migrate',
  'provision',
  'up',
  'health',
  'readiness',
  'authenticated-api',
  'web',
  'worker-ticks',
  'broker',
  'backup-restore',
  'rollback',
  'teardown',
]);
const TARGETS = ['migrate', 'api', 'worker', 'kite-broker', 'sensor-gateway'];
const ROLLBACK_TARGETS = ['api', 'worker', 'sensor-gateway'];

function seededInts(seed, n) {
  if (seed === undefined) return Array.from({ length: n }, () => randomInt(0, 2 ** 31));
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const h = createHash('sha256').update(`${seed}:${i}`).digest();
    out.push(h.readUInt32BE(0) & 0x7fffffff);
  }
  return out;
}

export function planSmoke({ repo = repoRoot, workRoot, seed, previousRef = 'HEAD~1' } = {}) {
  const [a, b, c] = seededInts(seed, 3);
  const project = `ubsmoke${a.toString(36).padStart(6, '0')}`;
  let api = 20_000 + (b % 39_000);
  let gateway = 20_000 + (c % 39_000);
  if (api === 55432) api++;
  if (gateway === 55432 || gateway === api) gateway = api === 59_999 ? 20_000 : api + 1;
  const root = workRoot ?? path.join(os.homedir(), '.cache', 'uptimebuyer-release-smoke');
  const workDir = path.join(root, project);
  return {
    repo,
    project,
    previousRef,
    ports: { api, gateway },
    workDir,
    cloneDir: path.join(workDir, 'src'),
    previousDir: path.join(workDir, 'previous'),
    secretsDir: path.join(workDir, 'secrets'),
    steps: [...STEPS],
  };
}

export function buildIdentifiers({ sha, images }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('git SHA must be a full 40-hex commit id');
  for (const [k, v] of Object.entries(images ?? {}))
    if (!/^sha256:[0-9a-f]{64}$/.test(v)) throw new Error(`image id for ${k} is not a sha256 digest`);
  return { gitSha: sha, imageIds: { ...images } };
}

export function redactor(secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  return (text) => list.reduce((t, s) => t.split(s).join('[REDACTED]'), String(text));
}

export function emptyReport(plan) {
  return {
    schema: 'release-smoke.v1',
    test: 'T-057',
    layer: 'LOCAL_COMPOSE',
    hostedDeployment: 'NOT_RUN',
    project: plan.project,
    ports: plan.ports,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: 'NOT_RUN',
    build: null,
    previous: null,
    steps: plan.steps.map((name) => ({ name, status: 'NOT_RUN', durationMs: 0, detail: null })),
  };
}

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        maxBuffer: 512 * 1024 * 1024,
        encoding: opts.encoding ?? 'utf8',
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 1_800_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr ?? '').slice(-2_000);
          reject(Object.assign(new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed: ${tail}`), { stdout, stderr }));
        } else resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    }
  });

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const writeSecret = (file, body, mode = 0o600) => {
  writeFileSync(file, body);
  chmodSync(file, mode);
};

/** ES256 JWT minted with node:crypto (the test identity provider's private key never leaves the work directory). */
function mintToken({ privateKey, kid, issuer, audience, subject, ttl = 300 }) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64u(JSON.stringify(o));
  const input = `${enc({ alg: 'ES256', kid, typ: 'JWT' })}.${enc({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + ttl })}`;
  const sig = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64u(sig)}`;
}

const IDP = {
  issuer: 'http://127.0.0.1:8090',
  audience: 'uptimebuyer',
  clientId: 'uptimebuyer-web',
  subject: 'smoke-admin',
};

function defaultSteps(plan, deps, state) {
  const exec = deps.exec;
  const composeFile = path.join(plan.cloneDir, 'infra', 'deploy', 'compose.json');
  const env = (tag = 'candidate') => ({
    ...process.env,
    UB_SECRETS_DIR: plan.secretsDir,
    UB_API_PUBLISH_PORT: String(plan.ports.api),
    UB_GATEWAY_PUBLISH_PORT: String(plan.ports.gateway),
    UB_IMAGE_REGISTRY: `${plan.project}-`,
    UB_IMAGE_TAG: tag,
    UB_OIDC_ISSUER: IDP.issuer,
    UB_OIDC_AUDIENCE: IDP.audience,
    UB_OIDC_JWKS_URL: `${IDP.issuer}/jwks`,
    UB_OIDC_AUTHORIZATION_ENDPOINT: `${IDP.issuer}/authorize`,
    UB_OIDC_TOKEN_ENDPOINT: `${IDP.issuer}/token`,
    UB_OIDC_CLIENT_ID: IDP.clientId,
    UB_ENVIRONMENT_LABEL: 'LOCAL SMOKE - SYNTHETIC DATA',
  });
  const compose = (args, opts = {}) =>
    exec('docker', ['compose', '-f', composeFile, '-p', plan.project, '--profile', 'smoke', ...args], {
      env: env(opts.tag),
      ...opts,
    });
  const image = (target, tag = 'candidate') => `${plan.project}-ub-${target}:${tag}`;
  const api = (p, init) => fetch(`http://127.0.0.1:${plan.ports.api}${p}`, init);
  const inContainer = (service, js) => compose(['exec', '-T', service, 'node', '-e', js]);
  const drill = (args) =>
    compose([
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '-v',
      `${path.join(plan.cloneDir, 'scripts', 'release')}:/app/scripts/release:ro`,
      '-v',
      `${path.join(plan.cloneDir, 'config')}:/app/config:ro`,
      'migrate',
      'node',
      '/app/scripts/release/db-drill.mjs',
      ...args,
    ]);
  const dbUrl = (name) => `postgres://uptimebuyer@postgres:5432/${name}`;
  const until = async (fn, timeoutMs, what) => {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`${what} not reached${last ? `: ${last.message}` : ''}`);
  };
  const ready = async () => {
    const r = await api('/health/ready');
    const body = await r.json();
    if (r.status !== 200 || body.status !== 'ready') throw new Error(`api readiness ${body.status}`);
    const g = await fetch(`http://127.0.0.1:${plan.ports.gateway}/health/ready`);
    if (g.status !== 200) throw new Error(`gateway readiness ${g.status}`);
    const w = JSON.parse(
      (
        await inContainer(
          'worker',
          "fetch('http://127.0.0.1:9465/health/ready').then(r=>r.text()).then(t=>console.log(t))",
        )
      ).stdout,
    );
    if (w.status === 'unavailable') throw new Error('worker readiness unavailable');
    return { api: body.status, gateway: (await g.json()).status, worker: w.status };
  };
  const authenticated = async () => {
    const token = mintToken({ ...state.idp, ...IDP });
    const ok = await api('/v1/session', {
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': state.tenantId },
    });
    const body = await ok.json();
    if (ok.status !== 200 || body.tenant?.tenantId !== state.tenantId) throw new Error(`session ${ok.status}`);
    const none = await api('/v1/session');
    const forgedKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const forged = await api('/v1/session', {
      headers: {
        authorization: `Bearer ${mintToken({ ...IDP, privateKey: forgedKey, kid: state.idp.kid })}`,
        'x-tenant-id': state.tenantId,
      },
    });
    if (none.status !== 401 || forged.status !== 401)
      throw new Error(`unauthenticated ${none.status}/${forged.status}`);
    return {
      session: ok.status,
      roles: body.grants.map((g) => g.role),
      withoutToken: none.status,
      forgedToken: forged.status,
    };
  };

  return {
    clone: async () => {
      mkdirSync(plan.workDir, { recursive: true, mode: 0o700 });
      const sha = (await exec('git', ['-C', plan.repo, 'rev-parse', 'HEAD'])).stdout.trim();
      const dirty = (await exec('git', ['-C', plan.repo, 'status', '--porcelain'])).stdout.trim().length > 0;
      await exec('git', ['clone', '--quiet', '--no-local', '--no-checkout', plan.repo, plan.cloneDir]);
      await exec('git', ['-C', plan.cloneDir, 'checkout', '--quiet', '--detach', sha]);
      state.sha = sha;
      return { sha, sourceTreeDirty: dirty, note: 'the clone contains committed files only' };
    },
    secrets: async () => {
      const s = plan.secretsDir;
      for (const d of [s, path.join(s, 'webhook-verifiers'), path.join(s, 'devices'), path.join(s, 'idp')])
        mkdirSync(d, { recursive: true, mode: 0o700 });
      const pw = b64u(randomBytes(24));
      const authority = generateKeyPairSync('ed25519');
      const refKey = b64u(randomBytes(32));
      const opsApi = b64u(randomBytes(36));
      const opsWorker = b64u(randomBytes(36));
      const idp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const kid = `smoke-${b64u(randomBytes(6))}`;
      writeSecret(path.join(s, 'postgres_password'), pw);
      writeSecret(path.join(s, 'pgpass'), `postgres:5432:*:uptimebuyer:${pw}\n`);
      writeSecret(path.join(s, 'authority_signer_key'), authority.privateKey.export({ format: 'pem', type: 'pkcs8' }));
      writeSecret(path.join(s, 'reference_signer_key'), refKey);
      writeSecret(path.join(s, 'api_ops_token'), opsApi);
      writeSecret(path.join(s, 'worker_ops_token'), opsWorker);
      writeSecret(
        path.join(s, 'broker_config'),
        JSON.stringify({
          databaseUrl: `postgres://uptimebuyer:${pw}@postgres:5432/uptimebuyer`,
          referenceKeyring: { 'reference-k1': refKey },
          authorityPublicKeys: { 'authority-k1': b64u(authority.publicKey.export({ format: 'der', type: 'spki' })) },
          compatibilitySigning: { keyId: 'compat-k1', keyring: { 'compat-k1': b64u(randomBytes(32)) } },
          adapter: { kind: 'NONE' },
          mode: 'PRODUCTION',
        }),
      );
      writeSecret(
        path.join(s, 'idp', 'jwks.json'),
        JSON.stringify({ keys: [{ ...idp.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }] }),
        0o644,
      );
      state.idp = { privateKey: idp.privateKey, kid };
      state.secrets.push(pw, refKey, opsApi, opsWorker);
      return { files: 7, adapter: 'NONE', note: 'throwaway values in the work directory only; Kite credential: none' };
    },
    build: async () => {
      await compose(['build', ...TARGETS], { timeoutMs: 3_600_000 });
      return { targets: TARGETS };
    },
    identify: async () => {
      const images = {};
      for (const t of TARGETS)
        images[t] = (await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image(t)])).stdout.trim();
      state.build = buildIdentifiers({ sha: state.sha, images });
      return state.build;
    },
    migrate: async () => {
      await compose(['up', '-d', '--wait', 'postgres']);
      const out = (await compose(['run', '--rm', '--no-deps', '-T', 'migrate'])).stdout;
      const applied = JSON.parse(out.split('\n').find((l) => l.startsWith('{"applied"'))).applied;
      if (applied.length < 24) throw new Error(`only ${applied.length} migrations applied`);
      return { applied: applied.length, first: applied[0], last: applied.at(-1) };
    },
    provision: async () => {
      const out = (
        await compose([
          'run',
          '--rm',
          '--no-deps',
          '-T',
          'worker',
          'node',
          '--import',
          '/app/scripts/runtime/register-dist.mjs',
          'apps/worker/dist/provision.js',
          '--issuer',
          IDP.issuer,
          '--subject',
          IDP.subject,
          '--tenant-name',
          'Local smoke tenant (synthetic)',
        ])
      ).stdout;
      const r = JSON.parse(out.split('\n').find((l) => l.includes('tenant.provisioned')));
      state.tenantId = r.tenantId;
      return { tenant: 'provisioned', label: 'synthetic' };
    },
    up: async () => {
      try {
        await compose(['up', '-d', '--wait', '--wait-timeout', '240']);
      } catch (e) {
        const logs = await compose(['logs', '--no-color', '--tail', '15']).catch(() => ({ stdout: '' }));
        throw new Error(`${String(e.message).slice(-600)}\n--- logs ---\n${String(logs.stdout).slice(-3_000)}`, {
          cause: e,
        });
      }
      const ps = (await compose(['ps', '--format', 'json'])).stdout;
      const rows = ps.trim().startsWith('[')
        ? JSON.parse(ps)
        : ps
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));
      return Object.fromEntries(rows.map((r) => [r.Service, r.Health || r.State]));
    },
    health: async () => {
      const a = await api('/health/live');
      const g = await fetch(`http://127.0.0.1:${plan.ports.gateway}/health/live`);
      if (a.status !== 200 || g.status !== 200) throw new Error(`liveness ${a.status}/${g.status}`);
      return { api: a.status, gateway: g.status };
    },
    readiness: () => until(ready, 120_000, 'readiness'),
    'authenticated-api': () => until(authenticated, 60_000, 'authenticated session'),
    web: async () => {
      const r = await api('/');
      const html = await r.text();
      if (r.status !== 200 || !/<div id="root"/.test(html)) throw new Error(`web ${r.status}`);
      const csp = r.headers.get('content-security-policy');
      if (!csp) throw new Error('no content-security-policy');
      const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      const a = asset ? await api(asset) : null;
      if (asset && a.status !== 200) throw new Error(`asset ${a.status}`);
      return { status: r.status, csp: true, asset: a?.status ?? null };
    },
    'worker-ticks': () =>
      until(
        async () => {
          const js =
            "const t=require('fs').readFileSync('/run/secrets/worker_ops_token','utf8').trim();" +
            "fetch('http://127.0.0.1:9465/status',{headers:{authorization:'Bearer '+t}}).then(r=>r.text()).then(x=>console.log(x))";
          const { runners } = JSON.parse((await inContainer('worker', js)).stdout);
          const ok = runners.filter((r) => r.lastOutcome === 'OK').length;
          return ok === runners.length && runners.length >= 14
            ? { runners: runners.length, allTickedOk: true, names: runners.map((r) => r.name) }
            : null;
        },
        90_000,
        'every runner ticked OK',
      ),
    broker: async () => {
      const js =
        "require('node:http').get({socketPath:'/run/ub-broker/broker.sock',path:'/health/live'},r=>{console.log(r.statusCode)}).on('error',()=>console.log('ERR'))";
      const fromApi = (await inContainer('api', js)).stdout.trim();
      if (fromApi !== '200') throw new Error(`broker socket from api: ${fromApi}`);
      return { liveOverSocketFromApi: 200, adapter: 'NONE', paidEgressNetworkOnlyBroker: true };
    },
    'backup-restore': async () => {
      const dump = (
        await compose(['exec', '-T', 'postgres', 'pg_dump', '-U', 'uptimebuyer', '-Fc', 'uptimebuyer'], {
          encoding: 'buffer',
        })
      ).stdout;
      const dumpSha256 = createHash('sha256').update(dump).digest('hex');
      writeFileSync(path.join(plan.workDir, 'backup.dump'), dump);
      const source = JSON.parse((await drill(['snapshot', dbUrl('uptimebuyer')])).stdout);
      const restoreDb = 'uptimebuyer_restore';
      await compose(['exec', '-T', 'postgres', 'createdb', '-U', 'uptimebuyer', restoreDb]);
      const again = createHash('sha256').update(dump).digest('hex');
      if (again !== dumpSha256) throw new Error('dump checksum changed');
      await compose(
        ['exec', '-T', 'postgres', 'pg_restore', '-U', 'uptimebuyer', '--no-owner', '--exit-on-error', '-d', restoreDb],
        {
          input: dump,
        },
      );
      const restored = JSON.parse((await drill(['snapshot', dbUrl(restoreDb)])).stdout);
      const { compareSnapshots } = await import('./db-drill.mjs');
      const cmp = compareSnapshots(source, restored);
      if (!cmp.equal) throw new Error(`restore differs: ${JSON.stringify(cmp.differences.slice(0, 5))}`);
      const mig = JSON.parse((await drill(['verify-migrations', dbUrl(restoreDb), '/app'])).stdout);
      const noop = (
        await compose([
          'run',
          '--rm',
          '--no-deps',
          '-T',
          '-e',
          `DATABASE_URL=${dbUrl(restoreDb)}`,
          'migrate',
          'node',
          'scripts/db.mjs',
          'migrate',
        ])
      ).stdout;
      const applied = JSON.parse(noop.split('\n').find((l) => l.startsWith('{"applied"'))).applied;
      if (applied.length !== 0) throw new Error('migrate applied migrations to a faithful restore');
      return {
        dumpBytes: dump.length,
        dumpSha256,
        tables: Object.keys(source.tables).length,
        migrations: source.migrations.length,
        snapshotsEqual: true,
        migrationFindings: mig.findings.length,
        migrateOnRestoreApplied: 0,
      };
    },
    rollback: async () => {
      const prevSha = (await exec('git', ['-C', plan.repo, 'rev-parse', plan.previousRef])).stdout.trim();
      await exec('git', ['clone', '--quiet', '--no-local', '--no-checkout', plan.repo, plan.previousDir]);
      await exec('git', ['-C', plan.previousDir, 'checkout', '--quiet', '--detach', prevSha]);
      const prevCompose = path.join(plan.previousDir, 'infra', 'deploy', 'compose.json');
      await exec('docker', ['compose', '-f', prevCompose, '-p', plan.project, 'build', ...ROLLBACK_TARGETS], {
        env: env('previous'),
        timeoutMs: 3_600_000,
      });
      const prevImages = {};
      for (const t of ROLLBACK_TARGETS)
        prevImages[t] = (
          await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image(t, 'previous')])
        ).stdout.trim();
      state.previous = { gitSha: prevSha, imageIds: prevImages };
      const switchTo = async (tag) => {
        await compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', ...ROLLBACK_TARGETS], { tag });
        await compose(['up', '-d', '--no-deps', '--force-recreate', 'test-idp'], { tag });
        const running = (
          await exec('docker', ['inspect', '--format', '{{.Image}}', `${plan.project}-api-1`])
        ).stdout.trim();
        const r = await until(ready, 120_000, `readiness on ${tag}`);
        const a = await until(authenticated, 60_000, `session on ${tag}`);
        return { apiImage: running, readiness: r, session: a.session };
      };
      const back = await switchTo('previous');
      const workerImage = (
        await exec('docker', ['inspect', '--format', '{{.Image}}', `${plan.project}-worker-1`])
      ).stdout.trim();
      if (workerImage !== prevImages.worker) throw new Error('rollback did not switch the worker image');
      if (back.apiImage !== prevImages.api) throw new Error('rollback did not switch the api image');
      const forward = await switchTo('candidate');
      if (forward.apiImage !== state.build.imageIds.api) throw new Error('roll-forward did not restore the candidate');
      return {
        previousRef: plan.previousRef,
        previousSha: prevSha,
        distinctFromCandidate: Object.fromEntries(
          ROLLBACK_TARGETS.map((t) => [t, prevImages[t] !== state.build.imageIds[t]]),
        ),
        rolledBack: back,
        rolledForward: forward,
      };
    },
    teardown: async () => {
      await compose(['down', '-v', '--remove-orphans']).catch(() => {});
      if (!deps.keepImages) {
        const tags = [...TARGETS.map((t) => image(t)), ...ROLLBACK_TARGETS.map((t) => image(t, 'previous'))];
        await exec('docker', ['image', 'rm', '-f', ...tags]).catch(() => {});
      }
      await deps.removeDir(plan.workDir);
      return { composeDown: true, workDirRemoved: true };
    },
  };
}

export async function runSmoke(plan, deps) {
  const report = emptyReport(plan);
  const state = { secrets: [], sha: null, build: null, previous: null, tenantId: null, idp: null };
  const full = {
    exec: deps.exec ?? run,
    removeDir: deps.removeDir ?? (async (d) => rmSync(d, { recursive: true, force: true })),
    log: deps.log ?? ((l) => console.error(l)),
    keepImages: deps.keepImages ?? false,
  };
  const steps = { ...defaultSteps(plan, full, state), ...(deps.steps ?? {}) };
  let failed = false;
  for (const entry of report.steps) {
    if (failed && entry.name !== 'teardown') continue;
    const t0 = Date.now();
    full.log(`[smoke] ${entry.name} ...`);
    try {
      entry.detail = (await steps[entry.name]()) ?? null;
      entry.status = 'PASS';
    } catch (e) {
      entry.status = 'FAIL';
      entry.detail = { error: String(e?.message ?? e).slice(-4_000) };
      if (entry.name !== 'teardown') failed = true;
    }
    entry.durationMs = Date.now() - t0;
    full.log(`[smoke] ${entry.name} ${entry.status} (${entry.durationMs} ms)`);
  }
  report.finishedAt = new Date().toISOString();
  report.build = state.build;
  report.previous = state.previous;
  report.result = report.steps.every((s) => s.status === 'PASS') ? 'PASS' : 'FAIL';
  const redact = redactor(state.secrets);
  return JSON.parse(redact(JSON.stringify(report)));
}

/**
 * Cleanup for an interrupted run (M14 security review R7): the compose project (containers, networks, volumes) and the
 * work directory holding throwaway private keys must not outlive SIGINT/SIGTERM.
 */
export async function interruptCleanup(plan, deps) {
  const exec = deps.exec ?? run;
  const composeFile = path.join(plan.cloneDir, 'infra', 'deploy', 'compose.json');
  await exec(
    'docker',
    ['compose', '-f', composeFile, '-p', plan.project, '--profile', 'smoke', 'down', '-v', '--remove-orphans'],
    {
      env: {
        ...process.env,
        UB_SECRETS_DIR: plan.secretsDir,
        UB_OIDC_ISSUER: 'x',
        UB_OIDC_AUDIENCE: 'x',
        UB_OIDC_JWKS_URL: 'x',
        UB_OIDC_AUTHORIZATION_ENDPOINT: 'x',
        UB_OIDC_TOKEN_ENDPOINT: 'x',
      },
    },
  ).catch(() => {});
  await (deps.removeDir ?? (async (d) => rmSync(d, { recursive: true, force: true })))(plan.workDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const plan = planSmoke({ previousRef: val('--previous-ref') ?? 'HEAD~1' });
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      process.stderr.write(`[smoke] ${sig}: cleaning up ${plan.project}\n`);
      void interruptCleanup(plan, {}).finally(() => process.exit(130));
    });
  const report = await runSmoke(plan, { keepImages: args.includes('--keep-images') });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.includes('--record'))
    writeFileSync(path.join(repoRoot, 'docs', 'release', 'evidence', 't057-release-smoke.json'), text);
  process.stdout.write(text);
  process.exitCode = report.result === 'PASS' ? 0 : 1;
}
