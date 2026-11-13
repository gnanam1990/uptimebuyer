# Studio redesign brief: the cold-chain instrument

This is the brief for the second console redesign (branch `feat/web-studio`), run through the owner's
`frontend-studio-claude` skill on its "new frontend / broad redesign" path. It replaces the visual direction of the
first redesign (`docs/design/REDESIGN.md`) and keeps every view, route, API call, state, label meaning and tested
copy. The upstream material actually read and used is recorded in `SOURCES.md` next to this file.

## Surface, audience and job

- **Surface:** the operator console in `apps/web` (React 19, Vite 8, hand-written CSS tokens, strict CSP, served
  same-origin by `apps/api`). Mode: an operational tool. Precision and restraint carry the brand; one bold object.
- **Audience:** facility and maintenance operators at grocery and restaurant chains. A walk-in cooler or display case
  is warming, stock is at risk, the response deadline from the pinned procedure is running.
- **Job, in order:** see unhealthy assets and signal freshness; triage and own the incident; read cited OEM-manual
  evidence (SERV Reasoning proposes, code decides); see the deterministic compatibility decision; approve a spend
  bounded by amount, merchant and expiry; watch orders and payments including honest UNKNOWN states; close only on
  independent recovery evidence.
- **Values:** trust, calm under pressure, honesty about uncertainty.
- **Scope:** authorized broad redesign of the look and motion. No API or behavior change. The demo video will be
  re-recorded from this UI, so the main views must hold up at 1920 x 1080 and on phones.

## Facts versus provisional content

Everything on screen comes from the API over the seeded SIMULATED harness. Two additions are derived, not invented:
the fleet signal-mix bar sums the five freshness counts the API already returns (each asset has exactly one
freshness), and the faceplate thermal scale places the newest reading against the pinned threshold the API already
returns. No customer, statistic, review or success claim is added. No image assets are used; every graphic is drawn
from data with SVG or CSS.

## The incumbent, read as evidence

The first redesign (screenshots `docs/design/after/` before this branch, and `work/frontend-studio/before/` at six
widths) fixed legibility, honesty and reflow. What it lacks is presence: a white top bar and a transparent rail make
the shell read as a generic admin template; every section is the same white sheet with the same weight; the
controller faceplate is the only object with character, and its number sits in a plain dark rectangle. Coloured
4px left borders on notices, cards and record rows are the commonest template tell. The programmatic focus outline on
every h1 draws a large blue box at the top of each recorded page.

## Three compositions considered

| Option                   | Idea                                                                                                                                                                                                                                           | Verdict                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Night shift           | Whole console dark, LCD-green numerals, glow everywhere.                                                                                                                                                                                       | Rejected. Near-black with one bright accent is a generated-UI default; it reads as a security dashboard, not a food-safety tool; operators work in lit back rooms and on phones in daylight. Glow everywhere would also blur the "light means live" rule. |
| B. Thermal map           | Replace the asset and incident tables with a tile grid tinted by temperature.                                                                                                                                                                  | Rejected. The tables are the HACCP-log material operators trust, they carry keyboard and record-layout guarantees tested at 320 px, and most seeded assets report no temperature at all, so a heat grid would be mostly empty tiles.                      |
| C. Cold-chain instrument | A dark equipment cabinet (rail and sign-in plate) frames a cool light working canvas; the controller faceplate becomes a real instrument with a backlit readout and a thermal scale; the fleet strip gains a signal-mix bar on the same scale. | **Chosen.** It is specific to refrigeration controllers, keeps the trusted log-sheet tables, and spends boldness in one family of objects (the instruments) while everything else gets quieter.                                                           |

Replacement test: swap "UptimeBuyer" for an unrelated SaaS. The thermal scale with its pinned-threshold notch, the
SIMULATED hatching on the gauge and the signal-mix bar only make sense for monitored refrigeration, so the page does
not survive the swap unchanged.

## Visual system

