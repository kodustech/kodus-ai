# Benchmark scorer

> - **Answers:** Re-score a saved submission (new judge, new metric) without re-running the model.
> - **Runs:** on demand; a tool, not a gate.
> - **Run it:** `node evals/scorer/cli.js --submission=<file>`
> - **Gate:** none.
> - **Cost:** judge calls only.

Scores a **submission** against the dataset's golden comments and emits a **scorecard**.

Separates **scoring** from **running**. `run-recall.js` used to do both in one pass
and discard the model's findings. Consequences: changing the judge meant re-running
every model (one pass costs US$ 15–80 per model; the judge costs cents), the site had
no data for the trace pages, and no third party could take part.

```
harness (expensive, runs once)  →  submission.json  →  scorer (cheap, runs always)  →  scorecard.json  →  site
```

## Usage

```bash
node evals/scorer/cli.js --submission=sub.json                    # score it
node evals/scorer/cli.js --submission=sub.json --validate         # schema only
node evals/scorer/cli.js --submission=sub.json --judge=gpt-5.4-mini
```

Judge: `--judge=<model>` or `JUDGE_MODEL` (default `claude-haiku-4-5`). The key is resolved
by `evals/investigation/recall-judge.js`: `JUDGE_API_KEY` wins outright when set, otherwise
the model prefix picks the provider and only that provider's env names are read — so with
`JUDGE_API_KEY` unset, `--judge=gpt-5.4-mini` needs an OpenAI key, not an Anthropic one.
Misses fall back to the repo's `.env.local`/`.env` and then `~/.kodus-dev/config`.
`sk-ant-api…` and `sk-ant-oat…` are the Anthropic forms; `ant auth login` does not supply
the key, `ant` is only called to refresh a token that expires mid-run.

## Submission format

What a participant delivers. An empty `results[].findings` is valid and meaningful
("I found nothing in this PR") — it is not the same as not submitting the case.

```json
{
  "benchmarkVersion": "light-v1",
  "run": {
    "harness":  { "name": "kodus", "version": "1.4.2", "commit": "abc123" },
    "model":    { "id": "gpt-5.6-luna", "provider": "openai", "accessPath": "api" },
    "executionMode": "replay",
    "runAt": "2026-08-04T14:00:00Z"
  },
  "results": [
    {
      "caseId": "add-guest-management-functionality-to-existing-bookings-cal-com",
      "findings": [
        {
          "path": "packages/features/bookings/lib/handleNewBooking.ts",
          "startLine": 412,
          "endLine": 418,
          "severity": "high",
          "category": "bug",
          "description": "Case-sensitive email comparison lets you bypass the blacklist."
        }
      ],
      "usage": { "inputTokens": 512340, "outputTokens": 8210 },
      "latencyMs": 48120,
      "trace": { "replayCalls": 46, "unexpectedToolCalls": [] }
    }
  ]
}
```

`benchmarkVersion` is `<set>-v1` for the set you ran: `pr-v1` (default, no `--set`),
`smoke-v1` for `--set=smoke`, `light-v1` for `--set=light`, `all50-v1` for `--all`,
`custom-v1` for an explicit `--cases` list. The value is whatever `--set` says, so a
misspelled set name is stamped into the artifact rather than rejected. The scorer does not
check it against a registry either — declare it honestly, because a mislabelled version is
how two incomparable runs end up compared.

### `run` fields

| field | required | note |
|---|---|---|
| `harness.name` | yes | `kodus`, `claude-code`, `codex`, `greptile`… The harness is a first-class dimension: the same model under different engines is a different entry. |
| `model` | no | `null` when the harness does not let you pick a model (closed product). |
| `model.id` | if `model` is an object | a string, or the submission is rejected. |
| `model.accessPath` | no | `api` \| `subscription` \| `local` \| `unknown`. Different billing and rate-limit regimes are not comparable on latency — declare it. |
| `executionMode` | yes | `replay` (recorded tool outputs, deterministic) or `live` (ran against the real repo). **Only compare within the same mode.** |
| `reasoning` | no | `{config, effortRequested}`. `config` ∈ `vendor-default` \| `explicit` \| `disabled`. `effortRequested` is required when `config` is `explicit` — otherwise `explicit` says nothing. See below — it is a real confounder. |
| `runAt` | yes | ISO-8601. |

### Reasoning is a confounder, not a detail

The harness does not force an effort level, so each vendor applies its own default —
and they diverge sharply. Measured on the light 30: `deepseek-v4-flash` produced **49k
output tokens per case** and `gpt-5.6-luna` **5.9k** — 8x, both "on the default".

