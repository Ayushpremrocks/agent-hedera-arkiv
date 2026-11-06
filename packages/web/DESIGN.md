# QueueYield web: design system

## Brief
Subject: QueueYield, a market where AI agents buy GPU time with a guaranteed latest start (`startBy`)
and trade places when urgency changes. Audience: developers who run agents, hackathon judges,
Hedera/Arkiv mentors. Job: make the guarantee understood in 10 seconds, then get a HashPack sign-in.
Reference for tone: fluence.ai (dark, technical, GPU cloud), but where Fluence rents machines by
the hour, QueueYield sells a promise per job. Stack: the existing Vite + React 19 app, plus GSAP for
the one clock. No Lenis: the landing is short and native scroll is fine. No WebGL: SVG carries it.

## Concepts considered
| Concept | Territory | Anchor | Orig | Fit | Feas | Port |
|---|---|---|---|---|---|---|
| Promise lines: the page is a scheduler's time axis; every job is a bar that must start before its own dashed line | formal system (the product's own math) | `startBy` + hard run limits; the real worker-lane replay | 4 | 5 | 4 | 2 |
| Departure board: tickets as split-flap rows ("departs by") | material (ticketing) | the queue ticket | 3 | 4 | 4 | 3 |
| Ticket stub: perforated tickets torn on a trade | material | tokenized tickets | 3 | 3 | 3 | 4 |
Picked: **Promise lines**. It can only belong to a product whose core claim is a guaranteed start.
Borrowed from the runner-up: timestamps set like a departure board in the network feed.

## Concept card
- Idea: every job gets a dashed line it must start by, and the page shows jobs landing before their lines.
- Metaphor: a scheduler's worker lanes on a time axis (the same picture as diagrams/5-timing).
- Signature: the hero "lanes": a live replay of the scheduler. Jobs arrive, get a dashed promise tick,
  a ghost outline shows their worst-case limit, the real bar runs shorter and starts before the line.
  An amber "now" line sweeps continuously. Driver: one clock (GSAP ticker) = simulated seconds.
- Emotion: calm certainty. Things are busy, nothing is late.
- Motion verb: **land before the line**: elements slide along x and settle short of a dashed mark.
- Screenshot: the hero lanes with three bars sitting left of their dashed promises and the amber now-line.

## System
- Palette: ground `#0b0d10` (graphite), raise `#12161b`, ink `#e8ecf0`, muted `#9aa4af` (AA on ground),
  line `rgba(232,236,240,.12)`, accent **now** `#ffb000` (the brand's existing amber, used only for
  "now", promise ticks and the primary CTA), kept `#57c9a4` (a promise met, sparing), warn `#ff7a59`.
- Type: Archivo variable (wdth 62..125) only. Width is the hierarchy: display at wdth 125 / 800,
  labels condensed (wdth 75). Tabular numbers everywhere. Display tracking -0.035em, leading 0.95.
  Hover on nav links changes width (type changes axis).
- Grid: 12 columns, max 1240px, 24px gutter. Sections alternate: full-bleed lanes / split / index list / band.
- Shape: radius 10px on surfaces, 999px on pills and buttons. One rule.
- Motion: ease `cubic-bezier(.2,.7,0,1)`; small 180ms, medium 420ms, large 900ms. Stagger 40ms.
  Primary buttons: the label slides out and a copy slides in (land before the line); arrows travel.
  Reduced motion: the lanes render one static, fully labelled frame; no sweeps.
- Idle: the now-line keeps moving (it is time), paused off screen.

## Composition
```
[logo]                                  [Network status] [Get started]
H1 (wide, 2 lines)            | sub + CTA
LANES ======================================================== full bleed
 W1 |███▒▒▒  ┊   ████▒▒ ┊        |amber now
 W2 |  ██▒▒▒▒┊ ███▒┊               labels: "starts by" ticks
--------------------------------------------------------------
THE PROMISE (split): formula left | live provider numbers right
IN A HURRY (index list of 3 rules, numbered because it IS a sequence)
LIVE NETWORK (departure-board table, mono-free tabular figures)
FOOTER band: huge wide QUEUEYIELD, links, "Hedera + Arkiv"
```
App pages share the dark tokens (one committed theme).

## The app (Operate mode) and the Network page
Same world, quieter. Recorded from the built code (src/app.css, components/ui.tsx).
- **Promise track** (`PromiseTrack`): the app's signature. Every task is a rail from booking to just past
  its deadline: bar = elapsed time (green when delivered on time, amber when late, coral when failed,
  ink while open), dashed amber mark = starts by (the provider's guarantee), solid ink mark = due.
  Large variant labels the marks. Preview variant (New task) draws the worst case striped.
- **Shell:** one left rail (#0f1216, 248px): wordmark, amber "New task", nav (active = raised fill and
  amber icon, never a colored side border), agent card at the foot (status pulse, budget left, account,
  sign out). No top bar. Below 820px the rail becomes a sticky top bar with a scrolling nav.
- **Page header:** optional back link, h1 2rem / wdth 118 / 800, one line of intro, actions right.
- **Ledger:** money and counts as one ruled statement line (no metric cards).
- **Blocks:** sections without boxes; boxes only for things you act on (live rows, compose panel,
  results, the detail track).
- **Controls:** pills (999px) for buttons, tabs, chips; 8px for inputs; 10-14px for panels. Primary
  = amber, ghost = hairline. Radio choices are bordered rows that turn amber when chosen.
- **Tables:** hairline rows, condensed 12px headers, name + one-line preview, tabular numbers right.
- **Motion:** state only: 160ms color/border, 900ms linear track growth, a pulse while work is open.
  Page changes use view transitions. Reduced motion stops the pulse and track easing.
- **Browser surfaces:** dark scrollbars, amber caret and selection, amber focus ring.
