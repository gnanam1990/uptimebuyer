// Storage-local identifier kinds for M07 tables (same opaque '<prefix>_<body>' form as @uptimebuyer/contracts; the
// SQL ub_id_ok checks enforce each prefix). Contact requests use the contracts `pcr` prefix.
import { randomUUID } from 'node:crypto';

export const PROVIDER_ID_PREFIXES = Object.freeze({
  serviceProvider: 'spr',
  contactPoint: 'spc',
  search: 'psh',
  searchResult: 'psx',
  attempt: 'pca',
  attemptEvent: 'pce',
  consent: 'pcs',
  communication: 'pcm',
  quote: 'pqt',
  notification: 'ntf',
  brokerReceipt: 'pbr',
  communicationBody: 'pcb',
  commandReceipt: 'pck',
  contactPointReview: 'spv',
} as const);
export type ProviderIdKind = keyof typeof PROVIDER_ID_PREFIXES;

export const newProviderId = (kind: ProviderIdKind): string => `${PROVIDER_ID_PREFIXES[kind]}_${randomUUID()}`;

export const isProviderId = (kind: ProviderIdKind, v: unknown): v is string =>
  typeof v === 'string' && new RegExp(`^${PROVIDER_ID_PREFIXES[kind]}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$`).test(v);
