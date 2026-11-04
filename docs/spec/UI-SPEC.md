# UptimeBuyer UI Specification

## Document status

- Artifact status: **SPECIFICATION_ONLY**
- Implemented screens: **NOT_RUN**
- Browser and device validation: **NOT_RUN**
- Accessibility audit: **NOT_RUN**
- Design direction: industrial operations console, responsive web application

This document specifies the operator experience for detecting, investigating, funding, executing, and verifying a commercial-refrigeration recovery. It does not prove that the interface or any provider integration exists.

## 1. Experience objective

An operator must be able to answer five questions without opening another tool:

1. What failed, at which site, and how trustworthy is the signal?
2. What inventory and revenue are at risk, and by when?
3. Which intervention is technically compatible and why?
4. What will the system spend, with whom, and under which approval?
5. Has the asset actually recovered according to independent evidence?

The interface is not a chat transcript with dashboards around it. The canonical object is an incident. Agent reasoning, compatibility decisions, provider contacts, payments, orders, work, telemetry, and human approvals are evidence attached to that incident.

## 2. Product principles

### 2.1 Evidence before confidence

Every important recommendation displays its sources, revision, timestamp, and decision owner. A confidence percentage cannot replace missing exact-part evidence. `UNKNOWN`, `CONFLICT`, and `STALE` are first-class states.

### 2.2 Recovery is an observed state

Provider completion, an invoice, a receipt, and an agent message never make an incident green. The closeout view requires the configured stable telemetry window plus the required CMMS or authorized-operator evidence.

### 2.3 Bounded autonomy is visible

Operators can see the incident budget, permitted action classes, session expiry, amount committed, amount spent, and remaining authority. Approval language names the exact effect. It never uses a vague primary action such as “Continue.”

### 2.4 Safety is not decorative

Part identity, compatibility conditions, refrigeration hazards, food-safety thresholds, approval requirements, and stop conditions use text and iconography, not color alone. Safety-critical copy is never truncated or hidden behind hover.

### 2.5 Failure paths are navigable

Provider timeouts, unknown payment outcomes, stale sensors, rejected substitutions, and failed recovery each provide a recovery action and an evidence trail. The UI never silently converts an unknown external outcome into success or failure.

## 3. Users and roles

| Role | Primary goals | Allowed interface effects |
|---|---|---|
| Operations dispatcher | Understand incidents, select an approved recovery plan, contact providers | Manage incidents and non-safety operational approvals within policy |
| Facilities manager | Set site policy, approved vendors, spend thresholds and escalation rules | Configure scoped policy and approve higher-risk interventions |
| Refrigeration engineer | Validate exact compatibility or a proposed substitute | Sign named engineering decisions; cannot alter payment history |
| Site operator | Confirm onsite facts, scan part, complete a constrained checklist | Submit evidence only for assigned site/work order |
| Finance approver | Review bounded spend and payment outcomes | Approve defined budget/session; cannot assert technical compatibility |
| Auditor | Inspect complete decision and money trail | Read and export; no operational mutation |
| Tenant administrator | Manage membership and integration configuration | Administrative actions with step-up authentication |

Role checks are enforced server-side. Hiding a button is not authorization.

## 4. Information architecture

Primary navigation:

- **Command Center** — fleet risk, active incidents and action queue.
- **Incidents** — searchable incident register and saved views.
- **Assets** — asset graph, sensors, manuals, BOM, service and warranty history.
- **Providers** — approved technicians, suppliers, performance and coverage.
- **Policies** — compatibility, budget, approval, escalation and recovery rules.
- **Evidence Ledger** — immutable-style chronological evidence explorer and exports.
- **Integrations** — sensor, CMMS, catalog, communications, OpenServ and Kite status.
- **Administration** — tenants, users, roles, secrets metadata and retention settings.

Tenant and site switchers remain visible in the shell. Their current scope is included in every page heading and export. Switching scope invalidates stale selections and requires a fresh data fetch.

## 5. Visual system

### 5.1 Tone

The visual language is dense, calm, and operational. It favors legibility and state clarity over glass effects, decorative gradients, oversized empty cards, or marketing animation.

### 5.2 Color tokens

