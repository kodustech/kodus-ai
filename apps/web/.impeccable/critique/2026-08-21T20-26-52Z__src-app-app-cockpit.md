---
target: Cockpit
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 3
p1_count: 2
timestamp: 2026-08-21T20-26-52Z
slug: src-app-app-cockpit
---
Method: dual-agent (A: design review, isolated · B: detector + static evidence, isolated)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Four KPI cards hardcode a 2-week window while the charts below honour the date picker; no "data as of" anywhere |
| 2 | Match System / Real World | 2 | *Kody* and *Kodus* used interchangeably on one screen; Team Activity prints its range backwards (`{weekEnd} ~ {weekStart}`) |
| 3 | User Control and Freedom | 2 | Full-screen scrim on filter change can't be cancelled; filters use `replaceState` so Back doesn't undo them; no reset, no export |
| 4 | Consistency and Standards | 1 | Two byte-identical tooltip components; two toggle idioms; two card-header idioms; a border on a Card against the system's own rule |
| 5 | Error Prevention | 3 | Genuinely strong — refuses to render a rate below 10 reactions, fades low-sample bars. Undercut by the date-window mismatch |
| 6 | Recognition Rather Than Recall | 2 | Severity legend renders in only one toggle mode; Elite/High/Fair thresholds live inside a hover tooltip |
| 7 | Flexibility and Efficiency | 2 | URL-as-state and Share View are real; but drill-down is mouse-only and every filter costs a full reload |
| 8 | Aesthetic and Minimalist Design | 2 | Landing tab: 5 KPI cards + 8 stacked sections + 6 independent toggles, no summary, no progressive disclosure |
| 9 | Error Recovery | 2 | Per-slot boundaries with working `reset()` — but all seven print the same sentence and two don't render their title |
| 10 | Help and Documentation | 3 | Real in-context glossaries where they matter; but no definition of Bug Ratio, p75, or how "implemented" is detected |
| **Total** | | **21/40** | **Acceptable — significant work needed** |

## Design Specificity Verdict

**Product-specific content wearing a generic interface, with the generic half given equal billing.**

The **Kodus Review tab** could not be reused by another product: implementation rate of Kody's own suggestions week over week, negative-vote rate on its comments, criticals unaddressed *on merged PRs*, and Kody Rules classified healthy/noisy/ignored/**stale**. A rule that fires constantly and nobody implements is an object that exists only here.

The **Productivity tab** could be lifted into LinearB or Swarmia tonight. Deploy Frequency, PR Cycle Time p75, Bug Ratio, PR Size, Lead Time Breakdown, and an Elite/High/Fair badge scale are the category's stock vocabulary — measuring things Kodus neither produces nor influences.

The interface language is not specific at all, and the code says so: "shadcn-style floating tooltip" appears verbatim in two files. The declared design system is bypassed wholesale.

**Deterministic scan:** the detector returns **0 findings, exit 0** — on both the route shell and the real 84-file feature directory, validated against a detector that returns 25 findings elsewhere in `src`. No fake buttons, no decorative side-tabs. The deterministic layer is genuinely clean; every weakness below is invisible to it.

**Visual overlays:** unavailable. `kodus_web` is healthy on :3000, but `/cockpit` returns 307 → `/sign-in`. No screenshot was taken and no visual assertion is made. The unblock is a human-authenticated session.

## Overall Impression

Someone on this team thought hard about not lying to a leader — and then buried the result in 11px grey footnotes under a screen that opens with "👋 Good morning!". The statistical honesty here is the best design decision in the product; the biggest opportunity is to promote it from a footnote to the thesis.

## What's Working

**1. Statistical honesty implemented as a change of form, not a caveat.** Below 10 reactions the negative-vote card doesn't append a disclaimer — it *refuses to render the percentage*, showing raw counts and "only 4 reactions — too few to be a rate". Low-sample bars drop to 0.3 opacity with a plain-English footnote. The product's central credibility risk is an AI grading its own homework on thin data, and the fix lands on the exact pixel where the wrong inference would be made.

**2. Failure isolation that preserves identity.** Each parallel route carries `default`/`error`/`loading`, and the card chrome and title live in the slot's `layout.tsx` — so a failed panel keeps its frame and name and the grid never collapses. One dead endpoint costs one card, not the dashboard.

**3. URL-as-truth with a self-hosted-aware share path.** Filters are the URL; `ShareViewButton` falls back to a textarea + `execCommand` because `navigator.clipboard` is blocked on self-hosted instances over plain http. Designed for the actual deployment constraint, not the happy one.

## Priority Issues