**One sentence:** the console is an instrument cabinet: a deep evaporator-blue frame, a cool steel working surface, and
backlit instruments that only glow when the reading behind them is live.

### Colour (semantic tokens in `apps/web/src/styles.css`)

| Token         | Hex                                     | Role                                                                                            |
| ------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Cabinet       | `#0C1A23`                               | Navigation rail, mobile top bar, sign-in plate. Text `#E6EEF2` (15:1), muted `#A3B7C2` (8.5:1). |
| Faceplate     | `#0F2532`                               | Controller faceplate and fleet strip. Text 13.4:1, muted `#A9BCC6` 8.0:1.                       |
| Canvas        | `#E8EDF0`                               | Working background: cool steel, never cream. Ink 14.1:1, steel 6.0:1.                           |
| Sheet         | `#FFFFFF`                               | Tables, forms, log sheets. Steel text 7.1:1.                                                    |
| Ink / Steel   | `#102028` / `#4A5B66`                   | Text and secondary text.                                                                        |
| Signal        | `#0B57A4`                               | Actions and links only (7.2:1 on Sheet, white on Signal 7.2:1).                                 |
| Coolant       | `#6FE0F2`                               | The backlight: live readouts and the active rail item only (11.5:1 on Cabinet).                 |
| Thermal scale | `#7CC8F0` → `#3E9BD6`, danger `#E2543A` | The gauge and signal-mix bar; danger only beyond the pinned threshold.                          |

Status tones keep the first redesign's text/fill/border triples (all text pairs 7:1 or better); green still comes only
from the axis mapping (FRESH, CONFIRMED, PASSED, RECOVERED). Focus: 3px `#0A5BD6` on light (5.1:1 on Canvas) and
`#FFC94D` on the cabinet and faceplate (11.6:1). The environment label stays a solid amber band (`#F6D365`, text
`#3E2A00`, 9.4:1) at the top of the working column on every page.

### Type

The three self-hosted families stay (they were chosen for glyph disambiguation under stress, and adding a font would
add a network-installed dependency for no reading gain). What changes is how they are used:

- **Barlow Semi Condensed** 500/600: page titles at 2.25rem, panel headings, the faceplate readout at up to 5rem with
  lining tabular figures. Its signage origin suits instruments.
- **Atkinson Hyperlegible Next** 400/700: everything people read.
- **Atkinson Hyperlegible Mono** 400: ids, digests, reason codes, verbatim citations and JSON only. In the incident
  title the id is set in mono at a smaller size, so the title reads "Incident" first.

No all-caps eyebrow labels, no tracked-out kickers. Field labels stay sentence case.

### Layout

```
>= 1024 px                                              < 1024 px
+---------+-------------------------------------+      +--------------------------+
| [mark]  | [!] LOCAL DEMO - ... NOT REAL        |      | [mark] UptimeBuyer Ops   |
| Uptime- |-------------------------------------|      | Command  Incidents ...   |
| Buyer   | Incident  inc_ef37...               |      | Tenant ... approver [Out]|
|         | +==== faceplate =================+  |      +--------------------------+
| Command | | 4.3 °C   [Fresh][SIMULATED]    |  |      | [!] LOCAL DEMO - ...     |
| Incid.  | | |==scale===|^8.0 threshold|   |  |      +--------------------------+
| Ledger  | |---------------------------------|  |      | Incident inc_...         |
| Polic.  | | state  deadline  owner  next    |  |      | +== faceplate ========+  |
| Notif 18| +=================================+  |      | | 4.3 °C  scale       |  |
|         | ( Overview | Evidence | Plan ... )   |      | | state deadline ...  |  |
| Tenant  | +-- sheet ------------------------+  |      | +=====================+  |
| Scope   | |                                 |  |      | ( tabs, wrapping )       |
| user    | +---------------------------------+  |      +--------------------------+
| [Sign out]                                     |
+---------+-------------------------------------+
```

