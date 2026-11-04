// Structured broker log (NFR-09, INV-13). Events carry only primitive, non-secret fields chosen by the caller; every
// line is additionally scrubbed of each registered secret value before it is written. No error object, request body,
// header or provider payload is ever logged.
export class BrokerLog {
  readonly #secrets: string[] = [];
  constructor(private readonly sink: (line: string) => void = (l) => process.stderr.write(`${l}\n`)) {}

  registerSecret(value: string | undefined | null) {
    if (value && value.length >= 8) this.#secrets.push(value);
  }

  event(name: string, fields: Record<string, string | number | boolean | null> = {}) {
    let line = JSON.stringify({ at: new Date().toISOString(), service: 'kite-broker', event: name, ...fields });
    for (const s of this.#secrets) line = line.split(s).join('[REDACTED]');
    this.sink(line);
  }
}
