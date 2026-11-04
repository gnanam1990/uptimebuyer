// f0-serv: model-shaped process. A real run would hold only an OpenServ API key (none exists: F0-G BLOCKED).
// Here it proves it cannot read the Kite credential or reach the paid destination.
import { runProbes } from '../lib/probes.mjs';
import { serveRole } from '../lib/role.mjs';

serveRole('f0-serv', {
  openServKeyPresent: () => ({ present: false, reason: 'NO_OPENSERV_ACCOUNT_OR_API_KEY' }),
  probes: (args) => runProbes(args),
  exit: () => 'bye',
});
