# Suggestion sanitizer eval

> - **Answers:** Does the sanitizer discard exactly the finder suggestions that report no problem, and nothing else?
> - **Runs:** on demand, while the sanitizer step is being built (#1821). Not in CI.
> - **Run it:** `RECALL_MODEL=<tier0 id> node evals/suggestion-sanitizer/run.js --model=<gold model> --versao=<label>`
> - **Gate:** exact match per model: every suggestion in `dataset/<model>.json` discarded, no other suggestion discarded (exit 1 otherwise, 2 when a PR was not measured).
> - **Cost:** one model call per PR (30 per model).

The input is the frozen finder output of the dedup gold (`evals/dedup/gold-v2/09.10.26_<model>.json`). The prompt is `libs/code-review/infrastructure/agents/engine/suggestion-sanitizer-prompt.ts`; the runner calls it through `LLM.run`, the same entry point as the review pipeline.

`dataset/<model>.json` lists, per PR, the ids of the suggestions that report no problem (`semProblema`). Models whose finder writes none have an empty list in every PR, so any discard there is a failure. Results land in `results/<label>/<model>.json` with `aMais` (discarded but expected to stay) and `aMenos` (expected to be discarded but kept).
