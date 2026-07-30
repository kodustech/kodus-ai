# Anchoring eval

How much real-finder recall is lost at the **line-anchoring** stage — and is the
anchor-fix still holding?

To post an inline comment, a finding must map onto a line that's part of the PR
diff (GitHub/GitLab only allow comments on diff lines). The production stage that
does this is `snapLinesToDiff` (in `agent-review.stage.ts`): if a finding's cited
lines overlap a changed hunk it's snapped onto it; if they overlap **nothing**,
the finding is **dropped**. A real bug the finder found and verify kept can
silently vanish here if the model anchored it on the wrong line/file.

## What it does

Runs the production finder (real `GeneralistAgentProvider` loop) over benchmark
PR diffs with deterministic tool replay — same machinery as the finder-recall
eval — then applies the **real** `snapLinesToDiff` to every finding and reports:

- **KEPT** — anchored onto a hunk (survives to posting).
- **DROPPED** — cited lines overlap no hunk. Split by distance to the nearest hunk:
  - **near-miss (≤ tol lines)** — a recoverable recall loss (the model was almost
    on the diff). This should stay **0**.
  - **far-off (> tol)** — finding points at unrelated/symptom code; correct to drop.

```bash
node evals/anchoring/anchor-eval.js [--limit=25] [--model=gpt-5.4|gpt-5.4-mini] [--tol=2] [--gate]
```

`--gate` (CI) fails if any near-miss drop occurs or the drop-rate exceeds
`--drop-max` (default 8%). Needs the model key in `~/.kodus-dev/config`. Loads
`.ts` via an esbuild require-hook (agent-loop.ts has mid-file imports ts-node
won't hoist).

## Result — the anchor-fix is holding, and the eval proves it

gpt-5.4, 25 benchmark PRs, real `snapLinesToDiff`:

| run | findings | dropped at anchoring |
|---|---|---|
| **current main** (anchor-fix on) | 44 | **0** (0%) |
| anchor-fix disabled (A/B) | 51 | **2** (4%) |

The line-anchoring leak recorded earlier is **already closed on main** by the
cross-file anchor-fix (`SCOPE_CROSS_FILE_EXTRA` in the base agent — anchor on the
changed trigger line, never the unchanged symptom file). This eval **confirms**
it: 0 drops with the fix.

The A/B (toggling the fix off via `DISABLE_ANCHOR_FIX`) proves the eval is
**sensitive** — drops appear (0 → 2) when the fix is removed, and they're far-off
(20 & 55 lines: the model anchoring on the wrong location), exactly the failure
mode the fix targets. So this is a **regression guard**: if the anchor-fix or the
snap logic breaks, drops climb and the gate fails.

Caveat: single run per side, so finding counts carry LLM noise; the signal is the
drop-rate (0% vs 4%), not the raw counts. The near-miss bucket stayed 0 in all
runs — no evidence of an off-by-a-couple-lines leak; the real (now-fixed) leak was
far-off cross-file mis-anchoring.

## Next

- N≥3 reps per side for a noise-free delta.
- Phase 2: wire the recall-judge to label dropped findings as TP/FP, turning
  "drops" into "real bugs lost" (golden comments carry no line, so matching needs
  the judge).
