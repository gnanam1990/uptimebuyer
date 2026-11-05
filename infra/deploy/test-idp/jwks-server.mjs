// Smoke-only test identity provider (M14, T-057 local layer). Serves ONE static JWKS document (public keys only) on
// 127.0.0.1:8090 inside the API container's network namespace, so the API reaches it over loopback (the only place
// apps/api accepts plain http for an IdP). The matching private key stays in the smoke run's temporary directory on
// the host, where scripts/release/smoke.mjs mints short-lived test tokens. Never part of a deployment.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const body = readFileSync('/idp/jwks.json', 'utf8');
JSON.parse(body);
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/jwks') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(body);
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not_found"}');
}).listen(8090, '127.0.0.1', () => console.log(JSON.stringify({ event: 'test-idp.listening' })));
