// f0-sensor (SIMULATED_INPUT): a labelled simulator. It is NOT an authenticated physical sensor or deployed edge
// process and cannot pass the real-sensor gate. Emits JSON lines of observations relative to argv[2] (epoch ms).
const now = Number(process.argv[2]);
const base = {
  source: 'SIMULATED_INPUT',
  deviceId: 'sim-cooler-01',
  channel: 'cabinet_air',
  unit: 'milli_degC',
  bootId: 'sim-boot-1',
  authenticated: false,
};
const rows = [
  { scenario: 'normal', seq: 1, sourceTimeMs: now - 5_000, valueMilliC: 3_200 },
  { scenario: 'controlled_breach_simulated', seq: 2, sourceTimeMs: now - 4_000, valueMilliC: 9_800 },
  { scenario: 'stale_in_range', seq: 3, sourceTimeMs: now - 20 * 60_000, valueMilliC: 3_100 },
  { scenario: 'replayed_sequence', seq: 3, sourceTimeMs: now - 2_000, valueMilliC: 3_000 },
  { scenario: 'restored', seq: 4, sourceTimeMs: now - 1_000, valueMilliC: 3_400 },
];
for (const r of rows) process.stdout.write(`${JSON.stringify({ ...base, ...r, receiveTimeMs: now })}\n`);
