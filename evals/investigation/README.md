# Investigation Evals

Promptfoo harness for prompt and tool-use evals against the current review engine.

Goals:
- use the same prompt assembly as the active `generalist` review agent
- use the same agent loop semantics, not a simplified text-only prompt
- replay deterministic tool outputs so evals stay stable across runs
- evaluate investigation behavior separately from final PR posting and summary generation
- keep the current suite planner-only by default; finding correctness belongs in a separate promotion suite

What is here now:
- `agent-provider.js`: promptfoo provider that builds the live `generalist` review prompt from code and runs the current agent loop
- `prompt-loader.js`: passes the full case payload into the provider
- `parse-output.js`: shared parser for assertions
- `trace-shape-assertion.js`: verifies the provider returned a real trace payload
- `tool-expectation-assertion.js`: verifies required and forbidden tools for a case
- `promptfoo.yaml`: smoke suite config
- `datasets/smoke.json`: minimal smoke case using replayed `readFile` and `listDir`

What belongs here next:
- `datasets/`: real cases derived from benchmark traces
- `fixtures/`: replayed `readFile`, `grep`, `checkTypes`, and later `searchDocs` outputs
- `results/`: promptfoo outputs

Recommended phases:
1. `planner`
   Measure whether the agent requests the right next file, symbol, or query.
2. `promotion`
   Measure whether the agent promotes or suppresses a candidate finding correctly once evidence is present.
3. `searchDocs`
   Add this later as a separate dimension. Keep the first pass local-only so tool behavior is reproducible.

Rules for this eval:
- do not copy prompts into static files
- do not use `prompt_codereview_*_gemini_v2`
- do not mock made-up tool content
- prefer replaying real tool outputs captured from benchmark runs
- current default mode is `planner`
- in `planner` mode, the assertion ignores finding labels/counts/files and validates only investigation behavior
- use an explicit future `mode: "promotion"` or `mode: "hybrid"` case when you want to score findings

Suggested case shape:

```json
{
  "caseId": "sentry-pagination-regression",
  "mode": "planner",
  "reviewInput": {
    "title": "Enhanced Pagination Performance for Audit Logs and Issues Search",
    "description": "...",
    "changedFiles": ["src/sentry/api/paginator.py"],
    "diff": "..."
  },
  "toolReplay": [
    {
      "tool": "grep",
      "match": {
        "pattern": "get_item_key",
        "path": "src/sentry/api"
      },
      "result": "..."
    },
    {
      "tool": "readFile",
      "match": {
        "path": "src/sentry/api/paginator.py",
        "startLine": 150,
        "endLine": 210
      },
      "result": "..."
    }
  ],
  "expected": {
    "sufficient": false,
    "requiredQueries": ["get_item_key", "cursor"],
    "forbiddenQueries": ["searchDocs"]
  }
}
```

Smoke run:

```bash
yarn eval:investigation
```

List available datasets:

```bash
yarn eval:investigation --list-datasets
```

List available model presets:

```bash
yarn eval:investigation --list-presets
```

Run a specific dataset:

```bash
yarn eval:investigation:no-cache --dataset authzservice-improve-authz-caching-grafana-codex.json
```

Run a specific dataset with a preset model:

```bash
yarn eval:investigation:no-cache \
  --dataset authzservice-improve-authz-caching-grafana-codex.json \
  --preset gpt-5.4
```

Run every dataset in `datasets/`:

```bash
yarn eval:investigation:all:no-cache
```

Run every dataset against multiple preset models in one shot:

```bash
yarn eval:investigation:all:no-cache \
  --preset gemini-3.1-pro \
  --preset gpt-5.4 \
  --preset kimi-k2.5
```

Run Kimi directly against Moonshot's OpenAI-compatible API:

```bash
yarn eval:investigation:all:no-cache \
  --preset kimi-k2.5-moonshot
```

Run Kimi through OpenRouter but force the Moonshot provider endpoint:

```bash
yarn eval:investigation:all:no-cache \
  --preset kimi-k2.5-openrouter-moonshot
```

Run with a custom provider/model without editing `promptfoo.yaml`:

```bash
yarn eval:investigation:no-cache \
  --dataset smoke.json \
  --provider openai \
  --model gpt-5.4 \
  --label gpt-5.4-custom
```

