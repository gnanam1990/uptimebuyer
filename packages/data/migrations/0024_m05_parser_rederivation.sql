-- M05 parser re-derivation (uptimebuyer-parser.v3; FR-05, NFR-04, INV-10, T-021, T-024; journey T-058).
-- A document row records one derivation of an immutable blob: its spans were produced by `parser_version`. The PDF
-- font decoder (v3) changes what is extracted from font-encoded PDFs, so the same blob, role and applicability may now
-- have one derivation per parser version. A re-derivation is a NEW document row that supersedes the older one (which
-- is withdrawn through the append-only event log); no recorded span is ever rewritten, and citations over the older
-- derivation keep re-opening with the parser version recorded on its row.
--
-- Rolling-deployment note (migrations README): this replaces a unique constraint in one step, which code older than
-- this migration cannot use (its ON CONFLICT names the four-column key). No database outside throwaway test and
-- journey databases exists yet (nothing is deployed, T-057 is NOT_RUN), so there is no running reader of the old shape.
ALTER TABLE evidence_documents
  DROP CONSTRAINT evidence_documents_tenant_id_blob_id_role_applicability_dig_key;
ALTER TABLE evidence_documents
  ADD CONSTRAINT evidence_documents_derivation_key UNIQUE (tenant_id, blob_id, role, applicability_digest, parser_version);

-- Why some PDF text was withheld instead of shown (U+FFFD in the spans): the font could not be decoded. Existing rows
-- were derived by parsers that never withheld text.
ALTER TABLE evidence_documents
  ADD COLUMN text_withheld text[] NOT NULL DEFAULT '{}'
    CHECK (text_withheld <@ ARRAY['CMAP_REFUSED', 'CODE_POINT_INVALID', 'FONT_ENCODING_UNKNOWN', 'GLYPH_UNMAPPED']::text[]);
