// Broker ingress (SECURITY.md §6, INV-06). A node:http server bound ONLY to a unix socket created 0600 inside a 0700
// directory. Each route accepts exactly one strict signed execution reference as the whole body (max 4 KiB); any
// embedded authority field, unknown field or other route is refused before the database is touched. Errors return a
// stable machine code and a safe message only; nothing echoes input, credentials or internal error text.
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import type http from 'node:http';
import { dirname } from 'node:path';
import {
  DomainError,
  ERROR_CLASS_HTTP_STATUS,
  ERROR_CODE_CLASS,
  encodeWire,
  KiteSessionSchema,
} from '@uptimebuyer/contracts';
import { BROKER_ROUTES } from '@uptimebuyer/commerce';
import { CommercialIntentSchema } from '@uptimebuyer/contracts';
import { CommercialIntentStateChangedEventSchema, SignedExecutionReferenceSchema } from '@uptimebuyer/kite-contracts';
import type { KiteBroker } from './broker.js';
import type { BrokerLog } from './log.js';

const MAX_BODY = 4096;

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function errorBody(e: unknown): { status: number; body: unknown } {
  if (e instanceof DomainError) {
    const cls = ERROR_CODE_CLASS[e.code] ?? 'INTERNAL';
    const reason =
      typeof e.details.reasonCode === 'string'
        ? e.details.reasonCode
        : typeof e.details.reason === 'string'
          ? e.details.reason
          : null;
    return {
      status: ERROR_CLASS_HTTP_STATUS[cls],
      body: { error: { code: e.code, reasonCode: reason, message: e.message } },
    };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', reasonCode: null, message: 'Internal broker error.' } } };
}

export function brokerRequestHandler(broker: KiteBroker, log: BrokerLog) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health/live') return send(res, 200, { status: 'live' });
    const route = Object.values(BROKER_ROUTES).find((r) => r === req.url);
    if (req.method !== 'POST' || !route)
      return send(res, 404, {
        error: { code: 'VALIDATION_FAILED', reasonCode: 'ROUTE_NOT_FOUND', message: 'Not found.' },
      });
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY && !aborted) {
        aborted = true;
        send(res, 413, { error: { code: 'VALIDATION_FAILED', reasonCode: 'BODY_TOO_LARGE', message: 'Too large.' } });
        req.destroy();
      } else chunks.push(d);
    });
    req.on('end', async () => {
      if (aborted) return;
      let reference: unknown;
      try {
        reference = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, {
          error: {
            code: 'EXECUTION_REFERENCE_INVALID',
            reasonCode: 'MALFORMED',
            message: 'Execution reference rejected.',
          },
        });
      }
      // Strict shape first: an embedded amount/merchant/limit/endpoint field is refused here, before any lookup.
      if (!SignedExecutionReferenceSchema.safeParse(reference).success) {
        log.event('reference.rejected', { route, reasonCode: 'MALFORMED' });
        return send(res, 403, {
          error: {
            code: 'EXECUTION_REFERENCE_INVALID',
            reasonCode: 'MALFORMED',
            message: 'Execution reference rejected.',
          },
        });
      }
      try {
        if (route === BROKER_ROUTES.ACTIVATE_SESSION) {
          const out = await broker.activateSession(reference);
          log.event('session.activate', { replay: out.replay, outcome: out.session.externalOutcomeState });
          return send(res, 200, { session: encodeWire(KiteSessionSchema, out.session), replay: out.replay });
        }
        const out =
          route === BROKER_ROUTES.EXECUTE ? await broker.execute(reference) : await broker.reconcile(reference);
        log.event(route === BROKER_ROUTES.EXECUTE ? 'intent.execute' : 'intent.reconcile', {
          state: out.intent.state,
          events: out.events.length,
          replay: out.replay,
        });
        return send(res, 200, {
          intent: encodeWire(CommercialIntentSchema, out.intent),
          events: out.events.map((e) => encodeWire(CommercialIntentStateChangedEventSchema, e)),
        });
      } catch (e) {
        const { status, body } = errorBody(e);
        log.event('request.refused', { route, status, code: e instanceof DomainError ? e.code : 'INTERNAL' });
        return send(res, status, body);
      }
    });
  };
}

/** Create the socket directory 0700 (refusing a symlink or a foreign/open directory) and listen 0600. */
export async function listenOnUnixSocket(server: http.Server, socketPath: string): Promise<void> {
  const dir = dirname(socketPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('socket directory must be a real directory');
  if ((st.mode & 0o077) !== 0) throw new Error('socket directory must be 0700');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    throw new Error('socket directory not owned');
  if (existsSync(socketPath)) {
    if (!statSync(socketPath).isSocket()) throw new Error('socket path exists and is not a socket');
    unlinkSync(socketPath);
  }
  const old = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
  } finally {
    process.umask(old);
  }
  chmodSync(socketPath, 0o600);
}
