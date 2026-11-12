-- M05 parser v3 (PR #20 second review; FR-05, NFR-04, T-021): text after an unreadable content-stream part is withheld
-- (its font and graphics state are unknown), recorded with the reason CONTENT_STREAM_UNREADABLE.
ALTER TABLE evidence_documents
  DROP CONSTRAINT evidence_documents_text_withheld_check,
  ADD CONSTRAINT evidence_documents_text_withheld_check CHECK (
    text_withheld <@ ARRAY['CMAP_REFUSED', 'CODE_POINT_INVALID', 'CONTENT_STREAM_UNREADABLE', 'FONT_ENCODING_UNKNOWN',
      'GLYPH_UNMAPPED']::text[]
  );
