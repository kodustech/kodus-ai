# parse

> - **Answers:** Of the findings a model writes at the end of a finder run, does the parse keep every one that can be posted?
> - **Runs:** nightly when the parse or its recorded runs change (`evals/nightly-evals.js`), Friday on every tier-0 model (prose recovery only), and on every PR in `evals/wiring-smoke.js` against the scripted model.
> - **Run it:** `node evals/parse/run.js --model=<id>` (the runs recorded on that model) · `--model=eval-fake` (every recorded run, scripted recovery)
> - **Gate:** `--gate` fails below the model's floor in `evals/parse/targets.json`.
> - **Cost:** one prose recovery call per case whose findings the structured parse lost; the rest replays recorded output. Recording runs again (`capture.js`) is one finder run per PR and model.

A finder run ends when the model calls `submitResult` or answers in text. The
engine turns that into findings in `extractFindingsWithRecovery`
(`libs/code-review/infrastructure/agents/core/finder.agent.ts`): the
`submitResult` input validated by `sanitizeFindingsResult` (`findings-schema.ts`),
else JSON found in the run's text, else, when nothing came out, a model call that
re-structures the prose in `reasoning` (`recoverFindingsFromProse`), on the
slot the run ended on. Then the agent's `mapFindings`
(`providers/base-code-review-agent.provider.ts`, `collaborators/finding-mapper.ts`)
drops a finding without a description or a file the PR changed. A finding lost
there never reaches dedup or verify, and production only logs it (#2112).

The eval replays recorded run ends through those functions. Each run end
becomes the run's state as the runner holds it: the AI SDK step built from the
recorded response (its `submitResult` arguments parsed by the SDK's own JSON
parser, as `parseToolCall` does), turned into a step by `eventToMessage` and
into artifacts by `materializeArtifacts`
(`libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts`). The mapper
is the generalist's, over the PR's files as the platform lists them
(`prFiles` in the dataset):

- `payloads/<model>/<case>.json`: how nine models production reviews run on
  ended their finder runs on four public PRs of `evals/investigation/datasets`
  (GLM-5.3 on one: its OpenRouter route took an hour per PR), recorded by
  `capture.js` from each provider response before the engine parsed it. Models end in text as well as in `submitResult`, write fields the schema
  does not expect, and sometimes write their findings only as prose; all of it
  is kept as it came.
- `labels.json`: the findings of each run end that carries them only as prose,
  read by hand, with the file as the prose names it.
- `shapes.js`: each shape production lost in #2112, applied to every model's
  run end with the most findings that the engine parses whole, so a shape case
  measures that shape only: findings only as prose in `reasoning`,
  `suggestions` as a JSON string (whole, broken, or followed by a stray `}`),
  plain-string or `{"$text"}` items, `improvedCode` or `existingCode` missing,
  a `null` in an optional field, a capitalized `severity`. The production counts
  are in each case's sentence.
- Two controls: a finding with no file, or no description, must be dropped.

A written finding can be posted when it has a description and its file is one
the PR changed, named in full or by a tail only one changed file has
(`client.go`). It counts as right when it comes out of the parse with its text,
or, after prose recovery rewrote it, on the same file and lines; a finding that
cannot be posted counts as right when it does not come out. A run end whose
findings list is empty, or whose prose finds nothing new, counts as right when
nothing comes out of it (#1938).

`--model` picks the runs recorded on that model, and prose recovery runs on
that model's slot, routed the way the recording reached it
(`evals/shared/model-route.js`: the managed route, or a stored BYOK config with
`RECALL_REASONING_EFFORT`): production recovers a run's prose on the slot the
run ended on. A refused call (key, quota, rate, outage) leaves the case
unmeasured; an answer that does not fit the schema loses the findings, as it
does in production. A model with no recorded runs is not measured (exit 2).

Under the scripted model (`--model=eval-fake`) every recorded run is replayed
and prose recovery returns a finding on no changed file, so the result is the
deterministic part alone.

Not production yet: `capture.js` records each run's last response only, so the
state holds that step alone and the text of earlier steps, which
`findingsFromText` would also read, is missing.

To record runs for a model again: `node evals/parse/capture.js --model=<id>`,
then `node evals/parse/build-cases.js`, which lists the run ends to label.
