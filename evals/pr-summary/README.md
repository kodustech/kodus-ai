# PR-summary contract test

> - **Answers:** Is the PR summary generated, posted, sent to the configured model, composed as the team configured, and about what the diff does?
> - **Runs:** as a test (`evals/stages.js`): on every PR in `evals/wiring-smoke.js` against the scripted model, and weekly on every tier-0 model, gated (`evals/weekly.js --tests`). Not an eval yet: whether a summary is a good one is not measured.
> - **Run it:** `node evals/pr-summary/run.js --model=<id>`
> - **Gate:** `--gate` fails below the model's floor in `evals/pr-summary/targets.json`; a model with none is gated on the contract alone, where any failed check fails it.
> - **Cost:** one model call per case that asks for a summary; none mocked.

Guards the **"generate PR summary on open"** feature — the AI description Kody
writes to a PR when a client opens it.

## Why this exists

A prod incident: the summary path silently routed to a model nobody configured
(a Gemini default with no BYOK / no key), every client lost their PR summary, and
**no eval caught it**. The review agents kept working — they resolve BYOK
themselves — so the model matrix stayed green while summaries were dead.

This eval closes that gap. Each case runs production's summary step itself:
`UpdateCommentsAndGenerateSummaryStage` with the real `CommentManagerService`,
on a pipeline context carrying the case's PR, its review's comments
(`lineComments`, `prLevelCommentResults`, which production always passes) and
the team's summary config. The model is the org's, routed by production's
`PermissionValidationService` (`resolveTaskSlot` for `prSummary`) over the
case's stored BYOK config, or the org's route for the run's model
(`evals/shared/model-route.js`). The only
stand-ins are the code host: the PR body it returns, the description it
receives (recorded after the GitHub adapter's own `fitPRDescription`), and the
full PR diff a commit run fetches (the case's files).

## What it asserts (per case, word-independent so a live model can't flake it)

1. **Generated** — a non-empty summary comes back.
2. **Posted** — `updateDescriptionInPullRequest` is called with a body carrying
   the summary block (the step the incident skipped).
3. **Routed** — read off the call the summary makes: it goes to the model the
   org's routing picks (with no stored config, the configured env model; with
   one, the model it routes `prSummary` to, as the `prSummary` task), never a
   silent swap to one nobody chose. `routing-prsummary-override` stores a config
   whose default model is not the summary's: routing `prSummary` to
   `codeReview` on purpose fails it.
4. **Findings in the prompt** — the review's delivered findings are listed in
   the summary prompt, or the review is reported as having found nothing.
5. **Composed (first open)** — the `behaviourForExistingDescription` config:
   - `replace` → only the fresh block; any existing author description dropped;
   - `concatenate` → author description kept, fresh block appended, and a stale
     prior Kody block stripped so it never stacks (issue #1019);
   - `complement` → the existing description is injected into the model prompt so
     the summary complements rather than repeats it.
6. **Composed (new commit / push on an open PR)** — the `behaviourForNewCommits`
   config, via `mode: "commit"` cases:
   - `none`, or the summary turned off → no model call and nothing posted
     (`commit-none`, `commit-summary-off`, `open-summary-off`);
   - `replace` → the prior Kody block is regenerated in place, author text kept;
   - `concatenate` → the new summary is appended INSIDE the block, accumulating
     the prior summary rather than replacing it.
7. **About the diff** (real models only) — the summary uses at least one word
   only the diff holds: parts of the changed files' and code names that the
   title and the existing description do not carry, minus words any summary
   uses ("update", "user"). It runs only where the diff has three such words:
   with one, a good summary can miss it. Three cases have a title that says
   nothing (`fix`, `wip`, `address review comments`), so their summary can only
   come from the diff. With the diff removed from the prompt, DeepSeek failed
   this on 4 of the 10 cases it runs on, those three among them.

## Run it

```bash
# A real model (needs its key). Without a key, `pnpm eval:wiring` runs it
# against the scripted local model.
node evals/pr-summary/run.js --model=deepseek-v4-flash@fireworks --gate
node evals/pr-summary/run.js --model=kimi-k2.7-code@openrouter --gate --behaviour=complement
```

Flags: `--model=<tier0 id>` · `--gate` (exit 1 below the floor) ·
`--behaviour=replace|concatenate|complement|none` · `--dataset=<name>`
(default `cases`) · `--limit=N` · `--output=<file>`.

## Exit codes (suite contract)

`0` pass · `1` gate failure (a real routing/composition/posting regression) ·
`2` infra (missing key / model-construction crash / all cases hit
network errors — "not measured", never a silent green).

## Where it runs in CI

- **PR** → `code-review-evals-pr.yml` runs it against the scripted local model
  (`evals/wiring-smoke.js`): the real stage, routing and posting, no key, so a
  harness break fails the PR that caused it.
- **Weekly** → `code-review-evals-weekly.yml` runs it on every tier-0 model with
  the release train (`evals/weekly.js --tests`), so one model degrading can't hide
  behind a healthy one.

## Floors

Most checks are **binary property assertions** on the contract — routing,
posting, composition — that hold or do not, whatever the model writes. The
diff check (item 6) reads the model's prose, so a model is gated on it only
with a floor of its own in `targets.json`, calibrated from runs (the nightly
model). A model with none (another tier-0 model in the weekly run) is gated on the
contract alone, where any failed check fails it; its diff check is reported,
not gated. Add cases to `datasets/cases.json`; keep every behaviour
(`replace`/`concatenate`/`complement`) represented (the harness preflight
enforces this).

## Why not flaky

The only variable part is the model's prose, which **no assertion depends on** —
they check structure (block present, one block, author text kept/dropped, prompt
carried the existing body) and identity (which model answered), all deterministic
given the code. Transient API failures surface as exit-2 infra, not a red gate.
