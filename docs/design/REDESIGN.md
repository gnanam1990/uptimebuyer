# Operator console redesign

The console in `apps/web` is rebuilt on a new visual system. Every view, route, API call, data flow and state is
unchanged; the work is design tokens, typography, the layout shell, components and copy. This file records the plan,
the review of that plan against the brief, and the outside inputs used.

Screenshots: `docs/design/before/` (main at 3f02bee) and `docs/design/after/` (this branch), each view at 1440 and 375
CSS px. Both sets come from `apps/web/e2e/design-review.shots.ts` over the seeded SIMULATED harness:

```
pnpm build
UB_SHOTS_DIR=after DATABASE_URL=… pnpm --filter @uptimebuyer/web exec playwright test -c playwright.shots.config.ts
```

## Who it is for

Facility and maintenance operators at grocery and restaurant chains who look after commercial refrigeration. A walk-in
cooler or a display case is warming, stock is at risk, and the response deadline from the pinned procedure is running.
They need to see which assets are unhealthy and how fresh the sensor data is, own the incident, read cited OEM
evidence, see the deterministic ALLOW / HOLD / REJECT decision, approve a bounded spend, follow orders and payments
(including UNKNOWN outcomes) and close only on independent recovery evidence. The values to carry: trust, calm under
pressure, honesty about uncertainty.

## The subject's world

The design borrows from the equipment and paperwork these people already handle:

- **The refrigeration controller.** Every walk-in and case has a small dark faceplate with a large numeric readout of
  the box temperature. It is the one thing an operator looks at first.
- **The HACCP temperature log.** A ruled sheet with a row per reading, time, value and initials. Plain, tabular,
  trusted because it is boring.
- **Equipment tags and data plates.** Small rectangular labels with slightly rounded corners: model, serial, "do not
  use". Status here is a tag, not a pill.
- **Cold surfaces.** Brushed stainless, frost, the blue-grey of insulated panels. Warmth means danger.

## Pass 1: token plan

### Colour

Core palette (light theme, one theme only):

| Name       | Hex       | Role                                                                          |
| ---------- | --------- | ----------------------------------------------------------------------------- |
| Frost      | `#EDF1F2` | Page canvas: a cold, slightly cyan grey, never cream.                         |
| Sheet      | `#FFFFFF` | Working surfaces: tables, forms, the log sheets.                              |
| Ink        | `#13222C` | Body text and headings (14.3:1 on Frost).                                     |
| Steel      | `#4C5D68` | Secondary text and captions (6.0:1 on Frost, 6.8:1 on Sheet).                 |
| Rime       | `#CFD9DE` | Dividers and sheet outlines (decorative only; controls use `#6B7B85`, 4.4:1). |
| Controller | `#0F2530` | The controller faceplate: the incident status header and the fleet readout.   |
| Signal     | `#0D5A9E` | Actions and links (7.1:1 on Sheet; white on Signal 7.1:1).                    |

Status tags are self-contained (own background, text and border) so they read the same on a sheet and on the
controller. Each keeps its shape icon and text; colour is the third cue, never the only one.

| Tone     | Text      | Fill      | Border    | Used for                                                                |
| -------- | --------- | --------- | --------- | ----------------------------------------------------------------------- |
| healthy  | `#14532D` | `#DDF1E3` | `#1E7B3E` | FRESH, CONFIRMED, PASSED, RECOVERED only (the axes mapping decides).    |
| warning  | `#6B4200` | `#FCEFCF` | `#B27300` | stale, paused, held, needs attention                                    |
| critical | `#8A1C14` | `#FBE0DD` | `#C2261C` | offline, failed, rejected, critical urgency, expired deadline           |
| unknown  | `#4B2A7A` | `#EEE6F8` | `#7A4FB0` | UNKNOWN, invalid, unsupported; dashed border so it never reads as solid |
| info     | `#0B4A70` | `#DCEBF5` | `#2F6E96` | requested, accepted, running, in progress                               |
| action   | `#1D3F8F` | `#E1E8F7` | `#3B5BA9` | awaiting a person                                                       |
| neutral  | `#36454F` | `#E8ECEE` | `#7D8C95` | proposed, local-only, not started                                       |

