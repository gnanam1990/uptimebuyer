# UptimeBuyer Business and Go-to-Market Plan

Status: `SPECIFICATION_ONLY`; pricing and market assumptions require customer validation.

## 1. Commercial thesis

UptimeBuyer sells faster, safer recovery from refrigeration incidents. The buyer is not paying for an agent chat, a sensor dashboard, or payment plumbing. The buyer is paying to reduce the interval between a qualified failure and independently verified recovery while controlling wrong-part, provider, spoilage, and unauthorized-spend risk.

The initial category is a recovery operations product that connects monitoring, maintenance, procurement, and payment systems. It should integrate with, not attempt to replace, established CMMS and monitoring deployments.

## 2. Ideal customer profile

### Entry segment

- 10–250 restaurant, grocery, convenience, commissary, or dark-store locations.
- A central facilities or operations team with emergency-service responsibility.
- Existing temperature monitoring, BMS, or a willingness to deploy a small authenticated gateway.
- Meaningful refrigerated inventory and a measurable escalation process.
- Repeat equipment families across sites, enabling reusable asset and compatibility knowledge.
- Approved service providers and purchasing authority that can be encoded.

### Strong qualification signals

- Dispatchers maintain spreadsheets or group chats for incidents and providers.
- Wrong or late parts, repeated callbacks, or provider no-shows are visible problems.
- Emergency orders require several approvals or personal-card reimbursement.
- Monitoring alarms and CMMS work orders are not automatically correlated.
- Regional leaders cannot explain time to recovery or provider success by failure type.

### Poor initial fit

- A single site with rare incidents and no central operator.
- Regulated pharmaceutical cold chain requiring validated systems before the core product is mature.
- Assets without identifiable model, serial, manual, or service evidence.
- Customers seeking unsupervised diagnosis or warranty decisions.

## 3. Beachhead offer

Sell a paid “Refrigeration Recovery Pilot” for one equipment family across three to ten sites.

The pilot includes:

- asset and manual onboarding;
- sensor or gateway integration;
- one CMMS or reference work-order integration;
- approved-provider and purchasing policy setup;
- compatibility rule configuration for a bounded part and intervention set;
- controlled incident exercises;
- live incident support with human oversight;
- outcome and evidence review.

Pilot success is an agreed operational scorecard, not a demo impression: incident-open latency, time to first eligible plan, time to provider acceptance, verified recovery time, operator minutes, prevented incompatible options, and economic-integrity exceptions.

## 4. Monetization hypotheses

Validate these structures rather than publishing them as settled pricing:

1. **Platform subscription:** per site or per monitored asset, including fleet views, policies, evidence ledger, and integrations.
2. **Recovery orchestration fee:** per qualified incident or verified recovery, with a disclosed cap and no incentive to generate unnecessary paid actions.
3. **Implementation fee:** asset graph, manual/BOM mapping, provider policy, CMMS, and sensor integration.
4. **Enterprise controls:** SSO, custom retention, private networking, audit export, approval workflow, and service commitments.

Avoid hidden supplier commissions in the first offer. They create a conflict with lowest expected cost to recovery. If commercial referral revenue is introduced later, disclose it in ranking and contract terms.

## 5. Buyer ROI model

Use customer-provided inputs and show ranges:

```text
estimated incident benefit =
  baseline downtime and spoilage cost
  - observed post-deployment downtime and spoilage cost
  - incremental recovery action cost
  - UptimeBuyer fees
```

Separate observed values from estimated values. “Avoided spoilage” is an estimate unless the customer supplies an auditable baseline and counterfactual method. Do not turn vendor-sponsored industry survey figures into a customer-specific savings promise.

## 6. Sales motion

### Phase 1 — Design partners

Interview facilities leaders, dispatchers, refrigeration contractors, and engineers. Ask for recent incident timelines, redacted manuals and work orders, actual provider calls, wrong-part examples, approval friction, and proof used to close work. Seek paid access to a controlled pilot, not feature compliments. Every interview, outreach message and pilot request requires explicit user authorization, and notes are anonymized and kept separate from founder inference.

