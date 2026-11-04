// Shared IPC harness for spike role processes (worker, serv, client). Ops arrive from the launcher over IPC.
export function serveRole(role, ops) {
  process.on('message', async (m) => {
    try {
      const fn = ops[m.op];
      if (!fn) throw new Error(`unknown op ${m.op}`);
      process.send({ id: m.id, ok: true, result: await fn(m.args ?? {}) });
    } catch (e) {
      process.send({ id: m.id, ok: false, error: e.message });
    }
    if (m.op === 'exit') process.disconnect();
  });
  process.send({ type: 'ready', role, pid: process.pid, sandboxed: process.env.F0_SANDBOXED === '1' });
}