| Token | Default dark value | Use |
|---|---:|---|
| `surface.canvas` | `#0F172A` | Application background |
| `surface.panel` | `#111827` | Cards, drawers and table surfaces |
| `surface.muted` | `#1E293B` | Secondary sections and selected rows |
| `border.default` | `#334155` | Structure and separators |
| `text.primary` | `#F8FAFC` | Main text |
| `text.secondary` | `#CBD5E1` | Supporting text |
| `status.healthy` | `#22C55E` | Independently verified healthy state |
| `status.action` | `#2563EB` | Primary safe action (deliberately not green, so an action on a stale or unknown incident never reads as healthy) |
| `status.warning` | `#F59E0B` | Degraded, approval or deadline risk |
| `status.critical` | `#DC2626` | Critical incident or blocked safety state |
| `status.info` | `#38BDF8` | Neutral active workflow |
| `status.unknown` | `#A78BFA` | Unknown, reconciling or indeterminate |

Every status pairs color with an icon, short label, and accessible description. A light theme may be added only if the same semantic contrast and chart distinctions are preserved.

### 5.3 Typography and density

- Interface font: Fira Sans with system sans-serif fallback.
- Identifiers, money, timestamps, hashes and telemetry: Fira Code with monospace fallback.
- Base body size: 16 px desktop and mobile; dense tables may use 14 px with adequate line height.
- Primary operator pages use an 8 px spacing system and a compact density setting. Touch targets remain at least 44 by 44 CSS pixels.
- Asset model, serial, manufacturer part number, unit and currency never rely on proportional alignment when comparison matters.

### 5.4 Motion

Motion is limited to state continuity: drawer entry, row insertion, progress update and chart streaming. It respects `prefers-reduced-motion`. Critical alerts never pulse continuously. Live charts include pause/resume and expose the same data in a table.

## 6. Application shell

Desktop uses a 240 px collapsible left navigation, a top context bar, and a main content region with an optional evidence drawer. Tablet collapses navigation into a rail. Mobile uses a top bar plus bottom navigation for Command Center, Incidents, Assets and More.

The top context bar contains:

- tenant and site scope;
- global search;
- system health summary;
- pending approvals count;
- user and role menu.

If sensor ingestion, CMMS, Kite or a provider adapter is degraded, the health summary is visible on every page. It names the affected capability and the last successful observation. It does not declare the entire product offline when one optional adapter fails.

## 7. Command Center

### 7.1 Fleet strip

Show sites online, assets healthy, assets stale/offline, active critical incidents, unresolved external outcomes, and current value at risk. Each value links to the exact filtered register. Values display an “as of” time and do not aggregate stale sensor data into a healthy count.

### 7.2 Active incidents board

The default is a sortable table, not a card mosaic. Columns:

- severity and lifecycle state;
- site and asset;
- signal age and source;
- temperature/current deviation;
- inventory value at risk;
- time to the pinned SOP response/containment deadline;
- selected plan and compatibility status;
- spend committed / cap;
- current blocker;
- owner and next deadline.

Rows support keyboard selection and open the incident workspace. Responsive mobile mode changes each row into a structured summary while preserving site, asset, severity, deadline, blocker and primary next action.

### 7.3 Action queue

Separate queues exist for compatibility review, spend approval, unknown external outcome, onsite evidence and failed recovery. A queue item includes the requested decision, expiry, consequences, evidence revision and requestor. Bulk approval is prohibited for substitute-part and safety-critical decisions.

## 8. Incident workspace

The incident route is `/incidents/{incidentId}`. Its header remains sticky and shows:

- canonical incident ID;
- site and asset identity;
- severity;
- authoritative lifecycle state;
- signal freshness;
- at-risk amount and SOP response/containment deadline;
- current owner;
- allowed next actions.

Tabs are Overview, Diagnose, Recovery Plan, Providers, Spend & Orders, Verification, and Evidence.

### 8.0 Incident command controls

The header owner control shows assigned principal/team, acceptance state, assignment version, assigned-by/time, next-action deadline and pending handoff. Authorized users can assign, accept, reassign or hand off with a required reason; acceptance and reassignment use compare-and-set, and a version conflict reloads the current assignment instead of overwriting it. Cross-tenant principals never appear as selectable targets. The history is append-only.

