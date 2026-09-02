# Metamorphic eval

The layer contract- and mutation-tests cannot reach. A metamorphic test does not
compare output to a golden label; it runs the **same** production function on an
input and on a semantics-preserving **transform** of that input, then asserts the
required **relation** between the two outputs. This catches the class of bug that
is valid in isolation but wrong when it must not change: ordering
nondeterminism, context-sensitivity, whitespace sensitivity — the stochastic
failure modes behind issue #1786 that a single-shot assertion never sees.

## Relations

- **MR1 order invariance** — reordering the input suggestions must not change the
  presented order. Driven against the real `sortSuggestionsByPriority`
  (`suggestion.service.ts`).
  - *MR1a (distinct keys)* — gating: order is fully determined by the sort key. Holds.
  - *MR1b (tied keys)* — **known break**: when `rankScore` **and** `label` tie,
    the comparator returns 0 and V8's stable sort preserves input order, so the
    same PR renders suggestions in a different order depending on upstream order.
    Reported, not blocking. **Fix**: add an `id` tiebreak to the comparator; MR1b
    then flips into a hard invariant.
- **MR2 duplicate context does not downgrade severity** — duplicating a finding
  (the "N models echo the same issue" / dedup-input case) must never lower any
  surviving finding's severity. Relation: `severity(withDup) >= severity(base)`.
- **MR3 whitespace-only change adds no findings** — reindenting added lines must
  not manufacture findings. Relation: `findings(noisy) ⊆ findings(base)`.

## Layers

- **Layer 1 (deterministic, gating, in CI)** — `run.js` with no flags. Drives the
  real production function (MR1) and deterministic oracles (MR2/MR3). Proves both
  the relation and the harness; surfaces MR1b as a documented known break. No LLM
  keys.
- **Layer 2 (live, report-only)** — `run.js --model=<id>`. Applies the same
  relations to the real model via the finder/severity seams. Never blocks (mirrors
  the promptfoo dimensions in `run-suite.js`).

## Run

```bash
pnpm eval:metamorphic                       # deterministic, gating (exit 0/1)
node evals/metamorphic/run.js --model=gpt-5.4-mini   # + live legs (report-only)
```

Exit: `0` pass · `1` a NEW gating invariant broke (`--gate`) · `2` infra.

Wired into `evals/run-suite.js` as a gating dimension.
