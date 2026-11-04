#!/usr/bin/env node
// One documented command: validate configuration, migrate and seed the isolated database, then run the canonical suite.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { migrate, requireDatabaseUrl, seed } from './db.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major !== 22) throw new Error(`Node 22 is required (found ${process.version}); see .node-version`);
if (!existsSync('pnpm-lock.yaml')) throw new Error('pnpm-lock.yaml missing; installs must use the committed lockfile');
const url = requireDatabaseUrl();
execFileSync('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit' });
console.log(JSON.stringify({ migrated: await migrate(url) }));
await seed(url);
execFileSync('pnpm', ['verify'], { stdio: 'inherit' });
