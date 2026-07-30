# Eval judge agreement study (issue #1447)

The finder-recall and dedup evals score model output with an LLM **judge** — for
each `(golden, candidate-finding)` pair it decides *match / no-match*. That judge
was `claude-sonnet-4-6`, which is expensive and slow and runs on every pair, every
model, every PR, so it dominates eval cost.

This directory swaps the judge for a cheaper/faster model **without degrading eval
quality**, by measuring how well a candidate judge agrees with the incumbent Sonnet
judge on a fixed, real set of pairs.

## Files

- `build-pairs.js` — runs the live finder (tool replay) across the finder-recall
  case set and emits every `(golden, candidate)` pair → `pairs.json` (committed).
  Needs finder keys only, no judge key.
- `run-agreement.js` — labels every pair with the reference judge (Sonnet) and each
  candidate judge, then reports accuracy / precision / recall / F1 / Cohen's kappa
  of the candidate's match decision **vs Sonnet** (ground truth), plus latency and a
  disagreement dump. Labels are cached per model in `labels.<model>.json`.
- `pairs.json` — the labeled agreement set (fixed artifact).
- `agreement-report.json` — latest study output (metrics + disagreements).

## Reproduce

```bash
cd evals/investigation/agreement
# 1. build the pair set (finder keys: OpenAI + Anthropic in ~/.kodus-dev/config)
node build-pairs.js --set=pr --models=gpt-5.4,claude-sonnet-4-6
# 2. run the study (judge keys resolved per candidate provider)
node run-agreement.js --candidates=gpt-5.4-mini,claude-haiku-4-5,gemini-3-flash-preview
```

The multi-provider judge is `../recall-judge.js`; set `JUDGE_MODEL` to switch the
judge the evals actually use (default `claude-sonnet-4-6`).

## Results

254 real pairs (finders: gpt-5.4 + claude-sonnet-4-6, `--set=pr`, 8 PRs). Ground
truth = the incumbent Sonnet judge's label; metrics are the candidate's agreement
with it on the **match** class. Reference (Sonnet) match-rate **9.1%** (23/254),
mean latency **3188 ms**.

| candidate | agreement (acc) | κ | precision | recall | F1 | mean latency | notes |
|-----------|-----------------|------|-----------|--------|------|--------------|-------|
| **claude-haiku-4-5** | **98.8%** | **0.93** | 91.7% | 95.7% | 0.94 | 1992 ms | **promoted** · highest agreement |
| gpt-5.4-mini | 98.0% | 0.89 | 84.6% | 95.7% | 0.90 | 1385 ms | cheapest+fastest; one env-var away |
| gemini-3-flash-preview | — | — | — | — | — | — | key denied (403), not scored |

Both κ land in "almost-perfect agreement" (>0.8). Each recalls 95.7% of Sonnet's
matches (misses 1/23). Disagreements (`agreement-report.json`) are all borderline
semantic-boundary calls on the same device-limit PR — not systematic errors.

### Downstream mean (acceptance criterion 2)

Reconstructing per-PR finder-recall from the same pairs under each judge:

| judge | per-PR recall mean | Δ vs Sonnet |
|-------|--------------------|-------------|
| claude-sonnet-4-6 (ref) | 19.8% | — |
| gpt-5.4-mini | 20.7% | **+0.9 pp** |
| claude-haiku-4-5 | 19.5% | −0.3 pp |

Cross-PR SEM ≈ 5–6 pp, so both shifts sit far inside noise → `targets.json` floors
stay valid unchanged (no re-baseline needed; the ratchet rule refreshes them under
the new judge on the next intentional model-move anyway).

### Decision

**Promoted `claude-haiku-4-5`** as the default `JUDGE_MODEL` (`../recall-judge.js`):
κ=0.93 vs Sonnet (highest agreement of the candidates), downstream recall shift
−0.3 pp (≪ noise), **~1.6× faster** (1992 vs 3188 ms) and a fraction of Sonnet's
cost on every pair, every model, every PR. `gpt-5.4-mini` is the cheapest+fastest
alternative (κ=0.89, 1385 ms) one env-var away: `JUDGE_MODEL=gpt-5.4-mini`.

The **dedup** eval pins its judge to `claude-haiku-4-5` (in `evals/dedup/run.js`)
and forces off `gpt-5.4-mini`, so the judge always stays a different model than its
`gpt-5.4-mini` dedup (non-circular).

`kody-targets.json` is **not** affected: the kody-rules gate matches occurrences by
line number (enumerated ground truth ±tolerance), not via this LLM judge.

### Gemini status

The only available Google key (`BYOK_GOOGLE_API_KEY`) returns
`403 PERMISSION_DENIED "Your project has been denied access"` for all Gemini models,
so `gemini-3-flash-preview` could not be scored. The harness fully supports it — a
working Google key drops straight in via `--candidates=gemini-3-flash-preview`.
