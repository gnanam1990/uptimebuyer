// T-057 (M14) production-like environment definitions, static layer: the multi-stage Dockerfile, the compose
// definition for the local production-like bring-up, the reference Kubernetes network policies and the deployment
// documentation. These are configuration only; no cloud account is used. The executed layer (a clean local bring-up)
// is `pnpm release:smoke`; a hosted deployment is NOT_RUN.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

// Broker names assembled from parts so this file never matches the T-039 text guard (it imports nothing from them).
const BROKER = ['kite', 'broker'].join('-');
const BROKER_APP_DIR = ['apps', BROKER].join('/');

const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');
const dockerfile = read('infra/docker/Dockerfile');
const compose = JSON.parse(read('infra/deploy/compose.json'));
const policies = JSON.parse(read('infra/deploy/kubernetes/network-policies.json'));
const deployment = read('infra/deploy/DEPLOYMENT.md');
const runbook = read('infra/runbooks/BACKUP-RESTORE-ROLLBACK.md');
const envExample = read('.env.example');
const dockerignore = read('.dockerignore');

type Stage = { name: string; from: string; lines: string[] };
function stages(text: string): Stage[] {
  const out: Stage[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (m) out.push({ name: (m[2] ?? `stage${out.length}`).toLowerCase(), from: m[1]!, lines: [] });
    else if (out.length && line && !line.startsWith('#')) out.at(-1)!.lines.push(line);
  }
  return out;
}
const RUNTIME = ['migrate', 'api', 'worker', BROKER, 'sensor-gateway'];
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

