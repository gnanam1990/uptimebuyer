// The reasoning port (NFR-11): every model adapter takes the same bounded request and returns one turn, either tool
// calls or a final JSON document. The adapter never receives database handles, tenant credentials, Kite material or
// a network capability beyond its own fixed endpoint; tools are executed by the orchestrator, not the adapter.
import type { AdapterCapabilityAssessment, CitationLocator } from '@uptimebuyer/contracts';
import type { InjectionFlag } from '../untrusted.js';

export type ReasoningAdapterId = 'SERV_REASONING' | 'CONTRACT_FAKE';

export interface PacketExcerpt {
  citationId: string;
  documentRef: string;
  role: string;
  title: string;
  documentRevision: string;
  trustLevel: string;
  locator: CitationLocator;
  sourceDigest: string;
  /** Redacted, neutralized excerpt text. Untrusted data. */
  text: string;
  untrustedInstructionFlags: InjectionFlag[];
}

export interface PacketFactValue {
  value: string;
  citationIds: string[];
}

/** The read-only incident packet: the minimum redacted context a model run needs. No secrets, no raw contacts. */
export interface IncidentPacket {
  packetKind: 'uptimebuyer.incident-packet.v1';
  incident: {
    incidentId: string;
    state: string;
    urgency: string;
    faultFamilyHypothesis: string;
    triggerKind: string;
  };
  binding: {
    evidenceRevisionId: string;
    revision: number;
    assetRevisionId: string;
    policyRevisionId: string | null;
  };
  asset: { manufacturer: string; model: string; serial: string | null; bomRevision: string; safetyClass: string };
  documents: {
    documentRef: string;
    role: string;
    title: string;
    documentRevision: string;
    trustLevel: string;
    sourceDigest: string;
  }[];
  facts: { factKey: string; status: string; values: PacketFactValue[] }[];
  conflicts: { factKey: string; values: PacketFactValue[] }[];
  excerpts: PacketExcerpt[];
  rules: string[];
}

export interface ToolSpec {
  name: 'search_evidence' | 'get_asset_snapshot' | 'submit_candidate_schema';
  description: string;
  parameters: Record<string, unknown>;
}

export type TranscriptEntry =
  | { role: 'assistant'; toolCalls: { id: string; name: string; arguments: string }[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ReasonerRequest {
  system: string;
  systemDigest: string;
  packet: IncidentPacket;
  /** The exact user-message text sent to the model (the serialized packet). */
  packetText: string;
  inputDigest: string;
  transcript: TranscriptEntry[];
  tools: readonly ToolSpec[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ModelIdentity {
  adapter: ReasoningAdapterId;
  modelId: string;
  modelVersion: string | null;
  responseId: string | null;
}

export interface TurnUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export type ReasonerTurn =
  | { kind: 'FINAL'; content: string; model?: ModelIdentity; usage?: TurnUsage }
  | { kind: 'TOOL_CALLS'; calls: { id: string; name: string; arguments: string }[]; model?: ModelIdentity; usage?: TurnUsage };

export interface ReasonerPort {
  readonly adapter: ReasoningAdapterId;
  /** Deterministic capability check with no network I/O. */
  assess(): AdapterCapabilityAssessment;
  complete(request: ReasonerRequest): Promise<ReasonerTurn>;
}
