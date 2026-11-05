// @uptimebuyer/data — PostgreSQL storage, tenant-scoped repositories, principal authentication, RBAC authority,
// transactional outbox and jobs (M02). Every repository call takes a server-issued TenantContext.
export {
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  dbNow,
  iso,
  isoNN,
  lockKey,
  pgCode,
  sha256Digest,
  versionConflict,
  withTransaction,
  type Db,
  type Tx,
  type Queryable,
} from './db.js';
export * from './ids.js';
export {
  HUMAN_ROLES,
  ROLES,
  assertAuthenticated,
  assertTenantContext,
  resolveTenantContext,
  withTenantTransaction,
  type AuthenticatedPrincipal,
  type ContextPrincipal,
  type HumanRole,
  type Principal,
  type PrincipalKind,
  type Role,
  type RoleGrant,
  type TenantContext,
  type WorkerPrincipal,
  actorOf,
  humanActor,
} from './context.js';
export {
  HumanOidcVerifier,
  InMemoryCredentialResolver,
  MACHINE_TOKEN_CLOCK_TOLERANCE_SECONDS,
  TOKEN_USE_PRUNE_GRACE_SECONDS,
  authenticateDevice,
  authenticateHuman,
  authenticateIntegration,
  authenticateService,
  peekMachineTokenSubject,
  pruneExpiredTokenUses,
  signPrincipalToken,
  verifyMachineTokenOffline,
  type CredentialResolver,
  type HumanSessionVerifier,
  type MachineAuthFailureReason,
  type MachinePrincipalKind,
} from './auth.js';
export * from './authz.js';
export {
  Denial,
  notPermitted,
  recordAudit,
  resourceUnavailable,
  tenantCommand,
  unavailable,
  type AuditInput,
  type CommandMeta,
} from './command.js';
export * from './audit.js';
export { listSecurityAuditEntries, type SecurityAuditEntry } from './security-audit.js';
export {
  REGISTRY_ENTITY_KINDS,
  REGISTRY_SOURCES,
  AssetIdentitySchema,
  type AssetIdentity,
  type RegistryEntityKind,
  type RegistrySource,
  type SafetyClass,
} from './registry-core.js';
export * from './identity.js';
export * from './registry.js';
export * from './policy.js';
export * from './evidence.js';
export * from './approvals.js';
export * from './outbox.js';
export * from './jobs.js';
export * from './provider-accounts.js';
export * from './privacy.js';
export * from './erasure.js';
export * from './tenant-scope.js';
export * from './telemetry.js';
export { assertTenantSecretRef, isTenantSecretRef } from './secret-ref.js';
export { FileSecretStore, SecretFileError, readSecretFile } from './secret-files.js';
export * from './operator-reads.js';
