#!/usr/bin/env node
// Dependency and license check against the committed lockfile (M13; SECURITY.md §11, ADR 0008). Offline only: it
// reads package.json files, pnpm-lock.yaml and the installed package manifests, and never contacts a registry or
// uploads anything.
// - RANGE_SPECIFIER: every dependency is exact-pinned (or a workspace link);
// - LOCKFILE_DRIFT: every declared dependency appears in the lockfile importer with the same specifier;
// - LICENSE_NOT_ALLOWED / LICENSE_UNKNOWN: every locked package's declared license satisfies
//   config/security/license-policy.json (SPDX OR = any branch allowed, AND = all allowed; reviewed exceptions by name);
// - NOT_INSTALLED: a locked, non-platform-specific package has no installed manifest (run a frozen install first);
// - ADVISORY_MATCH: a locked name@version is in the offline advisory list config/security/advisories.json.
// Exit 1 on any finding.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '');

function workspacePackageJsons(root) {
  const out = [{ rel: '.', file: path.join(root, 'package.json') }];
  const ws = path.join(root, 'pnpm-workspace.yaml');
  if (!existsSync(ws)) return out;
  for (const line of readFileSync(ws, 'utf8').split('\n')) {
    const m = /^\s*-\s*['"]?([^'"]+?)\/\*['"]?\s*$/.exec(line);
    if (!m) continue;
    const dir = path.join(root, m[1]);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name, 'package.json');
      if (existsSync(file)) out.push({ rel: `${m[1]}/${name}`, file });
    }
  }
  return out;
}

/** Minimal parser for the pnpm v9 lockfile sections this check needs. */
export function parseLockfile(text) {
  const importers = {};
  const packages = {};
  let section = null;
  let importer = null;
  let group = null;
  let dep = null;
  let pkg = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      section = line.replace(/:$/, '');
      importer = group = dep = pkg = null;
      continue;
    }
    if (section === 'importers') {
      if (indent === 2) {
        importer = unquote(line.replace(/:$/, ''));
        importers[importer] = {};
      } else if (indent === 4) group = line.replace(/:$/, '');
      else if (indent === 6) {
        dep = unquote(line.replace(/:$/, ''));
        importers[importer][dep] = { group };
      } else if (indent === 8 && dep) {
        const m = /^(specifier|version):\s*(.+)$/.exec(line);
        if (m) importers[importer][dep][m[1]] = unquote(m[2]);
      }
    } else if (section === 'packages') {
      if (indent === 2) {
        const key = unquote(line.replace(/:$/, ''));
        const at = key.lastIndexOf('@');
        pkg = { name: key.slice(0, at), version: key.slice(at + 1), platform: false };
        packages[key] = pkg;
      } else if (pkg && indent === 4 && /^(os|cpu|libc):/.test(line)) pkg.platform = true;
    }
  }
  return { importers, packages };
}

function installedManifest(root, name, version) {
  const store = path.join(root, 'node_modules', '.pnpm');
  if (!existsSync(store)) return null;
  const prefix = `${name.replace('/', '+')}@${version}`;
  for (const dir of readdirSync(store)) {
    if (dir !== prefix && !dir.startsWith(`${prefix}_`) && !dir.startsWith(`${prefix}(`)) continue;
    const file = path.join(store, dir, 'node_modules', name, 'package.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  }
  return null;
}

function licenseOf(manifest) {
  const l = manifest.license ?? manifest.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l))
    return l
      .map((x) => (typeof x === 'string' ? x : x?.type))
      .filter(Boolean)
      .join(' OR ');
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
  return null;
}

/** SPDX expression check: OR needs one allowed branch, AND needs every term allowed. */
export function licenseAllowed(expr, allowed) {
  const clean = expr.replace(/[()]/g, ' ').trim();
  return clean
    .split(/\s+OR\s+/i)
    .some((branch) => branch.split(/\s+AND\s+/i).every((term) => allowed.includes(term.trim().replace(/\+$/, ''))));
}

function loadDefaults(root) {
  const read = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
  return {
    licensePolicy: read(path.join(root, 'config', 'security', 'license-policy.json'), {
      allowed: [],
      reviewedExceptions: [],
    }),
    advisories: read(path.join(root, 'config', 'security', 'advisories.json'), { advisories: [] }).advisories,
  };
}

export function checkDependencies(root = repo, opts = {}) {
  const { licensePolicy, advisories } = { ...loadDefaults(root), ...opts };
  const findings = [];
  const add = (rule, where, detail) => findings.push({ rule, file: where, detail });
  const lock = parseLockfile(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));

  for (const { rel, file } of workspacePackageJsons(root)) {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(pkg[group] ?? {})) {
        if (spec !== 'workspace:*' && !EXACT.test(String(spec))) add('RANGE_SPECIFIER', rel, `${name}@${spec}`);
        const locked = lock.importers[rel]?.[name];
        if (!locked || locked.specifier !== spec)
          add('LOCKFILE_DRIFT', rel, `${name}: package.json ${spec}, lockfile ${locked?.specifier ?? 'absent'}`);
      }
    }
  }

  const exceptions = licensePolicy.reviewedExceptions ?? [];
  for (const [key, p] of Object.entries(lock.packages)) {
    for (const a of advisories ?? [])
      if (a.package === p.name && (a.versions ?? []).includes(p.version))
        add('ADVISORY_MATCH', key, `${a.id} (${a.severity})`);
    const manifest = installedManifest(root, p.name, p.version);
    if (!manifest) {
      if (!p.platform) add('NOT_INSTALLED', key, 'no installed manifest (run a frozen install)');
      continue;
    }
    const lic = licenseOf(manifest);
    if (!lic) {
      add('LICENSE_UNKNOWN', key, 'no license declared');
      continue;
    }
    if (licenseAllowed(lic, licensePolicy.allowed ?? [])) continue;
    const ok = exceptions.some(
      (e) => (e.package === p.name || (e.packagePrefix && p.name.startsWith(e.packagePrefix))) && e.license === lic,
    );
    if (!ok) add('LICENSE_NOT_ALLOWED', key, lic);
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkDependencies(repo);
  for (const f of findings) console.error(`FINDING ${f.rule} ${f.file}: ${f.detail}`);
  const lock = parseLockfile(readFileSync(path.join(repo, 'pnpm-lock.yaml'), 'utf8'));
  console.log(JSON.stringify({ packagesChecked: Object.keys(lock.packages).length, findings: findings.length }));
  process.exit(findings.length ? 1 : 0);
}
