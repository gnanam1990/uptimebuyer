# UptimeBuyer AI Safety and Deterministic Authority

Status: `SPECIFICATION_ONLY`

## 1. Safety thesis

The model is a bounded analyst, not an authority. It may turn messy manuals, histories, search results, and transcripts into cited structured candidates. Deterministic code and authorized people decide compatibility, spending, and closure.

## 2. Permitted model tasks

- classify an incident into a controlled taxonomy;
- extract manufacturer, model, serial, OEM MPN, symptoms, procedures, and warnings;
- locate and cite manual/BOM/service-history passages;
- summarize provider conversations and identify explicit quote fields only from tenant-policy-approved, consented where required, purpose-limited, minimum redacted excerpts;
- propose candidate actions and list missing/conflicting evidence;
- explain a deterministic decision in operator language;
- draft communications for an authorized adapter.

## 3. Prohibited model authority

The model cannot:

- approve a substitute or safety-critical intervention;
- assert exact compatibility from vector similarity or prose resemblance;
- create, enlarge, or bypass budget/approval scope;
- access or emit secrets, raw payment credentials, or unrestricted network tools;
- choose arbitrary URLs to fetch;
- mark a commercial action paid/fulfilled;
- accept provider self-report as recovery proof;
- close an incident;
- silently convert unknown or missing evidence into an assumption.

## 4. Typed reasoning contract

Every run outputs a versioned schema containing:

- `incidentId`, `assetId`, `evidenceRevision`, and input digest;
- extracted fields with source citation IDs;
- candidate actions with evidence-for, evidence-against, and missing fields;
- conflict list and explicit uncertainty codes;
- proposed provider queries, not direct calls;
- no executable URL, credential, payment instruction, or final authorization.

Schema failure, citation mismatch, unexpected tool request, excessive output, or unrecognized enum rejects the run. Free text is display-only.

## 5. Retrieval security

Manuals, websites, emails, transcripts, and work orders are hostile content. The system:

1. labels retrieved bytes as data;
2. removes active content and macro/script payloads;
3. parses inside a resource-limited sandbox;
4. retains original digest and page/section coordinates;
5. scopes retrieval to the tenant and incident;
6. checks purpose, role, tenant policy, recording/processing consent where required, retention and redaction, then passes only the minimum approved excerpt to the model; raw/unapproved communication is rejected;
7. ignores embedded requests to change policy, reveal prompts, call tools, or contact endpoints;
8. validates every citation against the evidence manifest.

## 6. Tool isolation

OpenServ/SERV receives narrow tools such as `search_evidence`, `get_asset_snapshot`, and `submit_candidate_schema`. It does not receive Kite, merchant, shell, database-admin, arbitrary HTTP, email, or phone credentials. Unpaid provider actions begin only from a separate deterministic worker after policy authorization; paid actions execute only through `apps/kite-broker` (INV-06).

## 7. Model/version governance

A reasoning configuration records adapter, model identifier, prompt/template digest, schema version, retrieval configuration, and evaluation set version. Changing any of them creates a reviewed configuration revision. Promotion requires offline regression results; rollback restores the prior configuration without rewriting historical runs.

## 8. Evaluation suite

The fixed evaluation corpus includes:

- exact OEM match;
- similar-looking but wrong voltage/size/refrigerant candidate;
- conflicting manual revisions;
- missing serial/model;
- provider offers an unauthorized substitute;
- prompt injection inside a manual and phone transcript;
- canary secrets and personal data in raw/unconsented transcript regions that must never reach model input or logs;
- stale catalog price/stock;
- malicious citation locator;
- ambiguous service completion;
- cross-tenant document reference;
- multilingual/manual OCR degradation;
- no safe action.

Metrics separate extraction accuracy, citation validity, missing-field recall, unsafe suggestion rate, and deterministic-policy outcome. A fluent answer is not a pass.

## 9. Human review

Human review is mandatory for substitute parts, safety-critical repairs, conflicting evidence, policy exceptions, new/unapproved vendors over threshold, and release from unresolved external outcome. The UI shows exact proposed scope, evidence, reasons, amount, expiry, and downstream effects. Approval cannot be a generic chat reply.

## 10. Operator-facing honesty

Use labels `MODEL PROPOSAL`, `DETERMINISTIC DECISION`, `HUMAN APPROVAL`, and `AUTHORITATIVE EVIDENCE`. Display evidence revision and freshness. Never show “safe,” “compatible,” “paid,” “delivered,” or “recovered” unless the corresponding authoritative state exists.

## 11. Failure handling

If reasoning is unavailable or rejected, the incident remains active and the operator can use manual deterministic workflows. The system never falls back to unvalidated free text. Repeated failures trigger escalation and preserve run diagnostics without exposing sensitive prompts or content.

## 12. Release gates

- zero unsafe authorization paths in adversarial tests;
- citation verifier rejects forged/out-of-range citations;
- model/tool process has no payment credential or arbitrary egress;
- revisions invalidate stale proposals;
- substitute approval requires named authorized actor;
- UI and export distinguish proposal from decision and proof.

Related requirements: FR-05, FR-06, FR-08, FR-09, FR-10, NFR-10; INV-02 through INV-04, INV-06, INV-12, INV-15.

