# DeepSeek V4 Flash vs Kimi K2.7 Code — finder-recall benchmark

**Date:** 2026-07-31 · **Harness:** `evals/investigation` (finder agent under deterministic
tool replay) · **Corpus:** all 50 per-PR cases / 136 goldens.

DeepSeek released **V4-Flash** into public API beta on 2026-07-31 (same architecture as
the preview, re-post-trained only). This run answers whether it is good enough to offer in
production, using Kimi K2.7 Code — the model already in the catalog — as the reference.

## Results

| Metric | DeepSeek V4 Flash | Kimi K2.7 Code |
|---|---|---|
| Recall (micro) | **44.9%** (61/136) | 35.3% (48/136) |
| Precision (micro) | 41.7% | **46.1%** |
| F1 (micro) | **0.432** | 0.400 |
| Recall (macro) | **45.8%** | 36.8% |
| Precision (macro) | 45.6% | **47.0%** |
| F1 (macro) | **0.423** | 0.380 |
| Fair-recall | **51.6%** | 41.6% |
| Loop-fidelity | 81.3% | **86.5%** |
| Findings emitted | 168 | 165 |

**Per-case outcome: DeepSeek wins 12, loses 3, ties 35.** A two-sided sign test over the 15
decided cases gives **p ≈ 0.035**.

DeepSeek finds 13 more real bugs while emitting essentially the same number of findings
(168 vs 165) — it is not simply talking more, it aims better. The trade is ~4pp of precision.

## Cost

List price: DeepSeek $0.14/$0.28 per 1M; Kimi K2.7 Code $0.95/$4.00 per 1M.

| Metric | DeepSeek V4 Flash | Kimi K2.7 Code |
|---|---|---|
| Cost per PR (cache miss) | **$0.110** | $0.545 |
| Cost per PR (80% cache hit) | **$0.037** | $0.246 |
| **Cost per bug found** | **$0.090** | $0.568 |
| Total, 50 PRs | **$5.49** | $27.24 |
| Mean latency | 8.3 min/PR | 6.6 min/PR |

Costs are an **upper bound**: the provider's `tokenUsage` does not expose cached-prompt
tokens, so all input is priced at the cache-miss rate. DeepSeek bills cache hits at
$0.0028/1M (50× less) and an agent loop repeats most of its prefix across steps.

These figures cover the **finder agent only** — not the full production pipeline
(verify/critic, kody rules, summary, cross-file context). Absolute cost per PR in
production is a multiple of this; the ratio should hold, since every stage runs on the
same BYOK model.

## Caveats

1. **The judge was a human-in-the-loop LLM rater (Claude Opus 5 in a Claude Code session),
   not the automated judge.** The Anthropic API key in `.env` and `~/.kodus-dev/config` was
   invalid (HTTP 401) on the day of the run, so `recall-judge.js` could not run. The same
   `JUDGE_PROMPT` was applied by hand and fed back into the repo's own
   `recall-assertion.js` (only `matchComment` was swapped), so recall/precision/F1/
   fair-recall/loop-fidelity come from the standard formula. Both models were judged by the
   same rater in the same session, so **the head-to-head is comparable; absolute values are
   not directly comparable to artifacts scored by the automated judge.**
2. **One run per model per case.** An earlier 8-case round re-run at 20 cases moved the same
   model by up to ~9pp on the same case — run-to-run variance is comparable in size to the
   measured gap. The sign test shows the advantage is systematic *across cases*; it does not
   rule out one lucky run. Repeating the corpus 2–3× per model is the missing step, and is
   cheap once the automated judge works again.
3. **Two datasets carry the wrong goldens.**
   `optimize-spans-buffer-insertion-with-eviction-during-insert-sentry` and
   `replays-self-serve-bulk-delete-system-sentry` are scored against goldens belonging to
   other PRs (the `OptimizedCursorPaginator` ones). Both models score 0 there through no
   fault of their own; ~6 goldens deflate both denominators equally. Worth fixing before
   these numbers are used as a baseline.

## Recommendation

Ship DeepSeek V4 Flash as a **catalog option**: consistently better recall than Kimi at the
same class of precision, for ~1/5 of the cost per PR. Promoting it to the production
default should wait for the repeat runs described in caveat 2.

## Reproducing

```bash
cd evals/investigation
export BYOK_DEEPSEEK_API_KEY=...   # see below — NOT read from ~/.kodus-dev/config
env -u ANTHROPIC_API_KEY -u BYOK_ANTHROPIC_API_KEY \
  PROMPTFOO_DISABLE_TEMPLATING=1 RECALL_ALL=1 \
  promptfoo eval -c promptfoo-recall-deepseek.yaml --no-cache
```

`BYOK_DEEPSEEK_API_KEY` must be **exported in the shell or present in `.env.local` / `.env`**.
The finder reads its key from the environment: `agent-provider.js` dotenv-loads only
`.env` and `.env.local` and then reads `process.env[apiKeyEnv]`, so a key that lives only
in `~/.kodus-dev/config` fails immediately with
`Missing API key for openai-compatible in BYOK_DEEPSEEK_API_KEY`. That file is consulted
only by the judge path (`recall-judge.js`), for the Anthropic key.

Note that `resolveKeyEnv` in
`tests/e2e/benchmark/models.ts` does not yet map `api.deepseek.com` — that mapping, the
context-window override, and the BYOK catalog entry are intentionally **not** part of this
PR (see below).

## Artifacts

`evals/investigation/benchmarks/`:

- `finder-recall-<model>-all50.json` — per-case metrics, macro + micro aggregates, cost
- `finder-recall-<model>-all50.verdicts.json` — the rater's pairwise (golden × finding)
  verdicts, so every call can be audited

Stored here rather than the canonical `evals/investigation/results/`, which is gitignored
by design (`results/*`) — that is why no previous finder-recall run is versioned.

Raw agent outputs (~2MB) were not committed.

## Not in this PR

- BYOK catalog entry for `deepseek-v4-flash` (`tier: "recommended"` would expose the model
  to customers — a product decision)
- `resolveKeyEnv` mapping for `api.deepseek.com` and the 1M context-window override
- A fix for `tests/e2e/benchmark/run.ts`: since 3b9b26609 the web app's `/api/proxy/api`
  derives the bearer from the NextAuth cookie and **deletes** a client-sent
  `Authorization` header, so every non-browser client 401s on authenticated routes. The
  cloud benchmark/e2e path has been broken since 2026-07-03. Deserves its own PR.
