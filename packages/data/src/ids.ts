// Storage-local identifier kinds that @uptimebuyer/contracts does not define. Same opaque form
// ('<prefix>_<body>'), so OpaqueIdSchema accepts them; the SQL `ub_id_ok` checks enforce the prefix per table.
import { z } from 'zod';

export const DATA_ID_PREFIXES = Object.freeze({
  membership: 'mbr',
  roleAssignment: 'rla',
  integrationIdentity: 'itg',
  registryRevision: 'rgr',
  deviceAssignment: 'dasg',
  sensorChannel: 'chn',
  sensorChannelRevision: 'chr',
  policy: 'plc',
  approvalEvent: 'ape',
  audit: 'aud',
  securityAudit: 'sau',
  job: 'job',
  webhookDelivery: 'whd',
  approvedVendor: 'vnd',
  legalHold: 'lgh',
  privacyRequest: 'prq',
  redactionTombstone: 'rdt',
  telemetryBatch: 'tbt',
  telemetrySample: 'tsm',
  telemetryRejection: 'trj',
  telemetrySequenceGap: 'tgp',
  telemetryDropDisclosure: 'tdd',
  telemetryChannelHealth: 'thp',
} as const);
export type DataIdKind = keyof typeof DATA_ID_PREFIXES;

const BODY = '[A-Za-z0-9][A-Za-z0-9-]{3,63}';
const dataIdSchema = <K extends DataIdKind>(kind: K) =>
  z
    .string()
    .regex(new RegExp(`^${DATA_ID_PREFIXES[kind]}_${BODY}$`))
    .brand<`${K}Id`>();

export const RoleAssignmentIdSchema = dataIdSchema('roleAssignment');
export const IntegrationIdentityIdSchema = dataIdSchema('integrationIdentity');
export const DeviceAssignmentIdSchema = dataIdSchema('deviceAssignment');
export const SensorChannelIdSchema = dataIdSchema('sensorChannel');
export const SensorChannelRevisionIdSchema = dataIdSchema('sensorChannelRevision');
export const JobIdSchema = dataIdSchema('job');
export const LegalHoldIdSchema = dataIdSchema('legalHold');
export const PrivacyRequestIdSchema = dataIdSchema('privacyRequest');
export const WebhookDeliveryIdSchema = dataIdSchema('webhookDelivery');
export const ApprovedVendorIdSchema = dataIdSchema('approvedVendor');
export const TelemetryBatchIdSchema = dataIdSchema('telemetryBatch');
export const TelemetrySampleIdSchema = dataIdSchema('telemetrySample');

export type RoleAssignmentId = z.infer<typeof RoleAssignmentIdSchema>;
export type IntegrationIdentityId = z.infer<typeof IntegrationIdentityIdSchema>;
export type DeviceAssignmentId = z.infer<typeof DeviceAssignmentIdSchema>;
export type SensorChannelId = z.infer<typeof SensorChannelIdSchema>;
export type SensorChannelRevisionId = z.infer<typeof SensorChannelRevisionIdSchema>;
export type JobId = z.infer<typeof JobIdSchema>;
export type LegalHoldId = z.infer<typeof LegalHoldIdSchema>;
export type PrivacyRequestId = z.infer<typeof PrivacyRequestIdSchema>;
export type WebhookDeliveryId = z.infer<typeof WebhookDeliveryIdSchema>;
export type ApprovedVendorId = z.infer<typeof ApprovedVendorIdSchema>;
export type TelemetryBatchId = z.infer<typeof TelemetryBatchIdSchema>;
export type TelemetrySampleId = z.infer<typeof TelemetrySampleIdSchema>;

export function newDataId<K extends DataIdKind>(kind: K): string {
  return `${DATA_ID_PREFIXES[kind]}_${globalThis.crypto.randomUUID()}`;
}