The deadline control shows the pinned SOP procedure revision, timezone/basis, original computed response/containment deadline, current deadline/status and every `SET`, `PAUSE`, `RESUME`, `SHORTEN`, `EXTEND` or `EXPIRE` event with actor/reason. Only procedure-permitted, RBAC-authorized events are offered. The original deadline is never edited, a later procedure publication does not move it, and an optional risk estimate cannot extend it. `ESCALATED` re-entry is unavailable until the current assignment is accepted.

### 8.1 Overview

The overview contains:

- a live telemetry panel with threshold band, anomaly start, sampled values and freshness;
- a cost-of-delay bullet chart comparing current expected loss with approved recovery budget;
- asset identity and exact model/serial;
- current plan, blocker and next safe action;
- a chronological evidence timeline.

Streaming charts must pause when the tab is hidden and resume from the canonical server cursor. The current value, unit, threshold, sample time and quality flag are also exposed as text. A table fallback lists timestamp, value, unit, source and quality.

### 8.2 Diagnose

The diagnosis view distinguishes:

- observed facts;
- cited manual/BOM/service evidence;
- model-generated hypotheses;
- deterministic rule results;
- unresolved questions.

Each citation opens a side-by-side evidence drawer at the exact page/section where available. The drawer shows document checksum, revision and ingestion time. Prompt-injection-like content found in an uploaded manual is rendered as untrusted evidence, never as an instruction.

The agent may propose a fault class and recommended checks. The UI labels it “Proposed diagnosis,” not “Confirmed cause,” until the configured validation evidence exists.

### 8.3 Recovery Plan

Plans are compared using expected cost-to-recovery:

```text
service and part cost
+ expected downtime duration × downtime cost rate
+ versioned tenant risk estimate × inventory value
+ repeat-failure risk cost
```

The formula inputs, currency, units, source, revision and missing values are visible. For an open incident, the operational deadline is its `current_response_deadline_at` projection derived from the pinned procedure and authorized deadline-event history; a later procedure publication cannot move or silently re-rank it. Any optional food-risk estimate is provenance- and uncertainty-labelled, non-authoritative, and cannot extend that deadline. If required inputs are unknown, ranking is labelled incomplete and cannot be presented as a deterministic winner.

Each intervention card shows:

- exact requested outcome;
- part manufacturer and MPN, or service scope;
- compatibility decision: `ALLOW`, `HOLD`, or `REJECT`;
- evidence and policy revision;
- ETA fit against the pinned SOP response/containment deadline;
- quoted and estimated totals;
- risks and approvals;
- why alternatives were rejected.

The system cannot turn semantic similarity into an exact-fit badge. A substitute requires the configured engineer approval and is visually distinct from an OEM exact match.

### 8.4 Providers

Provider rows show coverage, service capability, source, contact status, quote, ETA, evidence age, approved-vendor status and recovery performance. Search results are not silently treated as approved providers.

Call and message activity displays provider, request scope, price, payment status, provider response, transcript provenance and redactions. Transcripts are searchable but cannot be edited. Corrections are appended as annotations.

### 8.5 Spend & Orders

The approval panel states:

- maximum session budget and currency;
- expiry;
- allowed providers, exact provider-account/capability revision and action classes;
- per-action and aggregate caps;
- immutable execution-authority ID, local `ACTIVE/SUSPENDED/REVOKED/EXPIRED` status, issued/expiry time, and separate Kite-session external outcome/reference;
- base limit, signed authority adjustments, effective limit, open reserve, gross captured, refunded/reversed, net settled and remaining gross authority;
- immutable asset, evidence, policy, plan and action-digest revisions being funded;
- effects that require another approval.

The primary button uses effect-based copy such as `Approve up to $320 for incident INC-…`. Step-up authentication occurs on a trusted application surface. Raw Kite credentials or signing material never appear in the browser, transcript or evidence export.

Economic intents use the canonical `CREATED`, `RESERVED`, `SUBMITTED`, `UNKNOWN`, `CONFIRMED`, `FAILED`, `REVERSED`, and `REFUNDED` states; the attempt timeline separately shows transport, normalized external outcome, adapter capability and `SEND_STARTED` before provider acknowledgement. Purchase orders and service jobs use their distinct lifecycles from `STATE-MACHINES.md`. A Kite-session or action `UNKNOWN` provides a reconcile action and disables unsafe duplicate purchase. A refund changes net settlement but never appears as new spend authority without a separate signed adjustment.

