// @uptimebuyer/evidence — M05 evidence and manual reasoning: content-addressed document store, bounded parsing,
// exact asset-revision retrieval with re-openable citations and preserved conflicts, immutable evidence revisions
// with supersession events, and bounded SERV reasoning whose output is a proposal only (INV-02).
export * from './ids.js';
export * from './limits.js';
export * from './object-store.js';
export {
  PARSER_VERSION,
  SUPPORTED_MEDIA_TYPES,
  extractFacts,
  normalizeComponent,
  parseCsv,
  parseDocument,
  textDigest,
  type ExtractedFact,
  type ParsedDocument,
  type ParsedExtractionMethod,
  type ParsedSpan,
  type SupportedMediaType,
} from './parse.js';
export * from './untrusted.js';
export {
  DOCUMENT_ROLES,
  DOCUMENT_SOURCE_KINDS,
  getDocument,
  ingestDocument,
  ingestDocumentInTx,
  withdrawConsentedCommunicationsInTx,
  withdrawDocument,
  type DocumentRecord,
  type DocumentRole,
  type DocumentSourceKind,
  type IngestDocumentInput,
  type IngestedDocument,
} from './documents.js';
export {
  commitIncidentEvidence,
  getEvidenceRevision,
  refreshEvidenceForAsset,
  type AssetSnapshot,
  type ConflictRecord,
  type EvidenceCommitResult,
  type EvidenceRevisionView,
} from './revisions.js';
export {
  queryTerms,
  reopenCitation,
  retrieveEvidence,
  searchEvidence,
  type EvidenceRetrieval,
  type FactSourceView,
  type FactView,
  type ReopenedCitation,
  type SearchHit,
} from './retrieval.js';
export * from './events.js';
export * from './reasoning/schema.js';
export * from './reasoning/port.js';
export { REASONING_TOOLS, TOOL_NAMES, SearchEvidenceArgsSchema } from './reasoning/tools.js';
export { SERV_CHAT_COMPLETIONS_URL, SERV_ORIGIN, ServReasoningAdapter, type ServAdapterOptions } from './reasoning/serv-adapter.js';
export { ContractFakeReasoner, type FakeScript } from './reasoning/contract-fake.js';
export {
  PROMPT_TEMPLATE_DIGEST,
  SYSTEM_PROMPT,
  getProposal,
  getReasoningRun,
  listIncidentProposals,
  runReasoning,
  type ProposalAnnotations,
  type ProposalView,
  type ReasoningDeps,
  type ReasoningRunResult,
  type ReasoningRunView,
  type ResultOrigin,
  type RunDisposition,
  type RunStatus,
} from './reasoning/run.js';
