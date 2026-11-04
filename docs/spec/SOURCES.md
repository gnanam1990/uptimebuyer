# UptimeBuyer Research Sources

Research cutoff for this pack: 2026-11-04. Unless a row says otherwise, each source was retrieved on or before that date; record exact retrieval times in the evidence store when a source is used for a build decision. Event rules, provider availability, prices, APIs, and product capabilities are point-in-time and must be reverified before implementation and submission.

## 1. Event and sponsor surfaces

| Source | Why it matters | Evidence status |
|---|---|---|
| [SERV Hackathon Edition 02](https://www.openserv.ai/hackathon-2) | Official event page: schedule, tracks, mandatory SERV Reasoning, judging framing, and submission artifacts | Official; retrieved 2026-11-04; reverify deadline and rules before submission |
| [Kite Passport](https://passport-web.dev.gokite.ai/) | Sponsor product surface for agent identity, service access, and bounded spend | Development-environment host (`dev.` subdomain), not a confirmed production URL; confirm the production surface during F0; availability can change |
| [Kite Passport skills, audited commit](https://github.com/gokite-ai/passport-skills/commit/2bab0235de38fb5c5b62d9532b70b182b7fd07e6) | Point-in-time public implementation and service-skill evidence | Primary public repository snapshot |
| [StablePhone](https://stablephone.dev/) | Candidate paid phone-call service for provider contact | Official service page; paid fulfillment `NOT_RUN` in this pack |
| [StableEmail](https://stableemail.dev/) | Candidate paid email service | Official service page; paid fulfillment `NOT_RUN` in this pack |
| [StableEnrich documentation](https://stableenrich.dev/docs) | Candidate business and provider enrichment/search service | Official documentation; paid fulfillment `NOT_RUN` in this pack |
| [Bitrefill x402 checkout information](https://api.bitrefill.com/x402/checkout/info) | Candidate eSIM, top-up, or recovery-supply commerce flow | Provider endpoint; authenticated fulfillment `NOT_RUN` in this pack |

The prior live catalog audit observed HTTP 402 challenges for several services but did not spend funds. A payment challenge proves an offered payment interface, not successful fulfillment, reconciliation, or suitability for UptimeBuyer.

## 2. Problem evidence

| Source | Relevant signal | Caution |
|---|---|---|
| [Restaurant Equipment Downtime Cost, MachineQ/Censuswide findings](https://www.restaurantmagazine.com/restaurant-equipment-downtime-cost-machineq-2026-report/) | Reports equipment-downtime incidence and operator loss estimates in a 2026 restaurant survey | Secondary publication and vendor-sponsored research; use directionally |
| [ServiceChannel Restaurant Facilities Benchmark Report](https://servicechannel.com/wp-content/uploads/2025/02/ServiceChannel-Benchmark-Report-2025-R5-DIGITAL.pdf) | Benchmarks repair volume, emergency share, and resolution time across restaurant facilities | Vendor dataset; segment and methodology may not match a target customer |
| [Sphera 2026 MRO Survey](https://sphera.com/resources/report/2026-sphera-mro-survey-report/) | Reports spare-part search, missing or incorrect parts, expediting, and maintenance-delay pain | Vendor-sponsored survey; directional rather than neutral market sizing |
| [Siemens True Cost of Downtime 2024](https://assets.new.siemens.com/siemens/assets/api/uuid%3A1b43afb5-2d07-47f7-9eb7-893fe7d0bc59/TCOD-2024_original.pdf) | Documents downtime cost and emergency replacement-part themes in industrial settings | Broader industry and larger-asset context; do not transfer headline costs to restaurants |

These sources justify further customer discovery. They do not establish the price, incident frequency, loss, or ROI for a specific customer.

## 3. Competitive and adjacent products

| Source | Adjacent capability | Product implication |
|---|---|---|
| [ServiceChannel](https://servicechannel.com/) | Facilities work orders and provider network | Integrate with CMMS/work-order systems; do not claim the category is empty |
| [MachineQ](https://www.machineq.com/) | Enterprise IoT and equipment monitoring | Monitoring alone is not the differentiator |
| [SmartSense](https://www.smartsense.co/) | Temperature monitoring and digital operations | Recovery orchestration must add more than alerts |
| [Infinite Uptime outcome-gap article](https://www.infinite-uptime.com/the-outcome-gap-why-most-maintenance-platforms-stop-one-level-short-of-a-result/) | Outcome-based industrial maintenance positioning | Outcome language and closed-loop maintenance already exist in adjacent markets |
| [OxMaint AI-verified contractor completion case study](https://oxmaint.ai/case-study/post/how-a-facility-team-used-ai-vision-to-verify-contractor-repair-completion-for-public-sector) | Contractor-completion verification | Verification is competitive; UptimeBuyer's claim must be the whole evidence-to-procurement-to-sensor loop |

This review did not prove global novelty. A current competitive search and buyer interviews are required before public novelty claims.

## 4. Source-use rules

1. Prefer official rules, documentation, repositories, manufacturer manuals, and provider APIs for build decisions.
2. Preserve source URL, retrieval time, revision, asset identity, and quoted field or page in the evidence store.
3. Label vendor-sponsored surveys and case studies; do not convert them into neutral market facts.
4. Separate observed evidence from inference and proposed action.
5. Do not quote a service price, catalog size, capability, deadline, or eligibility rule without fresh verification.
6. A search result, marketing page, HTTP 402 challenge, payment receipt, or self-reported completion is not proof of real-world fulfillment or recovery.