### 8.6 Verification

The verification view is a checklist backed by evidence, not a manual “Mark fixed” button. It includes:

- telemetry returned to the configured safe range;
- the exact approved action, policy-designated verified intervention-completion milestone, immutable `observation_boundary_at`, boundary-rule revision and strict-after rule from which observation begins;
- continuous stable-window progress and any reset reason;
- signal freshness and source identity;
- immutable asset, evidence, policy, channel and calibration revisions used by the assessment;
- installed part barcode/serial match when required;
- CMMS work-order state and signer;
- authorized onsite checklist and attachments;
- repeat-fault observation window.

Provider self-report is visible but insufficient. Boundary-equal, pre-intervention, sibling-incident/action, superseded-asset, revoked-channel, late, backfilled, or mixed-backfill-plus-fresh-tail samples are visibly ineligible for recovery proof. If the signal becomes stale during verification, progress pauses or resets according to policy; it never turns green. A failed stable window moves the incident to `ESCALATED`, which re-enters planning after revalidation, with the previous evidence intact.

### 8.7 Evidence

The evidence timeline is append-oriented. Each entry shows actor, service identity, time, type, effect, entity revision, correlation ID and verification state. Users can filter by technical decision, human approval, communication, payment, order, telemetry and closeout.

Exports are generated server-side, scoped to tenant and incident, signed or checksummed where configured, and record who requested them. Redaction policy is shown before export.

## 9. Asset workspace

The asset page contains identity, location, parent/child equipment, sensor bindings, thresholds, manuals, BOM, approved substitutions, warranty, service history, installed-part history and open incidents.

Asset identity changes create a new immutable asset revision. A model or serial edit does not retroactively alter a past compatibility decision. It invalidates the active plan and unexecuted approval, creates a new evidence revision, and, before any reserve-plus-send linearization, moves the incident `AWAITING_APPROVAL → PLANNING` or (from any other active state) to `ESCALATED`, which re-enters `AWAITING_EVIDENCE` or `PLANNING` after revalidation; if an external effect is already past the reserve-plus-send linearization point, the incident is `ESCALATED` while that effect remains visible and reconciles rather than being erased or retried.

Manual and BOM upload shows processing state, checksum, detected model coverage, extraction quality, conflicts and reviewer. A document cannot be promoted to authoritative without the configured role.

## 10. Policies and administration

Policy editing uses a draft/review/publish workflow. The UI displays an impact preview: affected sites/assets, actions newly allowed or blocked, active incidents requiring reevaluation, and effective time. Publishing high-risk policy requires step-up authentication and dual approval when configured.

Key policy groups:

- incident thresholds and deduplication;
- telemetry freshness and recovery stable window;
- exact-part and substitute requirements;
- safety-critical asset classes;
- approved vendors and service radius;
- incident and per-action spend caps;
- human approval matrix;
- provider timeout and fallback;
- notification and escalation;
- retention and export redaction.

Integration screens expose configuration metadata and health, not plaintext secrets. Secret replacement is a separate privileged action with confirmation and audit evidence.

## 11. Empty, loading, error and honesty states

### Empty states

Empty states describe what data is absent and the authorized next action. “No active incidents” is distinct from “Incident data cannot be loaded.” A new tenant receives a setup checklist for site, asset, sensor, policy, CMMS, provider and Kite qualification.

### Loading

Use structural skeletons only when layout is known. Actions that change money or lifecycle show the actual canonical server state plus its correlation ID; the UI must never invent a generic `pending` lifecycle state, and closing the browser must not erase the server-side operation.

### Errors

Forms provide an error summary linked to fields. Operational errors name what is known, what remains unknown, whether retry is safe, and the recommended recovery action. Technical codes and correlation IDs are copyable but secondary.

### Demo and unavailable capabilities

Simulated sensor inputs are visibly marked `SIMULATED_INPUT`. Sandbox/provider stubs are marked `NON_PRODUCTION`. A mock, prerecorded clip or manually edited database row can demonstrate layout but cannot satisfy the central real-input, payment, provider or recovery proof.

## 12. Responsive behavior

