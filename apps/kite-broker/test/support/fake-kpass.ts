// A local stand-in for the `kpass` binary (tests only; NOT Kite). It answers each command with a scripted
// { exitCode, json } taken in order from a per-command queue (documented-example fixtures, see
// test/fixtures/kpass-6.13.2-documented.ts), logs every invocation's argv, environment NAMES, HOME and cwd, and can
// sleep past the adapter timeout. Nothing here touches the network or a real account.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Scripted {
  exitCode: number;
  json?: unknown;
  /** Raw stdout instead of JSON. */
  raw?: string;
  /** Sleep this long before answering (to exceed the adapter timeout). */
  sleepMs?: number;
}

export interface FakeKpass {
  bin: string;
  dir: string;
  /** Queue answers for a command key such as 'session create', 'session status', 'session execute', 'status'. */
  script(command: string, ...answers: Scripted[]): void;
  calls(): { args: string[]; env: string[]; home: string; cwd: string }[];
  callsOf(command: string): { args: string[]; env: string[]; home: string; cwd: string }[];
}

export function fakeKpass(): FakeKpass {
  const dir = mkdtempSync(join(tmpdir(), 'ub-fake-kpass-'));
  chmodSync(dir, 0o700);
  const bin = join(dir, 'kpass');
  const queue = join(dir, 'queue.json');
  const log = join(dir, 'calls.log');
  writeFileSync(queue, '{}');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: Object.keys(process.env).sort(), home: process.env.HOME, cwd: process.cwd() }) + '\\n');
const words = args.filter((a) => !a.startsWith('-'));
const key = words[0] === 'session' || words[0] === 'allowance' || words[0] === 'wallet' ? words.slice(0, 2).join(' ') : words[0];
const q = JSON.parse(fs.readFileSync(${JSON.stringify(queue)}, 'utf8'));
const list = q[key] ?? [];
const next = list.length > 1 ? list.shift() : list[0];
fs.writeFileSync(${JSON.stringify(queue)}, JSON.stringify(q));
if (!next) { process.stdout.write(JSON.stringify({ status: 'error', error: 'unscripted ' + key })); process.exit(99); }
const answer = () => {
  process.stdout.write(next.raw !== undefined ? next.raw : JSON.stringify(next.json ?? {}));
  process.exit(next.exitCode);
};
if (next.sleepMs) setTimeout(answer, next.sleepMs); else answer();
`,
  );
  chmodSync(bin, 0o700);
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { args: string[]; env: string[]; home: string; cwd: string })
      : [];
  return {
    bin,
    dir,
    script(command, ...answers) {
      const q = JSON.parse(readFileSync(queue, 'utf8')) as Record<string, Scripted[]>;
      q[command] = [...(q[command] ?? []), ...answers];
      writeFileSync(queue, JSON.stringify(q));
    },
    calls,
    callsOf(command) {
      const [a, b] = command.split(' ');
      return calls().filter((c) => {
        const words = c.args.filter((x) => !x.startsWith('-'));
        return words[0] === a && (b === undefined || words[1] === b);
      });
    },
  };
}
