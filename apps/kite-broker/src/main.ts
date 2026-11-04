// kite-broker entrypoint. Usage: node --disable-sigusr1 dist/main.js --socket <path> (--secret-fd <n> | --secret-file <path>)
// The secret document (database URL, verification keys, the paid-endpoint credential) arrives on the fd or 0600 file
// only; argv and env carry no secret. In TEST mode named crash points SIGKILL the process (T-040 probes).
import http from 'node:http';
import pg from 'pg';
import { BrokerLog } from './log.js';
import { ConfigError, loadSecretFromFd, loadSecretFromFile } from './config.js';
import { brokerFrom } from './factory.js';
import { brokerRequestHandler, listenOnUnixSocket } from './server.js';
import type { BrokerHooks, BrokerPoint } from './broker.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const log = new BrokerLog();
  const socketPath = arg('--socket');
  const fd = arg('--secret-fd');
  const file = arg('--secret-file');
  if (!socketPath || (fd === undefined) === (file === undefined)) {
    log.event('broker.usage_error');
    process.exit(2);
  }
  let cfg;
  try {
    cfg = fd !== undefined ? loadSecretFromFd(Number(fd)) : loadSecretFromFile(file!);
  } catch (e) {
    log.event('broker.config_rejected', { reasonCode: e instanceof ConfigError ? e.reasonCode : 'UNREADABLE' });
    process.exit(78);
  }
  const hooks: BrokerHooks = {};
  if (cfg.mode === 'TEST')
    for (const f of cfg.testFaults ?? []) {
      const point = f as BrokerPoint;
      hooks[point] = () => {
        log.event('broker.test_fault', { point });
        process.kill(process.pid, 'SIGKILL');
      };
    }
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 8 });
  const broker = brokerFrom(pool, cfg, log, hooks);
  const server = http.createServer({ maxHeaderSize: 8192 }, brokerRequestHandler(broker, log));
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  await listenOnUnixSocket(server, socketPath!);
  log.event('broker.listening', {
    adapter: broker.adapter.adapterId,
    origin: broker.adapter.resultOrigin,
    mode: cfg.mode,
  });
  const sweep = async () => {
    try {
      const r = await broker.sweep();
      if (r.intents || r.sessions) log.event('broker.sweep', r);
    } catch {
      log.event('broker.sweep_failed');
    }
  };
  await sweep();
  const timer = setInterval(sweep, Number(arg('--sweep-ms') ?? 5_000));
  const stop = () => {
    clearInterval(timer);
    server.close(() => void pool.end().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(() => {
  process.stderr.write('{"service":"kite-broker","event":"broker.fatal"}\n');
  process.exit(1);
});