All text pairs are 7:1 or better. Focus: a 3px `#0A5BD6` outline on light surfaces (5.3:1 on Frost) and `#FFC94D` on
the controller (10.3:1). The persistent environment label is a solid pale-amber band (`#F6D365`, text `#3E2A00`,
9.4:1) with a warning-triangle icon.

### Type

- **Atkinson Hyperlegible Next** (400, 700): all interface and body text. Designed by the Braille Institute so that
  confusable glyphs (I l 1, 0 O, rn m) stay distinct. Operators read serials, readings and amounts under stress; that is
  the reason, not fashion.
- **Barlow Semi Condensed** (500, 600): headings and live readouts. Barlow comes from highway and rail signage; the
  semi-condensed cut fits big tabular numerals into the controller faceplate and keeps long headings on one line.
- **Atkinson Hyperlegible Mono** (400): identifiers, digests, reason codes, verbatim cited text and the JSON policy
  draft only. Monospace means "copy this exactly", so it is never used for ordinary labels.

All three are self-hosted from exact-pinned `@fontsource` packages (OFL-1.1, reviewed exception in
`config/security/license-policy.json`), latin subset, `font-display: swap`. No request leaves the origin.

Scale (major third from 16px, line-height 1.5 body / 1.15 display): 14 small, 16 body, 20 h3, 25 h2, 31 h1, 39 fleet
readout numerals, 56 controller temperature. Tabular figures everywhere numbers line up.

### Layout concept

Desktop (≥1024 px): a banner across the top, a navigation rail on the left, content on the right with a 72rem reading
limit. Left-aligned throughout; nothing is centred except the sign-in column.

```
+--------------------------------------------------------------------------+
| [mark] UptimeBuyer Operations      Tenant m12e2e-alpha   approver  [Sign out] |
| [!] LOCAL DEMO - SIMULATED_INPUT + RECORDED_CONTRACT - NOT REAL             |
+--------------+-----------------------------------------------------------+
| Command      | Incident inc_74c4…                                        |
| Incidents    | +==================== controller ======================+ |
| Evidence     | | 3.7 °C        | Awaiting approval  Critical  Running  | |
|  ledger      | | Fresh, 12:12  | Respond by 12:39:02 UTC               | |
| Policies     | | SIMULATED     | Owner · Blocker · Next safe action    | |
| Notif.  18   | +=====================================================+ |
|              | Overview  Evidence  Recovery plan  Spend & orders  …      |
|              | +-- sheet: Telemetry ------------------------------------+ |
|              | | chart, readout line, show data table                 | |
|              | +------------------------------------------------------+ |
|              | +-- Ownership --------------+ +-- Response deadline ---+ |
+--------------+-----------------------------------------------------------+
```

Narrow (<1024 px): the banner stacks, the environment band stays full width, the navigation becomes a wrapping grid of
44 px links under the banner, the controller stacks its readout above its facts, and tables become labelled records.

```
+---------------------------+
| [mark] UptimeBuyer Ops    |
| approver        [Sign out]|
| [!] LOCAL DEMO - …        |
| Command | Incidents       |
| Ledger  | Policies        |
| Notifications 18          |
+---------------------------+
| Incident inc_74c4…        |
| +==== controller =======+ |
| | 3.7 °C  Fresh         | |
| | Awaiting approval …   | |
| | Respond by 12:39 UTC  | |
| | Next safe action …    | |
| +=======================+ |
| Overview | Evidence | …   |
+---------------------------+
```

### Principles

1. **One bold object: the controller.** The incident status header is a dark controller faceplate with the box
   temperature in large condensed numerals, the lifecycle tags and the running deadline. The Command Center fleet
   strip uses the same faceplate for its counts. Everything else is quiet: frost canvas, white sheets, ink text.
2. **Honest readouts.** A readout is shown as live only when the signal is FRESH; otherwise it says "Last known" and the
   freshness tag sits next to the number, not elsewhere. Green appears only through the axis mapping.
3. **Log-sheet tables.** Tables look like temperature logs: a heavy header rule, light row rules, tabular numerals, no
   zebra striping, no hover effects.
4. **Tags, not pills.** Status is a small tag with a 4px radius, its shape icon and its text.
5. **Radius follows hierarchy.** Controller 14px, sheets 10px, controls 6px, tags 4px. No drop shadows anywhere
   except the open dialog, which genuinely floats.
