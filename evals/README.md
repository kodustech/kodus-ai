# Code-review evals

What each eval answers, when it runs, how to run it, and what to do when it goes red.

Numbers and lists (floors, tier-0 models, schedules, secrets) are not copied here. Each one is linked to the file that owns it, so this page can't drift from what actually runs. Agents: the rules are in [AGENTS.md](AGENTS.md).

## When they run

| When | Question | What runs | Owner of the details |
|---|---|---|---|
| Every PR touching `libs/`, `evals/`, test fixtures or dependencies | Can the evals still drive the engine? | `evals/wiring-smoke.js`: every model-backed eval end to end against a scripted local model, plus the deterministic evals. Measures nothing. No keys, ~10s. | `.github/workflows/code-review-evals-pr.yml` |
| Nightly, only if a file finder-recall loads changed since the last green night | Did review quality get worse? | finder-recall on the `light` case set with one cheap model, gated on a calibrated floor | `.github/workflows/code-review-evals-nightly.yml`, `evals/investigation/targets.json` → `sets.light` |
| Friday, in the release train slot | Does every tier-0 model still run a review? | `evals/tier0-smoke.js`: one replayed PR per model (no judge), plus the PR-summary eval | `.github/workflows/code-review-evals-tier0.yml`, `evals/shared/tier0-models.js` |

Nightly and Friday post to Discord and write an Actions job summary; results are uploaded as artifacts. Cost: $0 per PR; ~$3.5 per measured night (measured 2026-09-16); a few dollars per Friday (one review per model).

Neither trigger is a hand-kept folder list. The wiring smoke records every repo file each eval loads (`evals/shared/trace-loaded.js`): it fails if one falls outside the PR workflow's `paths`, and it hands the nightly the exact files finder-recall depends on (`evals/shared/engine-files.js`).

## How an eval touches the engine

- **Replay.** The finder-style evals run the real engine code with a real model, but tool calls (`readFile`, `grep`, `listDir`, `findFile`) are answered from a recording of a real review (`evals/investigation/datasets`). No sandbox, no GitHub. A call the recording can't answer returns nothing; `fidelity` in the results is the share that was answered.
- **Model routing.** `--model=<id>` goes through the engine's own self-hosted route. The ids and their key env names are in `evals/shared/tier0-models.js`. `--model=eval-fake` points that route at `evals/shared/fake-llm-server.js`, a scripted OpenAI-compatible server on 127.0.0.1.
- **Judge.** `evals/investigation/recall-judge.js` decides whether a finding matches a known bug (`JUDGE_MODEL`, `JUDGE_API_KEY`, `JUDGE_BASE_URL`). Judges disagree by several points of recall, so a floor holds only under the judge recorded next to it.

## The evals

| Eval | Answers | In CI |
|---|---|---|
| [finder-recall](investigation/README.md) | Does the finder find a PR's known bugs? | nightly (gated) · PR (scripted model) |
| [kody-rules](kody-rules/README.md) | Does the Kody Rules agent flag every place a rule is broken? | PR (scripted model) |
| [anchoring](anchoring/README.md) | How many findings are lost because their lines miss the diff? | PR (scripted model) |
| [pr-summary](pr-summary/README.md) | Is the summary generated, posted, and sent to the configured model? | PR (scripted model) · Friday (every tier-0 model) |
| [review-chain](review-chain/README.md) | Is every LLM call in the review chain wired to the shared output recovery? | PR |
| [dedup](dedup/README.md) · [severity](severity/README.md) · [format](format/README.md) | Do the secondary passes keep real findings? | PR (mocked model) |
| [promotion](promotion/README.md) | On frozen evidence, does the verifier keep or drop a candidate correctly? | on demand |
| [parser](parser/README.md) | Are findings the model wrote as prose recovered? | unit spec in CI · LLM layer on demand |
| [trace-context](trace-context/README.md) | Do recorded Trace decisions help without talking the reviewer out of real bugs? | on demand |
| [structured-outputs](structured-outputs/README.md) | Does each provider get structured output only where it works? | on demand |
| [scorer](scorer/README.md) | Re-score a saved submission without re-running the model | tool |
| [secondary](secondary/README.md) | Shared datasets and model registry for dedup/severity/format | data |
| [results](results/README.md) | What past runs measured, per model and config (hand-recorded ledger) | data |

## Run locally

```bash
pnpm eval:wiring                                   # the PR check: no keys, ~10s
pnpm eval:tier0-smoke --model=gpt-5.4              # one model's Friday check (vendor key from tier0-models.js)
JUDGE_API_KEY=$OPENAI_KEY pnpm eval:nightly        # the nightly: 30 PRs, FIREWORKS_API_KEY for the model, ~30 min
```

Each eval's README has its own commands for narrower runs.

## When it goes red

- **Wiring smoke fails on your PR.** Your change broke an eval's hold on the engine: a renamed method, a moved file, a new dependency the eval fakes. The failing step prints its command and log tail. Reproduce with `pnpm eval:wiring` and fix the eval in the same PR.
- **Nightly: "PRs not measured (infra)".** A key, a quota or the network. The reason is in the message (for example `judge HTTP 401`). This is not a quality result. Fix the secret, and the next night measures again because a failed night is never a baseline.
- **Nightly: "dropped below the floor".** The message links the engine commits measured since the last green night. Re-run `pnpm eval:nightly` before and after the suspect commit. If the drop is an intended trade-off, recalibrate (below) in the PR that made it.
- **Nightly: "not gated".** Either there is no floor for that model and set, or the run used a different judge than the floor was calibrated with.
- **Friday: "could not reach X".** That vendor's key or quota is broken. **"X no longer reviews"**: the engine no longer works on that model, so customers using it are affected. Decide per model, not for the whole release.

## Changing things

- **Recalibrate a floor.** Run the set twice on the same commit, compute the paired per-PR noise, and update the floor in the same PR. The method and the last numbers are in the `__doc` of the set in `evals/investigation/targets.json`.
- **Add or drop a Friday model.** Set `tier0: true` in `evals/shared/tier0-models.js` and pass its secret in `.github/workflows/code-review-evals-tier0.yml`.
- **Add an eval.** Give it a README with the standard header (see any eval's README), add a step to `evals/wiring-smoke.js` if it drives the engine, and follow [AGENTS.md](AGENTS.md).
