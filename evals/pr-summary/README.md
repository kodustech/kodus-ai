# PR-summary eval

Guards the **"generate PR summary on open"** feature — the AI description Kody
writes to a PR when a client opens it.

## Why this exists

A prod incident: the summary path silently routed to a model nobody configured
(a Gemini default with no BYOK / no key), every client lost their PR summary, and
**no eval caught it**. The review agents kept working — they resolve BYOK
themselves — so the model matrix stayed green while summaries were dead.

This eval closes that gap. It drives the **real**
`CommentManagerService.generateSummaryPR` + `updateSummarizationInPR` end-to-end
and asserts the three things that incident violated, plus the client-facing
behaviour contract.

## What it asserts (per case, word-independent so a live model can't flake it)

1. **Generated** — a non-empty summary comes back.
2. **Posted** — `updateDescriptionInPullRequest` is called with a body carrying
   the summary block (the step the incident skipped).
3. **Routed** — the model-selection guard:
   - cloud default (no BYOK) resolves to the working default (`kimi-k2.7-code`),
     never a silent swap to a model nobody chose;
   - self-hosted resolves to exactly the **configured** model (the per-model
     matrix leg: gpt-mini stays gpt-mini, gemini-flash stays gemini-flash).
4. **Composed (first open)** — the `behaviourForExistingDescription` config:
   - `replace` → only the fresh block; any existing author description dropped;
   - `concatenate` → author description kept, fresh block appended, and a stale
     prior Kody block stripped so it never stacks (issue #1019);
   - `complement` → the existing description is injected into the model prompt so
     the summary complements rather than repeats it.
5. **Composed (new commit / push on an open PR)** — the `behaviourForNewCommits`
   config, via `mode: "commit"` cases + a stage-level gate:
   - `none` → the summary is NOT regenerated or reposted (asserted at the real
     pipeline stage, since that gate — not `generateSummaryPR` — is where the
     decision lives; a config flip here silently killing posting is the
     incident class);
   - `replace` → the prior Kody block is regenerated in place, author text kept;
   - `concatenate` → the new summary is appended INSIDE the block, accumulating
     the prior summary rather than replacing it.
   The **commit-run gate** drives `UpdateCommentsAndGenerateSummaryStage` with a
   spied `generateSummaryPR` (no model) and asserts the generate/post decision
   and the `isCommitRun` flag for every (mode × behaviour) combination.

## Run it

```bash
# Deterministic — no API key, no network. Validates routing + composition +
# posting. This is the flake-free local / harness check.
pnpm run eval:pr-summary:mock

# Live model (needs a valid key for the model). Same assertions through the real
# model — a green run means the feature works, not that the prose was lucky.
node evals/pr-summary/run.js --model=gpt-5.4-mini --gate
node evals/pr-summary/run.js --model=kimi-k2.7-code --gate
node evals/pr-summary/run.js --model=gemini-3-flash-preview --gate

# One behaviour only
node evals/pr-summary/run.js --mock --behaviour=complement
```

Flags: `--model=<tier0 id>` · `--mock` (fixed summary text, no network) ·
`--gate` (exit 1 on failure) · `--behaviour=replace|concatenate|complement` ·
`--dataset=<name>` (default `cases`).

## Exit codes (suite contract)

`0` pass · `1` gate failure (a real routing/composition/posting regression) ·
`2` infra (missing key / model-construction crash / all cases hit
network errors — "not measured", never a silent green).

## Where it runs in CI (`.github/workflows/code-review-evals.yml`)

- **PR** → `pr-summary-gate` matrix on `gpt-5.4-mini`, `kimi-k2.7-code`,
  `gemini-3-flash-preview` (three models so one degrading can't hide behind a
  healthy one), `--gate`, required via the `pr-evals-gate` rollup.
- **push → main** → part of the full tier-0 suite (`run-suite.js`).
- **harness** (`engine-gate.js --profile=harness`) → file + dataset preflight
  (no model), so a deleted fixture or a behaviour gap fails fast with no secrets.

## No calibrated floor (by design)

Unlike the recall/kody-rules evals, this gate is **binary property assertions**,
not a numeric threshold — there is no `targets.json` to drift and nothing to
flake on run-to-run variance. Add cases to `datasets/cases.json`; keep every
behaviour (`replace`/`concatenate`/`complement`) represented (the harness
preflight enforces this).

## Why not flaky

The only variable part is the model's prose, which **no assertion depends on** —
they check structure (block present, one block, author text kept/dropped, prompt
carried the existing body) and identity (which model answered), all deterministic
given the code. Transient API failures surface as exit-2 infra, not a red gate.