6. **Motion only answers a person or shows a change.** The chart line eases between readings; the citation drawer
   slides in from the right; nothing else moves, and `prefers-reduced-motion` removes both.

## Pass 2: review against the brief and revisions

I wrote the plan above after a first draft, then checked each part against the brief and against what a generic
generator would produce for "dark ops dashboard".

| First draft                                                    | Problem                                                                                                                              | Revision                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Dark slate console (`#0F172A`) with a bright accent            | It is the old console and the "near-black with one accent" tell. Dark everywhere also removes the contrast the bold object needs.    | Light frost canvas; dark is reserved for the controller faceplate, so it is the one thing that stands out.               |
| Operational green as the primary colour (ui-ux-pro-max output) | Green is reserved for FRESH, CONFIRMED, PASSED and RECOVERED (T-051). A green button would teach operators that green means "click". | Signal blue for actions; green only through the axis mapping.                                                            |
| Orbitron + JetBrains Mono (ui-ux-pro-max output)               | Sci-fi HUD mood; wrong for food safety and hard to read.                                                                             | Atkinson Hyperlegible Next for reading, Barlow Semi Condensed for readouts, Atkinson Hyperlegible Mono for ids only.     |
| Scroll-reveal motion (ui-ux-pro-max output)                    | Decorative motion on every section; nothing about an incident should fade in.                                                        | No entrance motion. Only the chart line and the citation drawer move, and only when not reduced.                         |
| Pill-shaped status badges                                      | The default SaaS chip.                                                                                                               | Equipment-tag shape: 4px radius, filled, shape icon first.                                                               |
| Hazard-stripe environment banner                               | Cliché and visually louder than the incident.                                                                                        | Solid pale-amber band with a triangle icon and the exact label text.                                                     |
| Identical rounded cards with shadows for every section         | The SaaS card kit.                                                                                                                   | Flat white sheets with a Rime outline, no shadow; order and payment records inside a sheet use a left rule, not a card.  |
| Monospace for current value, stats, the SIMULATED tag          | Monospace for ordinary labels is a tell and slows reading.                                                                           | Mono only where it means "exact": ids, digests, reason codes, verbatim citation text, JSON.                              |
| `word-break: break-all` on ids                                 | Breaks ids mid-character even when there is room.                                                                                    | `overflow-wrap: anywhere` with shrinkable containers.                                                                    |
| Headings like "Command Center — m12e2e-alpha"                  | The spaced em-dash label tell, and the tenant name repeated in every heading.                                                        | "Command Center" with the tenant and scope in the banner; counts move into a sentence under the heading.                 |
| Chart drawn with `preserveAspectRatio="none"`                  | Axis text stretched and unreadable (see `before/05-incident-telemetry-*`).                                                           | Aspect-correct chart, a shaded band above the threshold, axis and threshold labels as HTML so they stay readable at 320. |

## ui-ux-pro-max inputs

Queries (no private data): `--design-system "operations console incident response industrial monitoring dark
dashboard" -p "UptimeBuyer" --density 8 --variance 4 --motion 2`; `--domain typography "industrial legible
utilitarian"`; `--domain color "facility maintenance monitoring"`; `--domain chart "real-time sensor time series
threshold"`; `--domain ux "data table responsive mobile"`; `--domain ux "focus not obscured sticky header"`;
`--stack react "dialog focus trap tables"`.

Used:

- **Real-time pattern:** label telemetry as live only when backed by a current source, show the update time and the
  stale state, provide pause controls and a static snapshot under reduced motion. This became principle 2.
- **Chart, anomaly detection:** line chart with highlighted anomalies, distinct shape plus text, an event table as the
  fallback. Kept (it is already T-052) and strengthened with the threshold band.
- **Density 8:** an 8–32 px spacing scale for a dense dashboard (`--space-1` 4px to `--space-8` 32px).
- **Focus not obscured (WCAG 2.2 AA):** offset sticky UI with `scroll-padding-top`. The sticky controller sets the page
  scroll padding to its own height on incident pages.
- **Tables:** horizontal scroll inside the region or a record layout on mobile. Both are kept.
- **Quick reference:** tabular figures for numbers, 4.5:1 text contrast, `overflow-wrap: anywhere` instead of
  `break-all`, one primary action per area, visible 2–4px focus, 44px targets, a z-index scale.