Left-aligned throughout. The rail is sticky and full height; the tenant, scope, user and Sign out sit at its foot. The
working column has an 88rem limit so 1920 px screens do not stretch tables into unreadable lines. Below 1024 px the
cabinet becomes a top bar with wrapping 44 px navigation chips.

### Principles

1. **Light means live.** Only a FRESH, non-simulated, unpaused reading is backlit (coolant digits, solid scale fill).
   A simulated reading is drawn in plain white with an amber hatched scale fill; a last-known reading is grey with a
   grey hatched fill. The hatching echoes the dashed SIMULATED_INPUT tag, so the same cue means the same thing.
2. **One instrument family.** The faceplate and the fleet strip are the only dark objects in the working column and
   the only places with a scale graphic. Everything else is quiet sheet and ink.
3. **Log sheets stay log sheets.** Tables keep the heavy header rule and tabular figures; they gain a sunken header
   band and a hover tint for scanning. Narrow tables still become labelled records.
4. **Shape before colour.** Notices gain a drawn shape icon (triangle, octagon, circle, question) instead of the 4px
   coloured left border; record cards and notifications use a 1px outline and a tone tag, not a side stripe.
5. **Radius follows hierarchy:** faceplate 16px, sheet 12px, control 8px, tag 4px. Soft offset shadows only on sheets
   (low) and dialogs (high).
6. **Browser surfaces belong to the design:** themed selection, caret, accent-color, scrollbar colours and underline
   offsets.

## Motion contract

One orchestrated moment, two pieces of continuity, and responses to actions. All CSS transitions or `@starting-style`
driven by values set through the CSSOM (allowed under the CSP); nothing hides content, and the existing global
`prefers-reduced-motion` rule removes every transition and animation, leaving the final state immediately.

| Target                               | Purpose                                           | Trigger                       | Start → end                                                                                                                           | Interruption                                      | Reduced motion            | Cleanup                                     |
| ------------------------------------ | ------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------- | ------------------------------------------- |
| Faceplate thermal scale (the moment) | Show where the reading sits against the threshold | Incident opens; a new reading | Fill grows from the cold end to the reading in 700 ms, critically damped (no overshoot past the reading); later readings glide 700 ms | A CSS transition retargets from its current value | Static at the reading     | None needed (CSS only; value set on render) |
| Fleet signal-mix bar                 | Show the fleet's freshness proportions            | First load; each 15 s poll    | Segments grow from zero on first paint; on a poll they re-proportion                                                                  | Retargets                                         | Static                    | None (CSS only)                             |
| Incident section indicator           | Continuity between sections                       | Section link activated        | The active plate slides to the new section (240 ms, slight spring)                                                                    | Retargets mid-slide                               | Jumps                     | ResizeObserver disconnected on unmount      |
| Citation drawer, dialogs             | Show what opened and from where                   | Button press                  | Drawer slides 24 px from the right; dialogs rise 8 px without fading (a fade failed T-049 contrast); backdrop fades                   | Native dialog close is immediate                  | Appear in place           | None                                        |
| Buttons, links, tabs                 | Direct feedback                                   | Hover, press                  | Colour 120 ms; press nudges 1 px                                                                                                      | Immediate                                         | Colour change only        | None                                        |
| Telemetry chart line                 | Continuity between readings (T-052)               | New reading                   | Path eases 300 ms                                                                                                                     | Retargets                                         | None (T-052 asserts this) | None                                        |

Never: count-up numbers (they show wrong values while counting), pulsing alerts (T-052 forbids infinite animation on
critical and alert elements), entrance fades on sections, motion on live telemetry that shifts layout.

The spring curves are CSS `linear()` easings sampled from a damped spring with the method Motion uses
(`generateLinearEasing` in motion-dom), ported into `apps/web/src/motion/spring.ts` and pinned by a unit test so the
CSS tokens cannot drift from the generator.

## Upstream selection