### [P0] Four KPI cards silently ignore the global date filter
**Verified.** `@bugRatioAnalytics`, `@prCycleTimeAnalytics`, `@prSizeAnalytics`, `@deployFrequencyAnalytics` each compute `const startDate = subWeeks(endDate, 2)`. Every chart beneath them calls `getSelectedDateRange()`. The picker can read "Last 3 months" while the card says "Last 2 weeks was 26h" and the chart below plots 90 days.
**Why it matters:** the leader is here to form a judgment and forward it. Two adjacent panels answer the same question over different windows and nothing says so. The error is invisible and non-recoverable.
**Fix:** use `getSelectedDateRange()` in all four. If 14 days is a deliberate stability choice, state it in the card and stop labelling it as the selected range's comparison period.
**Command:** `/impeccable harden`

### [P0] The documented primary drill-down is unreachable by keyboard
**Verified.** `src/core/components/ui/data-table.tsx` exposes `onRowClick` on `TableRow` with `cursor-pointer` and **zero** `tabIndex`, `role`, or `onKeyDown`. Both health tables instruct the user to use it ("Click a row to focus the whole cockpit on that repository").
**Why it matters:** the two tables are where analysis becomes action. For a keyboard or screen-reader user that action does not exist, and the surface tells them to perform it anyway. It is in the *shared* component, so every table in the app has it.
**Fix:** make the first cell a real link/button carrying the row's accessible name, or add `role="button"` + `tabIndex={0}` + Enter/Space + `aria-label` in `DataTable`. One fix, whole app.
**Command:** `/impeccable harden`

### [P0] The focus ring is invisible — and the palette already has the answer
**Verified by calculation.** `globals.css:509` and `button.tsx:13` set the ring to `card-lv3` (`#30304b`). Against a `card-lv1` surface (`#181825`) that is **1.38:1**; against `card-lv2`, **1.26:1**. WCAG 2.1 SC 1.4.11 requires **3:1** for a focus indicator. Signal Amber on the same ground measures **10.02:1**.
**Why it matters:** DESIGN.md states the ring is thick *specifically* because "a keyboard user on a dark dense screen needs to find the focus quickly." It is thick and unseeable — the system promises the affordance and the token cancels it.
**Fix:** point the focus ring at the accent (or any token clearing 3:1). It is one value and it fixes every focusable element in the product.
**Command:** `/impeccable harden`

### [P1] Full-screen blocking scrim on every filter change defeats the streaming architecture
`date-range-picker.tsx` and `repository-picker.tsx` both mount `fixed inset-0 bg-black/70 backdrop-blur-sm` with a 64px spinner during the transition. Ten `loading.tsx` files and per-slot skeletons exist precisely so the ready panel shows first — and all of it is hidden behind an opaque sheet. In the default `immediate` commit mode a custom range fires this **twice**.
**Why it matters:** filtering is the most frequent action on the screen. Blacking out the whole cockpit on a routine filter change is the wrong signal for an instrument panel, and it is the strongest negative emotional beat here.
**Fix:** delete both overlays; use the existing `useTransition` pending flag to dim `Page.Content` only, keeping the header live, and let the slots stream. Pass `commitMode="onClose"` so a custom range costs one reload.
**Command:** `/impeccable optimize`

### [P1] The leader's question is unanswered at the top, and cost is entirely absent
The h1 is `greeting()` — "👋 Good morning!", computed from the *server's* clock. There is no summary, no verdict, no "as of", and — verified by grep across the whole feature — **no cost, spend, or token figure anywhere**, nor any link to `/token-usage` or `/byok`.
**Why it matters:** PRODUCT.md Principle 1 says every leader surface must resolve "is this working, and what do I change?" on arrival. Principle 5 says cost is a first-class product fact. The positioning is BYOK-without-a-toll. The surface where a leader decides whether the practice is paying off has no number with a currency symbol.
**Fix:** replace the greeting with a one-line assertion built from data the page already fetches — reviews run, implementation rate, criticals open — plus spend, each noun anchor-linking to its section.
**Command:** `/impeccable shape`

### [P2] Status colours used decoratively, and three amber regions at once
Lead Time paints Coding=danger / Pickup=warning / Review=success; PRs Opened vs Closed paints Closed=danger; Team Activity renders every merged PR as a `--color-danger` tick. None are statuses — a closed PR is not an error. Meanwhile amber lights the active tab, the selected health chip, and the implementation-rate area fill simultaneously.
**Why it matters:** DESIGN.md's Status-Is-Not-Accent and One Lamp rules exist so red means *attend to this*. By the time the leader reaches the genuinely red thing — unaddressed criticals — red has been spent.
**Fix:** define a categorical ramp once and use it for non-outcome series; reserve success/warning/danger for real outcomes; reduce amber to one region per view.
**Command:** `/impeccable colorize`

