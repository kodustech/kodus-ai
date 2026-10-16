# format

> - **Answers:** Does the formatter turn each finding into prose the reader can act on — no WHAT/WHY/HOW labels, its code names kept, in the team's language and length?
> - **Runs:** nightly when the formatter or its cases change (`evals/nightly-evals.js`), Friday on every tier-0 model, and on every PR in `evals/wiring-smoke.js` against the scripted model.
> - **Run it:** `node evals/format/run.js --model=<id>`
> - **Gate:** `--gate` fails below the model's floor in `evals/format/targets.json`.
> - **Cost:** one formatter call per case (155), the batch of one review each.

The review stage hands the findings of a review to `formatSuggestionContent`
(`libs/code-review/infrastructure/agents/engine/format-suggestion-content.ts`),
which rewrites the finder's WHAT/WHY/HOW text into the comment a developer
reads, and falls back to stripping the labels locally when the model call
fails. The eval calls it as the stage does (`agent-review.stage.ts`) and scores
what ships: the formatted text, or the finder's own when nothing came back.

- `batches.json`: the findings of 31 reviews, as nine models wrote them on public
  PRs (the run ends recorded for `evals/parse`, the one with the most findings
  per model and PR). `node evals/format/build-cases.js` rebuilds it.
- `variants.js`: the configurations production runs it under, from the teams'
  `language_config` (en-US, pt-BR, zh-CN, es-ES cover nearly every team that
  sets one) and a team writing guideline, the kind of real edit teams make.
- `checks.js`: what a shipped comment owes the reader, each a rule of the
  formatter prompt (`format-prompt.ts`) or of the configuration — no labels, at
  least half the cited code names still in the text or the title above it, no
  code block, the title not repeated, the sentence limit, the language.

A finding counts as right when it passes every check. The checks read the text;
none judges whether the claim is still the same one.

Under the scripted model (`--model=eval-fake`) the call returns nothing usable
and the local fallback ships. It only removes the labels, so there it is scored
on the labels, the code names and the code block, not on length or language.
