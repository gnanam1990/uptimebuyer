// T-029 — Live-shaped provider adapter contract: wire schemas, normalization, fixture classification and the
// configuration-gated paid candidate shells (StablePhone / StableEmail / StableEnrich). Unit level: no database and
// no network (fetch is spied and must never be called).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContactAckSchema,
  FixtureProviderTransport,
  LocalChannelTransport,
  PAID_CANDIDATE_PROVIDERS,
  ProviderErrorBodySchema,
  ProviderSearchPageSchema,
  normalizePostalCode,
  normalizeProviderName,
  paidCandidateShell,
  serviceAreaMatch,
} from '../src/index.js';
import { FIXTURE } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('T-029 live-shaped provider adapter contract (schemas)', () => {
  it('accepts the synthetic live-shaped page and strips unknown provider fields', () => {
    const page = ProviderSearchPageSchema.parse({ ...FIXTURE.searchPages.first.body, vendorDebug: 'x' });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe('page-2');
    expect(Object.keys(page)).not.toContain('vendorDebug');
    expect(page.items[0]!.price).toEqual({ amountMinor: 9500n, currency: 'GBP', basis: 'CALLOUT' });
  });

  it.each([
    [
      'float price',
      (i: Record<string, unknown>) => ({ ...i, price: { amountMinor: '95.00', currency: 'GBP', basis: 'CALLOUT' } }),
    ],
    [
      'unknown currency',
      (i: Record<string, unknown>) => ({ ...i, price: { amountMinor: '9500', currency: 'XXQ', basis: 'CALLOUT' } }),
    ],
    ['negative ETA', (i: Record<string, unknown>) => ({ ...i, etaMinutes: -1 })],
    [
      'availability word',
      (i: Record<string, unknown>) => ({ ...i, availability: { status: 'MAYBE', nextWindowAt: null } }),
    ],
    ['missing name', (i: Record<string, unknown>) => ({ ...i, name: undefined })],
    ['oversized name', (i: Record<string, unknown>) => ({ ...i, name: 'x'.repeat(500) })],
    [
      'too many contacts',
      (i: Record<string, unknown>) => ({ ...i, contacts: Array(9).fill({ channel: 'API', value: 'a-1' }) }),
    ],
  ])('rejects a malformed item: %s', (_label, mutate) => {
    const item = mutate(structuredClone(FIXTURE.searchPages.first.body.items[0]));
    expect(
      ProviderSearchPageSchema.safeParse({ schema: 'provider-search-page.v1', items: [item], nextCursor: null })
        .success,
    ).toBe(false);
  });

  it('bounds page size and cursor length', () => {
    const item = FIXTURE.searchPages.first.body.items[0];
    expect(
      ProviderSearchPageSchema.safeParse({
        schema: 'provider-search-page.v1',
        items: Array(51).fill(item),
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      ProviderSearchPageSchema.safeParse({ schema: 'provider-search-page.v1', items: [], nextCursor: 'c'.repeat(600) })
        .success,
    ).toBe(false);
  });

  it('parses the contact acknowledgement, consent and quote schemas', () => {
    const ack = ContactAckSchema.parse(FIXTURE.contactQuoted.body);
    expect(ack.status).toBe('quoted');
    expect(ack.consent).toEqual({ recording: 'NOT_APPLICABLE', processing: 'GRANTED' });
    expect(ack.quote).toMatchObject({ amountMinor: 18500n, taxMinor: 3700n, currency: 'GBP', etaMinutes: 120 });
    expect(ContactAckSchema.parse(FIXTURE.contactDeclined.body).status).toBe('declined');
    expect(ContactAckSchema.safeParse({ ...FIXTURE.contactQuoted.body, status: 'done!' }).success).toBe(false);
  });

  it('parses rate-limit and provider-error bodies', () => {
    expect(ProviderErrorBodySchema.parse(FIXTURE.rateLimited.body).error).toEqual({
      kind: 'RATE_LIMITED',
      retryAfterMs: 30000,
    });
    expect(ProviderErrorBodySchema.parse(FIXTURE.providerError.body).error).toMatchObject({
      kind: 'PROVIDER_ERROR',
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(ProviderErrorBodySchema.parse(FIXTURE.lookupUnsupported.body).error.kind).toBe('LOOKUP_UNSUPPORTED');
  });

  it('normalizes identity and service area deterministically', () => {
    expect(normalizeProviderName('  FrostFix   Refrigeration Ltd. ')).toBe('frostfix refrigeration ltd');
    expect(normalizeProviderName('Ｃoldline​ Service, Co')).toBe('coldline service co');
    expect(normalizePostalCode('sw1a 1aa')).toBe('SW1A1AA');
    expect(
      serviceAreaMatch({ countries: ['GB'], postalPrefixes: ['SW1'] }, { country: 'GB', postalCode: 'SW1A1AA' }),
    ).toBe('IN_AREA');
    expect(
      serviceAreaMatch({ countries: ['GB'], postalPrefixes: ['E1'] }, { country: 'GB', postalCode: 'SW1A1AA' }),
    ).toBe('OUT_OF_AREA');
    expect(serviceAreaMatch({ countries: [], postalPrefixes: [] }, { country: 'GB', postalCode: null })).toBe(
      'UNKNOWN',
    );
  });

  it('labels every non-live transport by class', () => {
    expect(new FixtureProviderTransport('SYNTHETIC_FIXTURE').adapterClass).toBe('SYNTHETIC_FIXTURE');
    expect(new FixtureProviderTransport('RECORDED_FIXTURE').adapterClass).toBe('RECORDED_FIXTURE');
    expect(new LocalChannelTransport('EMAIL').adapterClass).toBe('LOCAL_FAKE');
    expect(FIXTURE.fixtureClass).toBe('SYNTHETIC_FIXTURE');
    expect(FIXTURE.realProbe).toBe('NOT_RUN');
  });

  it('paid candidate shells report UNSUPPORTED / NOT_RUN without credentials and never reach the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(PAID_CANDIDATE_PROVIDERS).toEqual(['stablephone', 'stableemail', 'stableenrich']);
    for (const name of PAID_CANDIDATE_PROVIDERS) {
      const shell = paidCandidateShell(name, {});
      expect(shell.paid).toBe(true);
      expect(shell.ownerService).toBe('KITE_BROKER_PAID');
      expect(shell.fulfillment).toBe('NOT_RUN');
      expect(shell.assess()).toEqual({ kind: 'UNSUPPORTED', reasonCode: 'CANDIDATE_NOT_CONFIGURED' });
      await expect(shell.execute()).rejects.toMatchObject({ code: 'DEPENDENCY_FAILED' });
      // Even when configured, M07 can never execute paid egress: the broker owns it.
      const configured = paidCandidateShell(name, {
        [`UPTIMEBUYER_CANDIDATE_${name.toUpperCase()}`]: 'catalog-2026-11-04',
      });
      expect(configured.assess()).toEqual({ kind: 'UNSUPPORTED', reasonCode: 'PAID_EGRESS_BROKER_ONLY' });
      expect(configured.fulfillment).toBe('NOT_RUN');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
