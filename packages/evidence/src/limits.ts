// Explicit resource bounds (NFR-04). Every ingestion, retrieval and reasoning path enforces these; exceeding one is a
// typed rejection, never silent truncation of evidence.
export const DOCUMENT_LIMITS = Object.freeze({
  /** Raw document size accepted for parsing and storage. */
  maxBytes: 8 * 1024 * 1024,
  /** PDF pages or form-feed pages. */
  maxPages: 400,
  /** Indirect objects scanned in one PDF (including those inside object streams). */
  maxPdfObjects: 20_000,
  /** Total bytes produced by all decompression in one PDF (bomb guard). */
  maxInflatedBytes: 32 * 1024 * 1024,
  /** Decompressed size of a single stream. */
  maxStreamInflatedBytes: 16 * 1024 * 1024,
  /** Extracted text characters per document (roughly 500k tokens). */
  maxChars: 2_000_000,
  /** Characters per span; longer pages are chunked into several spans with the same page locator. */
  maxSpanChars: 4_000,
  /** Spans per document. */
  maxSpans: 5_000,
  /** CSV records per document. */
  maxRecords: 5_000,
  /** CSV columns per record and characters per field. */
  maxColumns: 64,
  maxFieldChars: 2_000,
  /** Page-tree depth. */
  maxTreeDepth: 32,
  /** Distinct fonts resolved in one PDF (each is decoded once and cached). */
  maxFonts: 512 as number,
  /** Decoded size of one ToUnicode CMap program. */
  maxCMapBytes: (512 * 1024) as number,
  /** Code mappings defined by one CMap (a full 2-byte code space is 65,536); counted before a range is expanded. */
  maxCMapMappings: 65_536 as number,
  /** Code mappings across every CMap of one PDF (bounds memory for documents with many embedded fonts). */
  maxCMapMappingsTotal: 262_144 as number,
  /** Indirect-reference hops followed to resolve one font, resource or encoding object (cycles are refused). */
  maxRefHops: 8 as number,
  /** Body size of one font, encoding or resource dictionary object; larger ones are unresolvable (text withheld). */
  maxFontObjectBytes: (64 * 1024) as number,
});

export const RETRIEVAL_LIMITS = Object.freeze({
  /** Documents in one evidence revision. */
  maxDocumentsPerRevision: 200,
  /** Search results per query. */
  maxSearchResults: 20,
  /** Characters of a search query. */
  maxQueryChars: 200,
  /** Search terms used from one query. */
  maxQueryTerms: 12,
});

export const REASONING_LIMITS = Object.freeze({
  /** Model turns per run (each tool round-trip is one turn). */
  maxTurns: 4,
  /** Tool calls per run. */
  maxToolCalls: 6,
  /** Per-call timeout and whole-run deadline. */
  callTimeoutMs: 60_000,
  runTimeoutMs: 150_000,
  /** Serialized model input characters (~15k tokens) and per-excerpt characters. */
  maxInputChars: 60_000,
  maxExcerpts: 16,
  maxExcerptChars: 900,
  /** Model output: completion tokens requested and characters accepted. */
  maxOutputTokens: 4_096,
  maxOutputChars: 64_000,
  /** Raw HTTP response bytes accepted from the model endpoint. */
  maxResponseBytes: 1024 * 1024,
  /** Search hits returned to the model per tool call. */
  maxToolResults: 8,
  /**
   * M13 (T-054): cumulative prompt + completion tokens per run. Reported usage is charged exactly; unreported usage is
   * charged by a conservative character estimate (4 characters per token) so a run without usage data stays bounded.
   */
  maxRunTokens: 120_000,
});
