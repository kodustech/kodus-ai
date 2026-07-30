# Dedup hardening — experiment ledger

**Objective:** minimize the *mean* goldens dropped to over-merge, WITHOUT raising
noise (mean under-merge, or losing good dup-merges). Model: gpt-5.4-mini (prod).
Set: 39 dedup-relevant PRs, 48 goldens covered, golden labels cached (Sonnet).

**Methodology (the over-merge is noise-dominated):** every config is measured over
N≥4 replications and compared by MEAN. A change counts only if its mean
goldens-dropped is clearly below baseline (outside the ~±2 noise band) AND its mean
under-merge is not higher. Single runs decide nothing.

| # | config | runs (goldens-lost) | mean lost | mean under | verdict |
|---|---|---|---|---|---|
| 0 | **baseline** (default temp, current prompt) | 1, 2, 6, 3 | **3.0** | ~2.3 | reference (range 1–6) |
| 1 | **temp=0** | 3, 3, 3, 1 | **2.0** | 1.8 | ✅ KEEP — variance collapsed (range 1–3, no more 6s), under not worse |
| 2 | **temp=0 + guard=exact** (only same-file overlapping merges) | 0, 1, 0, 0 | **0.20** | 3.2 | near-zero over-merge; cost = under +0.9, goodDup ~12→10 (2 legit cross-file dups un-merged) |
| 3 | **temp=0 + guard=samefile** (block only same-file-non-overlap; allow cross-file) | 3, 1, 0, 1 | **1.25** | 2.25 | ✅ over-merge halved+ with NO noise cost (under≈baseline, goodDup≈12). Residual loss is cross-file over-merge. |

## Conclusion — the deterministic frontier (all include temp=0, which collapses variance 1–6 → tight)

| config | mean lost | mean under | goodDup | reading |
|---|---|---|---|---|
| baseline | 3.0 | 2.3 | 12 | reference |
| temp=0 | 2.0 | 1.8 | ~12 | free win (variance gone, no cost) |
| **temp=0 + guard=samefile** | **1.25** | 2.25 | 11.5 | **meets the strict objective: over-merge ↓ without raising noise** |
| temp=0 + guard=exact | 0.20 | 3.2 | 10 | near-zero over-merge; costs ~2 extra dup comments / 39 PRs |

Further deterministic gains are exhausted: the residual loss under `samefile` is
cross-file over-merge, and separating cross-file-same-bug (good) from
cross-file-different-bug (over-merge) needs fuzzy similarity judgment — the thing
this whole exercise showed is noise.

## BYOK reality check — the guard is temperature-INDEPENDENT (default temp, no temp=0)

We can't force temp=0 in BYOK (customer's model; reasoning models ignore/reject it).
But the guard is deterministic POST-processing of the model's groups, so it works on
any model at any temperature:

| config (DEFAULT temp) | mean lost | mean under | goodDup |
|---|---|---|---|
| baseline | 3.0 | 2.3 | 12 |
| guard=samefile | 1.25 | 3.25 | ~11 |
| guard=exact | 0.50 | 4.0 | 10 |

`guard=exact` cuts over-merge 3.0 → ~0.5 WITHOUT temp=0 — same as with it (0.2). So:
**the deterministic guard is the real, BYOK-safe fix; temp=0 is an optional platform-
only bonus.** Cost of the guard is leaving a few more duplicate comments (under/goodDup),
which is a great trade vs dropping real bugs.

## The overlap hole (user-spotted) + the full cost curve

`guard=exact` allows ANY same-file overlap — so a BROAD finding (whole function,
e.g. lines 52–77) can still swallow a NARROW distinct bug inside it (lines 74–78,
overlap 4/26 = 15%). That's the residual ~0.5 over-merge under exact. Found 3 such
cases in 5 passes (addGuests 4/26, scheduleSMSReminders 1/31).

Fix = require the overlap to cover a fraction of the LARGER range (`guard=tight`,
`tightRatio`). Closing the hole fully works but costs noise — the milder the better
but still pricey:

| config (default temp = BYOK-real) | mean lost | mean under | goodDup |
|---|---|---|---|
| baseline | 3.0 | 2.3 | 12 |
| guard=samefile | 1.25 | 3.25 | ~11 |
| **guard=exact** | **0.5** | 4.0 | 10 |
| guard=tight @0.25 | **0.0** | 6.0 | 8 |
| guard=tight @0.5 | **0.0** | 7.0 | 7 |

Closing the last ~0.5 over-merge (exact→tight@0.25) costs ~+2 residual dups and ~−2
good merges. It's a clean judgment call: 0.5 dropped real bugs/run vs ~2 extra
duplicate comments/run.

**Recommendation to ship (port to production deduplicateSuggestions, BYOK-safe):**
- `guard=exact` — over-merge 3.0→0.5, moderate noise (under 4). Best balance.
- `guard=tight @0.25` — over-merge →0 (no dropped real bugs, closes the overlap hole),
  costs ~2 extra dup comments. Pick this if "never drop a real bug" outweighs dup noise.
- `temp=0` additionally on the platform gpt-5.4-mini path (free; not relied upon — BYOK
  can't force it, and the guard doesn't need it).

## Rejected (within noise — see session)
- prompt "1-fix test" hardening: single run 6 → within baseline range. Not real.
- prompt "same-file ≠ dup" clause: single run 3 → within baseline range. Not real.

## Candidate queue (structural first)
1. temperature = 0 (collapse stochasticity at the source) — IN PROGRESS
2. deterministic guard: allow only exact same-file/overlapping-line merges; disable
   cross-location grouping (where the over-merge of distinct bugs happens)
3. combinations of the above