### [P2] The token system is bypassed in ~59 places, and a shared palette already exists
`recharts-shared.tsx` defines `CHART_COLORS` with the comment "Brand palette shared by the recharts-based cockpit charts." Nine components import recharts; **only five import it**. The other four copy-pasted its values verbatim — `tick: { fill: "#f3f3f780", fontSize: 11 }` appears byte-identical in four files. There are two parallel tooltip implementations carrying near-identical doc comments. `insights-badge.tsx` and `percentage-diff.tsx` invent `hsl()` values *near* the system's success/danger but not equal to them.
**Why it matters:** this is not drift from having no system — it is drift from having one and bypassing it. Retheming or a contrast fix becomes a manual sweep of fifteen files.
**Fix:** expose `--chart-1…n` in `globals.css`, delete the duplicate tooltip, and route all nine consumers through the shared module.
**Command:** `/impeccable colorize`

## Persona Red Flags

**Alex (impatient power user)**
- Every filter change blacks out the entire app. No optimistic state, no cancel. He hits this ten times a session.
- A custom date range costs **two** full reloads — the cockpit passes no `commitMode`, so it commits on the first calendar click. The `onClose` mode that fixes it exists in the same file, unused.
- He will be silently wrong about his own numbers: he sets 90 days precisely because he's fast, glances at the top four cards, and reads a 14-day figure.
- Repository picker fights fast input — `displayedCount` resets on every keystroke, and the "All repositories" row renders as two different items depending on selection state, so its position shifts under him.
- No shortcuts, no saved views, no CSV or copy-as-table on any of nine charts. Share View copies a link; his weekly report needs data.

**Sam (screen reader + keyboard only)**
- The two health tables are inoperable, and the copy instructs him to do the one thing he cannot.
- Team Activity is silent: cells render unlabelled 1px `div` ticks, and the count lives inside a `TooltipTrigger` with no accessible name and no children. The densest panel conveys nothing.
- Four expand controls are icon-only Buttons with no `aria-label` and no `aria-expanded`; activating one absolutely positions the card over its neighbours with no `role="dialog"`, no focus move, no focus trap.
- Chart legends are colour-only toggles — no `aria-pressed`, no text change.
- The focus ring measures 1.38:1 (see P0).
- Heading outline is unusable: h1 is "👋 Good morning!", then ~13 `h3`s from `CardTitle` with **no h2 anywhere**.
- Nothing is announced when the view changes — no `role="status"`, no live region, after a full reload.
- Across ~84 files the surface carries **1 `aria-label` and 0 `role=`**. Nine recharts consumers, **zero** with `accessibilityLayer`, `aria-label` or `<title>`.

## Minor Observations

1. `src/core/components/ui/image.tsx:15` defaults `alt` to the literal string **"(no description provided)"** — so a decorative mascot announces that sentence to a screen reader, which is worse than `alt=""`. The wrapper's type makes `alt` optional, so nothing forces the call site to decide. Repo-wide, 6 call sites.
2. The cockpit shell has `loading.tsx` and `layout.tsx` but **no root `error.tsx`** — a throw in the shell has no local boundary.
3. Team Activity runs time backwards twice: `interval.reverse()` makes weeks descend left→right, opposite every other chart, and the header prints end date first.
4. Module-scope `const today = new Date()` feeds both the presets and `disabled={{ after: today }}`; a tab left open overnight offers stale ranges and blocks today.
5. Voice drifts to consumer: "Doing some magic…", "watch the magic happen" with a mascot PNG, "No negative feedback in this period 🎉" — against DESIGN.md's explicit "no illustration, no emoji as section markers".
6. Elite/High/Fair thresholds are asserted as fact with no source, while PRODUCT.md is explicit that benchmark numbers "must be supplied, not invented."
7. `src/app/(app)/cockpit/page.tsx` is literally `export default () => null;` — the route dir is a 52-file re-export shell; the real surface is `src/features/ee/cockpit/` (84 files).
8. Commented-out code shipped in four layouts, plus an entire dead commits series leaving `commitsClassname` declared and unused.

## Questions to Consider

1. If the leader could read exactly one line before closing the tab, which line would you want it to be — and can you defend "👋 Good morning!" occupying that position?
2. The Productivity tab measures things Kodus neither produces nor influences, on a badge scale borrowed from someone else's research. If you deleted it tomorrow, would a customer churn — or would the Kodus Review tab finally get the full width and the team stop maintaining two visual dialects?
3. PRODUCT.md says cost is a first-class fact and BYOK-without-a-toll is the whole positioning. Who decided spend belongs on a different page, and what is the leader supposed to conclude here without it?
