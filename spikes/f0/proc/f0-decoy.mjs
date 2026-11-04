// Control process: an ordinary Node process (no --disable-sigusr1) with a non-secret canary in its env.
// The launcher uses it to show the ps -E and SIGUSR1 inspector probes are real techniques, so their failure
// against the broker is meaningful.
process.send?.({ type: 'ready' });
setInterval(() => {}, 1000);
process.on('message', (m) => {
  if (m.type === 'stop') process.exit(0);
});