Supported custom flags:
- `--preset <name>`: use a known model preset, can be repeated
- `--provider <google|anthropic|openai|openai-compatible|openrouter>`: custom provider
- `--model <id>`: custom model id
- `--label <name>`: display label for the provider row
- `--api-key-env <ENV_VAR>`: custom API key env var
- `--base-url <url>`: custom base URL, mainly for OpenAI-compatible providers
- `--header key=value`: attach a custom request header, can be repeated
- `--query-param key=value`: attach a custom query param, can be repeated
- `--provider-order <slug>`: for OpenRouter, set `provider.order`, can be repeated
- `--no-provider-fallbacks`: for OpenRouter, set `provider.allow_fallbacks=false`
- `--allow-provider-fallbacks`: for OpenRouter, set `provider.allow_fallbacks=true`
- `--require-provider-parameters`: for OpenRouter, set `provider.require_parameters=true`

Rules:
- use either repeated `--preset` flags or a single custom `--provider` + `--model`
- do not mix presets with custom provider overrides in the same command

Examples with custom routing:

```bash
yarn eval:investigation:all:no-cache \
  --provider openai-compatible \
  --model kimi-k2.5 \
  --api-key-env API_MOONSHOT_API_KEY \
  --base-url https://api.moonshot.ai/v1 \
  --label kimi-k2.5-moonshot
```

```bash
yarn eval:investigation:all:no-cache \
  --provider openrouter \
  --model moonshotai/kimi-k2.5 \
  --provider-order moonshot \
  --no-provider-fallbacks \
  --label kimi-k2.5-openrouter-moonshot
```

Debug artifacts from the latest run:
- `results/last-output.json`: raw provider output used by the assertion
- `results/last-assertion.json`: exact pass/fail reason plus tool/file/finding details
- `results/last-error.json`: provider crash details when the harness errors before assertion

Important:
- when you run multiple providers in one eval, the `last-*` files are only for the most recently finished provider/case combination
- for precise debugging, rerun the failing provider on a single dataset

This first version intentionally keeps `searchDocs` off and does not expose `exec`, so `checkTypes` is not available in the replay harness yet. That keeps the suite deterministic while we validate the current prompt + loop path.

Extract a real benchmark case skeleton:

```bash
node evals/investigation/extract-benchmark-case.js \
  --title "AuthZService: improve authz caching"
```

If the heuristic picks the wrong files, force them:

```bash
node evals/investigation/extract-benchmark-case.js \
  --title "Replays Self-Serve Bulk Delete System" \
  --include-files "src/sentry/replays/usecases/delete.py,src/sentry/workflow_engine/endpoints/validators/base/detector.py"
```

What the extractor gives you:
- benchmark PR metadata from `scripts/benchmark/prs-benchmark.json`
- real changed-file patches converted to `patchWithLinesStr`
- `readFile` replay fixtures for the changed files at the PR head/commit SHA
- a basic `listDir` replay fixture
- golden comments attached for manual expectation tuning

What you still need to refine by hand:
- `grep` replay fixtures
- the exact `expected*` assertions for the case
- any extra non-diff files you want the agent to inspect

Recommended workflow for a new real case:
1. extract the benchmark seed with `eval:investigation:extract`
2. prune the changed-file set to the files that matter for the investigation
3. add `grep` fixtures for the symbols you expect the agent to chase
4. tighten `expected*` fields until the case fails for the right reason
5. run `yarn eval:investigation:no-cache --dataset <case>.json`
6. inspect `results/last-output.json` and `results/last-assertion.json`

Select benchmark failures that are strong candidates for new planner cases:

```bash
yarn eval:investigation:candidates
```

Compare specific runs and write the shortlist to JSON:

```bash
yarn eval:investigation:candidates \
  --run gpt54-final-r01:severity \
  --run gemini31pro-planner:issue-critical \
  --run kimi25-moonshot:issue-critical \
  --top 15 \
  --output evals/investigation/results/benchmark-case-candidates.json
```

Extract the whole shortlist into dataset seeds:

```bash
yarn eval:investigation:extract:candidates --top 10
```

Preview what will be extracted without hitting GitHub:

```bash
yarn eval:investigation:extract:candidates --top 10 --dry-run
```

Overwrite existing extracted seeds:

```bash
yarn eval:investigation:extract:candidates --top 10 --overwrite
```

Heuristics used by the selector:
- `missed-all`: the run missed every golden issue for that PR
- `no-candidate`: the run generated zero candidates
- `partial-recall`: the run found some issues but still missed others
- `disagreement`: some selected runs found issues while others missed them
- `noise`: the run generated more false positives than true positives

Use the shortlist to prioritize:
1. `missed-all` + `no-candidate` cases for under-investigation
2. `disagreement` cases where one model succeeds and another fails
3. `partial-recall` cases to force deeper caller/callee expansion