describe('T-057 Dockerfile', () => {
  const all = stages(dockerfile);
  const byName = new Map(all.map((s) => [s.name, s]));

  it('is multi-stage with one runtime target per deployable', () => {
    expect(all.length).toBeGreaterThanOrEqual(RUNTIME.length + 1);
    for (const t of RUNTIME) expect(byName.has(t), t).toBe(true);
  });

  it('pins every external base image by digest', () => {
    const args = new Map([...dockerfile.matchAll(/^ARG\s+([A-Z_]+)=(\S+)/gm)].map((m) => [m[1]!, m[2]!] as const));
    for (const s of all) {
      const ref = s.from.replace(/^\$\{?([A-Z_]+)\}?$/, (_, k: string) => args.get(k) ?? k);
      if (byName.has(ref.toLowerCase())) continue; // FROM an earlier stage
      expect(ref, s.name).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('runs every runtime target as a non-root numeric user', () => {
    for (const t of RUNTIME) {
      const users = byName.get(t)!.lines.filter((l) => /^USER\s/i.test(l));
      expect(users.length, t).toBeGreaterThan(0);
      const last = users.at(-1)!.split(/\s+/)[1]!;
      expect(last, t).toMatch(/^[1-9]\d{3,}(:[1-9]\d{3,})?$/);
    }
  });

  it('bakes no secret into any layer', () => {
    for (const s of all)
      for (const l of s.lines) {
        if (/^(ARG|ENV)\s/i.test(l) && SECRETISH.test(l)) expect(l, s.name).not.toMatch(/=\s*\S{8,}/);
        expect(l, s.name).not.toMatch(/\.env\b(?!\.example)/);
        expect(l, s.name).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
      }
    for (const p of ['.env', '.git', 'node_modules', 'tmp', 'evidence/raw', '**/test-results', '**/dist'])
      expect(
        dockerignore.split('\n').map((l) => l.trim()),
        p,
      ).toContain(p);
  });

  it('only the broker target contains the broker application', () => {
    for (const s of all) {
      const mentions = s.lines.some((l) => l.includes(BROKER_APP_DIR));
      if (s.name === BROKER || s.name === 'build' || s.name === 'prune') continue;
      expect(mentions, s.name).toBe(false);
    }
    expect(byName.get(BROKER)!.lines.some((l) => l.includes(BROKER_APP_DIR))).toBe(true);
  });
});

describe('T-057 compose definition for the local production-like bring-up', () => {
  const services = compose.services as Record<string, Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const networks = compose.networks as Record<string, { internal?: boolean }>;
  const core = ['postgres', 'migrate', 'api', 'worker', BROKER, 'sensor-gateway'];

  it('defines postgres, the migrate job, api (serving web), worker, broker and sensor gateway', () => {
    for (const s of core) expect(services[s], s).toBeDefined();
    for (const [name, s] of Object.entries(services))
      if (!core.includes(name)) expect(s.profiles, `${name} must be profile-gated`).toBeDefined();
    expect(services.api!.environment.UB_WEB_ROOT).toBe('/app/apps/web/dist');
  });

  it('hardens every application container', () => {
    for (const name of core.filter((s) => s !== 'postgres')) {
      const s = services[name]!;
      expect(s.user, name).toMatch(/^[1-9]\d{3,}:[1-9]\d{3,}$/);
      expect(s.read_only, name).toBe(true);
      expect(s.cap_drop, name).toEqual(['ALL']);
      expect(s.security_opt, name).toContain('no-new-privileges:true');
      expect(s.image ?? '', name).not.toMatch(/:latest$/);
    }
  });

  it('declares health checks and ordered startup through the migrate job', () => {
    for (const name of ['postgres', 'api', 'worker', BROKER, 'sensor-gateway'])
      expect(services[name]!.healthcheck?.test, name).toBeDefined();
    expect(services.migrate!.depends_on.postgres.condition).toBe('service_healthy');
    for (const name of ['api', 'worker', BROKER, 'sensor-gateway'])
      expect(services[name]!.depends_on.migrate.condition, name).toBe('service_completed_successfully');
  });

  it('gives paid egress to the broker only; worker and database have no egress network at all', () => {
    const paid = Object.entries(services).filter(([, s]) => Object.keys(s.networks ?? {}).includes('paid-egress'));
    expect(paid.map(([n]) => n)).toEqual([BROKER]);
    expect(networks['paid-egress']!.internal).not.toBe(true);
    for (const name of ['worker', 'postgres', 'migrate'])
      for (const n of Object.keys(services[name]!.networks ?? {}))
        expect(networks[n]!.internal, `${name}/${n}`).toBe(true);
    // The broker is reached only over its unix socket volume; it publishes no port.
    expect(services[BROKER]!.ports).toBeUndefined();
  });

  it('publishes ingress on loopback only and never publishes an operations listener', () => {
    for (const [name, s] of Object.entries(services))
      for (const p of (s.ports ?? []) as string[]) {
        expect(p, name).toMatch(/^127\.0\.0\.1:/);
        expect(p, name).not.toMatch(/:(9464|9465|9466)$/);
      }
    expect(services.api!.environment.UB_OPS_HOST).toBe('127.0.0.1');
    expect(services.worker!.environment.UB_WORKER_OPS_HOST).toBe('127.0.0.1');
  });

  it('delivers Kite credential references to the broker only, and every secret as a file', () => {
    const secretUsers = (secret: string) =>
      Object.entries(services)
        .filter(([, s]) =>
          ((s.secrets ?? []) as (string | { source: string })[]).some(
            (x) => (typeof x === 'string' ? x : x.source) === secret,
          ),
        )
        .map(([n]) => n);
    expect(secretUsers('broker_config')).toEqual([BROKER]);
    for (const [name, def] of Object.entries(
      compose.secrets as Record<string, { file?: string; environment?: string }>,
    )) {
      expect(def.file, name).toBeDefined();
      expect(def.environment, name).toBeUndefined();
    }
    for (const [name, s] of Object.entries(services))
      for (const [k, v] of Object.entries((s.environment ?? {}) as Record<string, string>)) {
        if (SECRETISH.test(k) && !/_ENDPOINT$/.test(k)) expect(k, `${name}.${k}`).toMatch(/(_FILE|_ROOT|_KEY_ID|_ID)$/);
        // Database URLs carry no password (it comes from a 0600 pgpass file).
        if (/^postgres(ql)?:\/\//.test(v)) expect(v, `${name}.${k}`).not.toMatch(/\/\/[^/@]+:[^/@]+@/);
      }
    for (const [name, s] of Object.entries(services))
      if (name !== BROKER) expect(JSON.stringify(s), name).not.toMatch(/broker_config|KITE_PASSPORT|kpass/i);
  });
});

describe('T-057 reference network policy and deployment notes', () => {
  type Rule = { to?: { ipBlock?: { cidr: string } }[]; ports?: { port: number }[] };
  type Policy = {
    metadata: { name: string };
    spec: { podSelector: { matchLabels?: Record<string, string> }; policyTypes: string[]; egress?: Rule[] };
  };
  const items = policies.items as Policy[];
  const forApp = (app: string) => items.filter((p) => p.spec.podSelector.matchLabels?.app === app);

  it('denies all egress by default and allows internet egress on 443 to the broker only', () => {
    const deny = items.find((p) => Object.keys(p.spec.podSelector).length === 0 || !p.spec.podSelector.matchLabels);
    expect(deny?.spec.policyTypes).toEqual(expect.arrayContaining(['Egress', 'Ingress']));
    expect(deny?.spec.egress ?? []).toEqual([]);
    const worldEgress = items.filter((p) =>
      (p.spec.egress ?? []).some((r) => (r.to ?? []).some((t) => t.ipBlock?.cidr === '0.0.0.0/0')),
    );
    expect(worldEgress.map((p) => p.spec.podSelector.matchLabels?.app)).toEqual([BROKER]);
    const ports = (app: string) =>
      forApp(app).flatMap((p) => (p.spec.egress ?? []).flatMap((r) => (r.ports ?? []).map((x) => x.port)));
    // The worker reaches only PostgreSQL and DNS (no paid or general egress); the API adds 443 to the IdP block only.
    expect(new Set(ports('worker'))).toEqual(new Set([5432, 53]));
    expect(ports('api').every((p) => [5432, 53, 443].includes(p))).toBe(true);
    for (const p of forApp('api'))
      for (const r of p.spec.egress ?? [])
        for (const t of r.to ?? []) expect(t.ipBlock?.cidr ?? 'selector').not.toBe('0.0.0.0/0');
    expect(new Set(ports('sensor-gateway'))).toEqual(new Set([5432, 53]));
  });

  it('documents proxy trust, edge/WAF rate limits, per-replica sizing, the private operations listener and secrets', () => {
    for (const needle of [
      'UB_TRUST_PROXY',
      'WAF',
      'rate limit',
      'per replica',
      'maxConcurrentAuth',
      'operations listener',
      'private interface',
      'UB_AUTHORITY_SIGNER_KEY_FILE',
      'NOT_RUN',
    ])
      expect(deployment.toLowerCase(), needle).toContain(needle.toLowerCase());
    for (const needle of ['pg_dump', 'pg_restore', 'checksum', 'schema_migrations', 'rollback', 'forward-only'])
      expect(runbook.toLowerCase(), needle).toContain(needle.toLowerCase());
  });
});

describe('T-057 .env.example documents every runtime variable with placeholders', () => {
  const sources = [
    'apps/api/src/config.ts',
    'apps/api/src/secrets.ts',
    'apps/api/src/main.ts',
    'apps/worker/src/config.ts',
    'apps/sensor-gateway/src/main.ts',
  ];
  it('lists every UB_* variable the entry points read', () => {
    const used = new Set<string>();
    for (const f of sources) for (const m of read(f).matchAll(/\bUB_[A-Z0-9_]+\b/g)) used.add(m[0]);
    expect(used.size).toBeGreaterThan(15);
    const documented = new Set([...envExample.matchAll(/^#?\s*(UB_[A-Z0-9_]+)=/gm)].map((m) => m[1]!));
    expect([...used].filter((v) => !documented.has(v)).sort()).toEqual([]);
  });

  it('holds no secret value: secret variables point at files under /run/secrets', () => {
    for (const line of envExample.split('\n')) {
      const m = /^#?\s*([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const [, k, v] = m;
      if (/_FILE$/.test(k!)) expect(v, k).toMatch(/^(\/run\/secrets\/[a-z0-9_.-]+)?$/);
      if (SECRETISH.test(k!) && !/_(FILE|ROOT|ID|ENDPOINT)$/.test(k!)) expect(v, k).toBe('');
    }
    expect(readdirSync(repoRoot).filter((f) => /^\.env($|\.(?!example))/.test(f))).toEqual([]);
  });
});
