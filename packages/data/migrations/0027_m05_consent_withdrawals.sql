-- M05 consent withdrawals (PR #20 second review; INV-13, FR-05, T-024; journey T-058).
-- A withdrawn processing consent is recorded once per consent reference, append-only, by the same transaction that
-- withdraws the documents carrying it (withdrawConsentedCommunicationsInTx). Ingestion and re-derivation of a document
-- with a consent reference take the same per-consent advisory lock and refuse a withdrawn reference, so no committed
-- active document can carry a withdrawn consent (including one recorded after the withdrawal, through any path).
CREATE TABLE evidence_consent_withdrawals (
  tenant_id text NOT NULL REFERENCES tenants (id),
  id text NOT NULL CHECK (ub_id_ok(id, 'dcw')),
  consent_ref text NOT NULL CHECK (length(consent_ref) BETWEEN 1 AND 200),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('WORKER')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, consent_ref)
);
SELECT ub_make_append_only('evidence_consent_withdrawals');