- **React stack:** trap focus in dialogs and return it on close (already in `Dialog.tsx`, unchanged).

Rejected, with reasons above: the green primary, Orbitron and JetBrains Mono, scroll-reveal motion, Google Fonts URLs
(the CSP forbids external requests; fonts are self-hosted).

## Decisions taken without asking

- **One light theme.** The old console was dark-only. A single theme keeps every contrast pair covered by the axe scans
  in the e2e suite; a second, untested dark theme would be a regression risk. The controller faceplate gives the
  dark, high-contrast object an operator expects from equipment.
- **Temperature in the status header.** The workspace already loads the asset's telemetry for the Telemetry panel; the
  controller shows its newest reading with the same freshness rule. No new request is made.
- **Font licence.** `@fontsource/*` packages are OFL-1.1, which the licence policy did not list; a reviewed exception
  was added (bundling and embedding are permitted). This is the only change outside `apps/web` and `docs/design`.
- **Citation drawer.** The citation dialog opens as a right-side drawer at 768 px and wider (it was a centred dialog)
  to match how the tests and spec already describe it. It is still a native modal `<dialog>` with the same focus trap.

## Critique from screenshots and what changed

First build, reviewed from `after/` captures:

| Seen in the screenshot                                                                                            | Change                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Table headers and cells split mid-word ("Kin d", "m12e2 e store", "SIMULATE D_INPUT") in narrow columns.          | Cells wrap at word boundaries only (`overflow-wrap: break-word`), headers never wrap; a wide table scrolls inside its labelled region instead. |
| Table captions rendered one letter per line in the 375 px record layout.                                          | Captions become blocks when the table becomes records.                                                                                         |
| Ownership and Response deadline side by side at 1440 px squeezed their history tables.                            | The two sheets stack until 1600 px; each gets the full width for its table.                                                                    |
| "Notifications 18" broke as "Notificatio ns" / "1 8" in the narrow navigation grid.                               | Narrow navigation is a wrapping row of links sized to their labels; the count never wraps.                                                     |
| The threshold label sat on top of the anomaly triangles at the newest end of the chart.                           | The label moved to the start of the threshold line, where there is no data.                                                                    |
| The sign-in column hugged the left edge at 1440 px.                                                               | It is centred.                                                                                                                                 |
| Notifications were a wall of identical sheets.                                                                    | The left edge of each takes its severity tone (the severity tag still carries shape and text).                                                 |
| T-050 caught the chart line briefly outside the viewport at 320 px: the line eased from its pre-measure geometry. | The line is keyed by chart width, so a resize redraws it and only a new reading animates it.                                                   |
| On phones the controller listed six facts in one long column; fleet icons were small next to the numerals.        | Two columns of facts below 768 px; fleet icons at 20 px.                                                                                       |

## Changes from the PR #25 review

| Finding                                                                                 | Change                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI (Linux Chromium) put the "Open incident <uuid>" link past the right edge at 1024 px. | Tables switch to labelled records by a container query on their own region (under 760 px), not the viewport; ids in link text and code tokens wrap anywhere; flex and grid children may shrink.     |
| The faceplate kept "Newest temperature" and FRESH after a failed telemetry refresh.     | A failed refresh makes the faceplate say "Last known temperature, not live", show the error and drop the retained freshness on every tab; the Telemetry panel stops showing the retained FRESH too. |
| The faceplate could present a simulator's value as a live reading.                      | The faceplate and the panel share one device and series selection; a SIMULATOR value carries SIMULATED_INPUT at the number and is never styled live.                                                |
| Notices inside the dark faceplate inherited its light text.                             | Notices on the faceplate keep ink text (13:1 or better) and dark links (7:1 or better).                                                                                                             |

Ids stay visible in full. A shortened form (for example `inc_cd4857de…`) was considered and rejected: operators
compare and copy these ids against CMMS and provider records, and a truncated visible label would either hide part of
the id or diverge from the link's accessible name.

## What is not covered

- No dark theme (see "One light theme" above).
- The seeded telemetry window is 30 minutes but the seeded samples sit in its last minutes, so the chart's data is
  bunched at the right edge. That is the data, not the chart; the window and its accessible name are unchanged.
