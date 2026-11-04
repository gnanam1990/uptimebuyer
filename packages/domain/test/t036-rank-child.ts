// T-036 second process: rank the shared tie-break scenario with the candidate order permuted by argv seeds and
// print the rankings and plan hashes as JSON on stdout. Started by t036-tie-break.test.ts with its own Node binary.
import { rankWithSeed } from './t036-fixture.js';

const seeds = process.argv.slice(2).map((s) => Number.parseInt(s, 10));
process.stdout.write(JSON.stringify(seeds.map((seed) => ({ seed, ...rankWithSeed(seed) }))));
