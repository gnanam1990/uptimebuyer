-- M05 document lineage (PR #20 review of the parser re-derivation in 0024; FR-05, INV-10, T-024; journey T-058).
-- A document lineage is one blob under one role and applicability: every parser derivation of it is a separate row.
-- A re-derivation now names the older derivation in its own column, so `supersedes_document_id` keeps meaning an
-- explicit replacement only, and a re-ingest that both replaces another document and re-derives these bytes records
-- both relationships. The composite key enforces that a re-derivation names a row of the same blob.
-- Additive only: existing rows keep NULL (none of them re-derived anything before this column existed outside the
-- throwaway databases 0024 ran in).
ALTER TABLE evidence_documents
  ADD COLUMN rederived_from_document_id text,
  ADD CONSTRAINT evidence_documents_rederived_from_fkey
    FOREIGN KEY (tenant_id, rederived_from_document_id, blob_id) REFERENCES evidence_documents (tenant_id, id, blob_id),
  ADD CONSTRAINT evidence_documents_rederived_from_not_self CHECK (rederived_from_document_id IS DISTINCT FROM id),
  ADD CONSTRAINT evidence_documents_rederivation_not_replacement
    CHECK (rederived_from_document_id IS NULL OR rederived_from_document_id IS DISTINCT FROM supersedes_document_id);
