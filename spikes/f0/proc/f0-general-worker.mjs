// f0-general-worker: ordinary work succeeds; it holds no Kite credential and runs the bypass battery.
import { sha256 } from '../lib/canonical.mjs';
import { runProbes } from '../lib/probes.mjs';
import { serveRole } from '../lib/role.mjs';

serveRole('f0-general-worker', {
  async ordinaryWork({ url }) {
    const digest = sha256('ordinary non-payment job payload');
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { digest: digest.slice(0, 16), generalEndpointStatus: r.status };
  },
  probes: (args) => runProbes(args),
  exit: () => 'bye',
});
