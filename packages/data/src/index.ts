// @uptimebuyer/data — PostgreSQL storage, tenant-scoped repositories, principal authentication, RBAC authority,
// transactional outbox and jobs (M02). Every repository call takes a server-issued TenantContext.
export { withTransaction, type Db, type Tx, type Queryable } from './db.js';
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
} from './context.js';
export {
  HumanOidcVerifier,
  InMemoryCredentialResolver,
  authenticateDevice,
  authenticateHuman,
  authenticateIntegration,
  authenticateService,
  peekMachineTokenSubject,
  signPrincipalToken,
  verifyMachineTokenOffline,
  type CredentialResolver,
  type HumanSessionVerifier,
  type MachineAuthFailureReason,
  type MachinePrincipalKind,
} from './auth.js';
export * from './authz.js';
export { recordAudit, resourceUnavailable, type AuditInput } from './command.js';
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
export * from './tenant-scope.js';
export * from './telemetry.js';
