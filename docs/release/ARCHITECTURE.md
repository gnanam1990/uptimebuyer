# UptimeBuyer architecture and evidence (DRAFT)

Status: describes the code in this repository. Diagrams are design documentation (evidence level E0); what each part
has actually proven is in the evidence diagram and `claims.json`. Nothing here is a hosted deployment (NOT_RUN).

## Components and trust boundaries

```mermaid
flowchart LR
  subgraph Site["Site (refrigeration asset)"]
    S["Sensor or edge agent<br/>(SIMULATOR in every local run)"]
  end
  subgraph Edge["Edge / WAF (required, NOT_RUN)"]
    E["TLS, rate limits, body limits"]
  end
  subgraph App["Application workloads (no Kite credential, no paid egress)"]
    G["sensor-gateway<br/>signed telemetry"]
    A["api + web console<br/>OIDC, tenant context"]
    W["worker<br/>outbox, jobs, sweeps<br/>per-runner advisory locks"]
  end
  subgraph Broker["kite-broker (separate workload)"]
    B["signed references only<br/>unix socket 0600<br/>sole paid egress"]
  end
  DB[("PostgreSQL<br/>append-only evidence,<br/>outbox, ledger")]
  SERV["SERV Reasoning (OpenServ)<br/>proposals only<br/>contract fake locally"]
  KITE["Kite Passport and paid merchants<br/>NOT_RUN"]
  CMMS["CMMS<br/>contract fake locally"]
  S --> E --> G --> DB
  E --> A --> DB
  W --> DB
  A -- "session activation reference" --> B
  B --> DB
  B -- "paid egress (broker only)" --> KITE
  A -. "cited extraction" .-> SERV
  W -. "work-order writes" .-> CMMS
```

Model output can propose but never approves: compatibility, safety, spending and closure are deterministic code over
recorded evidence. The broker is the only holder of the paid credential and the only paid egress; the API and worker
reach it only through signed, single-use execution references.

## Incident to recovery

```mermaid
flowchart TD
  T["Authenticated telemetry"] --> I["Incident opened once<br/>(dedup, freshness)"]
  I --> EV["Evidence revision<br/>cited facts"]
  EV --> C{"Deterministic compatibility<br/>ALLOW / HOLD / REJECT"}
  C -- "HOLD / REJECT" --> H["Held for a named human"]
  C -- "ALLOW" --> P["Ranked recovery plan"]
  P --> AP["Operator approval<br/>bounded authority"]
  AP --> K["Broker: reserve, send,<br/>reconcile UNKNOWN before retry"]
  K --> O["Order / job outcome"]
  O --> V{"Recovery verification<br/>stable sensor window +<br/>authoritative sign-off"}
  V -- "provider says done only" --> O
  V -- "PASSED" --> R["RECOVERED (closeout hook only)"]
```

## Evidence ladder: what has been shown

```mermaid
flowchart LR
  E0["E0 specification and diagrams<br/>this document"] --> E1["E1 unit and contract tests<br/>PASS locally"]
  E1 --> E2["E2 integrated tests, local compose smoke<br/>PASS locally"]
  E2 --> E3["E3 live sponsor response without payment<br/>NOT_RUN"]
  E3 --> E4["E4 real bounded payment plus fulfilled action<br/>NOT_RUN"]
  E4 --> E5["E5 independent physical recovery evidence<br/>NOT_RUN"]
```

The product claim needs E4 and E5; both are NOT_RUN <!-- C-022 C-023 -->. The highest level reached is E2: local
integrated tests and a local production-like compose bring-up <!-- C-011 -->.