| Provider                     | Role here                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic frontend-design    | Primary direction method: subject-world plan, compositions compared, defaults to avoid.                                                |
| Impeccable                   | Operate-mode depth and the craft floor (shape over side stripes, browser surfaces, states).                                            |
| Motion                       | Spring physics and `linear()` easing generation (ported), reduced-motion handling pattern.                                             |
| Magic UI                     | GridPattern read and adapted as the faceplate's engraved grid (CSS, not the React SVG). NumberTicker and BorderBeam read and rejected. |
| UI/UX Pro Max                | README read; its earlier queries for this product are recorded in REDESIGN.md and still apply.                                         |
| shadcn/ui, React Bits, Taste | Read and deliberately not used (reasons in SOURCES.md).                                                                                |

No runtime dependency is added: everything is CSS and a few lines of React.

## Acceptance checks

- `pnpm verify` exits 0 (T-049..T-052, the faceplate, notice-contrast and reflow specs, bundle secrets).
- Rendered review at 1920, 1440, 1024, 768, 375 and 320 px, normal and reduced motion, with at least one fix round.
- The skill's evidence gate run on the final review manifest, reported as it comes out.

## Rendered review: what the screenshots showed and what changed

Every round was rendered over the seeded SIMULATED harness at 1920, 1440, 1024, 768, 375 and 320 CSS px, with motion
allowed and with `prefers-reduced-motion: reduce`, and the motion was sampled over time (computed `clip-path`, `left`,
`transform` of the scale, signal mix and section plate). Evidence is in `work/frontend-studio/run-01` to `run-04`;
the captures that matter are committed under `docs/design/studio/` and `docs/design/after/`.

| Round | Seen                                                                                                                | Change                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Sign out in the rail rendered as a white button: `.btn` came later in the cascade than `.btn-cabinet`.              | The cabinet variant is `.btn.btn-cabinet`.                                                                                        |
| 1     | In full-page captures the rail stopped at the first viewport height and the canvas showed below it.                 | The cabinet colour runs down the page behind the sticky rail.                                                                     |
| 1     | The sign-in plate sat high with an empty lower half.                                                                | The page is centred vertically; the plate ends with the thermal-scale motif (no values, `aria-hidden`).                           |
| 1     | Dense seeded samples drew as overlapping rings, which read as a coil rather than a line.                            | Samples closer than 8 px draw as 1.75 px dots; every sample is still marked and anomalies keep their triangles (T-052 unchanged). |
| 1     | T-049's axe scan of the approval confirmation found low contrast: the scan ran mid fade-in.                         | Dialogs rise without fading, so their text is at full contrast from the first frame; only the backdrop fades.                     |
| 2     | At 1920 a 200 px dead band on the right; the readout looked small in its plate.                                     | Content limit 104rem from 1800 px, wider readout column, 4.75rem digits.                                                          |
| 2     | Fleet tiles at 1920 left empty grid tracks.                                                                         | `auto-fit` tracks, so tiles share the row.                                                                                        |
| 2     | Between 768 and 1279 px the facts stacked into one tall column beside a short readout.                              | The readout spans the plate (value left, scale right) above three columns of facts; side by side from 1280 px.                    |
| 2     | In narrow record layouts a status tag stretched across its cell ("Allow" as a full-width bar).                      | Record cell children keep their own width.                                                                                        |
| 2     | The action queue was a bare bullet list.                                                                            | Ruled rows, like the log sheets.                                                                                                  |
| 3     | Regression from round 2: at 1280 px and wider the scale collapsed to 84 px (the tablet rule's `align-self` leaked). | The tablet readout grid is scoped to 768–1279 px; measured scale width 359 px at 1440 and 284 px at 1024.                         |

Motion, measured at 1440 px with motion allowed: the scale fill opens from `inset(0 98.9%)` to the reading in about
600 ms with no overshoot; the section plate travels 4 px → 213 px in about 300 ms with a 1 px settle; after leaving
for the Command Center and returning, the plate and scale are re-placed with no console errors. With reduced motion
every sample is already at its final value.