That means a ranking without this field bakes in vendor calibration as if it were
model quality. Two positions are defensible, and they are different benchmarks:

- **`vendor-default`** — what a team gets when they plug the model in. More useful for
  a purchase decision, and the default here.
- **`explicit`** — effort fixed across models, which isolates capability. But not every
  vendor exposes the same control, so parity is partial by construction.

Whichever you pick, **declare it**. Comparing entries with a different `config` without
labelling them is the same error as comparing `replay` against `live`.

### `findings[]` fields

`description` is the only required field. It, plus `path` and `category`, form the text
the judge compares against the golden (`evals/scorer/score.js`); `startLine`, `endLine`
and `severity` are collected and enrich the site, but do not enter the matching.
`severity` is one of `critical`, `high`, `medium`, `low`, `info`, or `null`; the validator
accumulates every error, so an unrecognised value fails the whole submission.

## Scorecard format

Carries the whole `run` block from the submission (provenance) plus the judge used, and:

| metric | what it is |
|---|---|
| `recallMicro` | goldens covered / total goldens. **The number for ranking** — weights by bug, not by PR. |
| `recallMacro` | mean of the per-case recalls. Comparable with the `finder-recall` history. |
| `precisionMacro` | of the findings emitted, how many hit a golden. |
| `f1Macro`, `fairRecallMacro` | same as `evals/investigation/recall-assertion.js`. |
| `loopFidelityMacro` | only in `replay` with a `trace`; `null` when not measured. |

## Execution modes

`replay` serves recorded tool outputs: deterministic, cheap, comparable — but it favours
a harness that does not explore beyond what was recorded (which is what `loopFidelity`
measures). `live` runs against the real repo at a pinned SHA: realistic, but every run
sees something different. Closed products (Greptile, CodeRabbit) can only do `live`.

That is why the mode is a **field, not a decision**, and rankings are segmented by it.

## Third-party submission

The benchmark site links to this file, so this section is the whole contribution path.
Three parts of it are not guessable from the schema above.

**Get the cases.** The datasets are not in the benchmark repo: they are versioned here,
one JSON file per case under `evals/investigation/datasets/`, carrying the `toolReplay`
and `goldenComments` the scorer reads. That directory also holds `smoke` and
`trace-context` fixtures for other evals, which carry no goldens. Clone this repository;
there is no separate download.

**Run the set the leaderboard is built from.** The comparable set is the 30-case `light`
set — `node evals/investigation/run-recall.js --set=light`. The default is `pr` (8 cases),
so omitting `--set` scores a different set and the result is not comparable, and an
unrecognised set name falls back to `pr` silently.

That runner is the Kodus reference run: it stamps `harness.name` as `kodus` and
`executionMode` as `replay`, and it rejects any model outside Kodus's own tier-0 list.
Another harness has to write the same file itself, declaring its own `run.harness` and
`run.executionMode`; the schema above is the whole contract.

The case list is owned by `evals/investigation/recall-tests.js` (`LIGHT_CASES`) and is not
copied here so it cannot drift. Recall divides by the goldens actually measured, so
scoring a different subset is quietly flattered rather than penalised: some published
entries cover 29 cases instead of 30. A Kodus run writes
`evals/investigation/results/finder-recall-<model>.submission.json`.

**Open the PR against `kodustech/codereviewbench`, not this repository.** Drop the
submission in `submissions/` and the scorecard in `scorecards/` — the scorer writes
`evals/investigation/results/scorecard-<harness>-<model>.json` unless `--out` says
otherwise. Then regenerate the site data there with `node process-scorecards.js`.

The reviewer checks that the `caseId`s exist, that `benchmarkVersion` matches, and that
`executionMode` is consistent with the declared harness. There is no CI on this path:
`--validate` and the scorer are run by hand, so a stale or non-comparable submission is
caught by a person reading the diff, not by a red check. `harness.commit` is in the
example because a commit makes a run reproducible, but the schema does not require it
and most published entries carry only a `version`.

## Known limitations

- **Goldens are public** (they come from `withmartian/code-review-benchmark`). A
  participant can optimise against the answer key. A rotating test set would fix it;
  `evals/kody-rules/harvest-github-cases.js` already harvests fresh PRs from GitHub.
- **The judge is an LLM and has family bias.** A judge from the same family as a
  competitor being evaluated is a conflict — use a cross-vendor panel and publish the
  agreement (`evals/investigation/agreement/`). Because the scorer is separate,
  re-scoring with another judge costs cents.
- **Matching is by text**, not by line. A correct finding described vaguely may not
  match; `startLine`/`endLine`/`severity` are collected but still unused.