Required validation widths are 320, 375, 768, 1024 and 1440 CSS pixels, plus 200% zoom and 400% zoom reflow at 320 CSS px (WCAG 2.2 SC 1.4.10).

- At 1440, incident workspace supports a 12-column content grid plus a 360–440 px evidence drawer.
- At 1024, the drawer overlays; dense tables retain horizontal scroll with frozen identity columns.
- At 768, comparison panels stack and navigation becomes a rail or sheet.
- At 375, the current incident state, deadline, blocker and next action remain above the fold. Tables become labeled records; no safety field is removed.

Landscape and zoom at 200% must remain operable. Fixed headers cannot cover focused content.

## 13. Accessibility requirements

- Target WCAG 2.2 AA.
- All functionality is keyboard operable with visible focus.
- Heading, landmark, table and form semantics match visual structure.
- Dialogs trap focus while open, have an accessible name, and return focus to the trigger.
- Live telemetry uses restrained announcements; critical lifecycle changes use an appropriate live region without repeating every sample.
- Icons have accessible labels when meaningful and are hidden when decorative.
- Charts provide text summaries and tabular data.
- Status never depends on color alone.
- Destructive and financial actions disclose effect, amount and scope before confirmation.
- Touch targets are at least 44 by 44 CSS pixels.
- Reduced-motion preference disables nonessential transitions.
- Date, time, unit and currency formats remain unambiguous and show timezone when operationally relevant.

## 14. Component inventory

Core reusable components:

- `AppShell`, `TenantScopeSelector`, `SystemHealthStrip`;
- `IncidentRegister`, `IncidentStateBadge`, `SeverityIndicator`;
- `TelemetryChart`, `TelemetryTable`, `FreshnessBadge`;
- `EvidenceTimeline`, `EvidenceDrawer`, `CitationLink`;
- `CompatibilityDecision`, `PartIdentityCard`, `SubstitutionApproval`;
- `RecoveryPlanComparison`, `CostToRecoveryBreakdown`;
- `ProviderTable`, `QuoteComparison`, `CommunicationTranscript`;
- `BudgetAuthorityCard`, `SpendApprovalDialog`, `PaymentStateBadge`;
- `OrderTimeline`, `ReconciliationPanel`;
- `StableWindowProgress`, `RecoveryChecklist`, `CMSSignatureCard`;
- `PolicyEditor`, `PolicyImpactPreview`, `IntegrationHealthCard`;
- `HonestyBanner`, `ErrorSummary`, `CorrelationId`.

Components consume typed server responses. They do not infer authoritative state from labels or local browser transitions.

## 15. Frontend architecture expectations

Use the selected Next.js App Router version pinned at implementation intake. Route-colocate page-specific components and keep domain UI primitives in a shared package. Server components may render read paths; mutations use authenticated server/API boundaries with explicit idempotency keys. Client cache updates are optimistic only for reversible presentation state, never for payment confirmation, compatibility approval or incident closeout.

Use URL-addressable filters and tabs so incident evidence can be shared with authorized users. Suspense boundaries must not make critical state disappear. Error boundaries offer retry and preserve the incident ID/correlation context.

## 16. UI acceptance criteria

The interface is acceptable only when all of the following are evidenced:

1. A keyboard-only operator can locate a critical incident, inspect exact-part evidence, approve a bounded action and review recovery evidence.
2. Mobile, tablet and desktop layouts preserve the incident, deadline, blocker and next safe action.
3. A stale sensor, provider timeout, unknown payment, rejected substitute and failed recovery each show honest distinct states and a safe recovery path.
4. The app cannot display `RECOVERED` until the canonical backend state meets the telemetry and completion policy.
5. Compatibility citations retain document and entity revision identity.
6. Spend approval presents amount, currency, expiry, provider/action scope and policy revision.
7. No secret or credential appears in rendered HTML, client logs, analytics, error messages or exported evidence.
8. Charts have accessible summaries and tables; status is not color-only.
9. Automated accessibility checks and manual keyboard/screen-reader smoke tests have recorded evidence.
10. The full failure-to-recovery demo is captured from the running product; static prototypes are labelled and do not qualify the product claim.

Until implementation and these checks are run, every acceptance item remains **NOT_RUN**.
