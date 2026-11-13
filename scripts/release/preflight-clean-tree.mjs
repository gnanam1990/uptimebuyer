#!/usr/bin/env node
// T-060 `clean-tree` preflight for RELEASE_TAG and REPO_PUBLICATION (config/release/gates.json; PR #26 review). Signing
// an authorization writes its record into evidence/authorizations/ before the gate check, so a strict "git status is
// empty" fails when the guide is followed in order. This check tolerates exactly one untracked file, the record being
// used (--allow-record evidence/authorizations/<GATE>.<id>.json); any other untracked, modified, staged, deleted or
// renamed path, another record or the decision log keeps the tree dirty. With --source-sha it also requires HEAD to be
// that commit. Read-only: it runs `git status` and `git rev-parse` and prints one JSON line.
//   node scripts/release/preflight-clean-tree.mjs [--repo <dir>] [--source-sha <40-hex>] [--allow-record <path>]
// Exit 0 when clean, 1 when not, 2 on a usage error.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECORD = /^evidence\/authorizations\/[A-Z_]+\.auth-[a-z0-9-]+\.json$/;

/**
 * Decide from `git status --porcelain=v1 -z --untracked-files=all` output. Only an untracked (`??`) entry whose path is
 * exactly `allowRecord` is tolerated. Returns { clean, offending } (offending entries as `XY path`).
 */
export function cleanTreeFromStatus(porcelainZ, { allowRecord } = {}) {
  if (allowRecord !== undefined && !RECORD.test(allowRecord))
    throw new Error('allow-record must be one authorization record path, evidence/authorizations/<GATE>.<id>.json');
  const fields = porcelainZ.split('\0');
  const offending = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    // Renames and copies carry the original path as the next field.
    if (xy[0] === 'R' || xy[0] === 'C') {
      offending.push(`${xy} ${file} <- ${fields[++i] ?? ''}`);
      continue;
    }
    if (xy === '??' && allowRecord !== undefined && file === allowRecord) continue;
    offending.push(`${xy} ${file}`);
  }
  return { clean: offending.length === 0, offending };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const root = path.resolve(val('--repo') ?? repo);
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
    const sourceSha = val('--source-sha');
    if (sourceSha !== undefined && !/^[0-9a-f]{40}$/.test(sourceSha))
      throw new Error('source-sha must be a full 40-character lower-case commit id');
    const head = git('rev-parse', 'HEAD').trim();
    const status = cleanTreeFromStatus(git('status', '--porcelain=v1', '-z', '--untracked-files=all'), {
      allowRecord: val('--allow-record'),
    });
    const atSource = sourceSha === undefined || head === sourceSha;
    const result = {
      'clean-tree': status.clean && atSource,
      head,
      ...(sourceSha !== undefined ? { sourceSha } : {}),
      ...(atSource ? {} : { reason: 'HEAD_IS_NOT_SOURCE' }),
      allowedRecord: val('--allow-record') ?? null,
      offending: status.offending,
    };
    console.log(JSON.stringify(result));
    process.exitCode = result['clean-tree'] ? 0 : 1;
  } catch (e) {
    console.error(`preflight-clean-tree: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}