### Phase 2 — Bounded pilot

Choose one repeated equipment family and a narrow intervention set. Run shadow recommendations first, then supervised bounded actions, then approved automation only after safety and economic-integrity gates pass.

### Phase 3 — Multi-site expansion

Expand within the customer using proven asset families and providers. The expansion case is the growing recovery graph: known compatibility, faster sourcing, calibrated provider performance, and fewer manual handoffs.

### Phase 4 — Channel partnerships

Potential channels are monitoring vendors, CMMS implementers, refrigeration service networks, insurers, and equipment distributors. A channel must not weaken vendor neutrality or evidence standards.

## 7. Competitive position

| Category | Strength | Gap UptimeBuyer targets |
|---|---|---|
| Monitoring and IoT | Detects temperature or equipment anomalies | Does not necessarily qualify, buy, coordinate, and verify recovery |
| CMMS and facilities platforms | Work orders, provider networks, asset records | May still require manual compatibility, sourcing, payment, and sensor closeout |
| MRO and parts marketplaces | Catalog and availability | Search result is not proof of exact asset compatibility or recovery |
| Agent identity and payment rails | Spending controls and paid service access | Do not own refrigeration asset semantics or recovery outcome |
| Outcome-based maintenance vendors | Strong operational outcome story | Often targeted at different industrial assets or delivered as a managed service |

The defensible boundary is domain evidence and closed-loop recovery, not generic “AI maintenance.” The source review did not establish a global novelty claim. Assume adjacent vendors can add features and win through execution, integrations, and trust.

## 8. Moat-building data, with consent

- Asset model, revision, BOM, and approved-part mappings.
- Evidence-backed exception and compatibility decisions.
- Failure type to recovery-action outcomes.
- Provider acceptance, arrival, resolution, repeat-fault, and evidence quality by region and asset.
- Time-to-recovery and cost distributions by incident class.
- Policy configurations and exception frequency.

This data is tenant-governed. Cross-customer learning requires a lawful, explicit aggregation policy and privacy-preserving design. Customer content is not silently used for model training.

## 9. Revenue-quality safeguards

- A paid provider call, item order, or larger basket is not a success metric by itself.
- Ranking must not prefer a merchant because it pays UptimeBuyer more.
- The product must show unsupported and unknown external states.
- Completion-dependent fees cannot be released before authoritative recovery evidence.
- Refunds, reversals, substitutions, and disputes remain visible in unit economics.

## 10. Validation scorecard

This scorecard governs the post-hackathon production decision. The hackathon build is governed by the F0 gates in `PROJECT-BRIEF.md` and `prompts/00a-feasibility-spike.md`. Proceed to a larger post-hackathon build only after obtaining:

- three operator interviews with recent incident evidence;
- one refrigeration engineer review of compatibility and recovery policy;
- one lawful, real sensor and work-order data path;
- one real Kite-paid action with reconciliation evidence;
- one design partner willing to sign or pay for a bounded pilot;
- a quantified baseline for operator minutes and time to recovery.

If interviews reveal that provider availability, not parts or approvals, dominates the problem, preserve the same product boundary but narrow the first automation to provider contact and verified dispatch. If customers cannot supply reliable asset identity, asset onboarding becomes the first paid deliverable rather than an invisible assumption.

## 11. Expansion options after proof

After the refrigeration wedge is repeatable, adjacent areas include HVAC, commercial kitchen equipment, cold rooms, and selected industrial assets. Expansion requires a new domain policy pack, authoritative evidence model, expert review, and recovery signal; it is not a configuration checkbox.

## 12. Commercial unknowns

Pricing, sales-cycle length, insurer interest, procurement treatment of agent-initiated purchases, provider participation, jurisdictional recording consent, and customer willingness to automate remain unvalidated. They are implementation and discovery gates, not filled-in assumptions.
