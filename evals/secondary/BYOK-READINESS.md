# Secondary-pass BYOK readiness

**Goal:** route dedup / severity / format through **client BYOK** (not platform
`gpt-5.4-mini`), keeping Kodus keys only for **trial/demo**, **embeddings**, and **Exa**.

**Last live run:** 2026-07-09 · smoke set (3 PRs / 8 findings) · single run each
(not N≥4 — treat as directional, not final ship gate).

## Keep on Kodus keys

| Path | Why |
|---|---|
| Trial + public demo main model | Product-funded |
| `text-embedding-3-small` | Embeddings infra |
| Exa docs search | Not chat BYOK |

## Move to BYOK (when org has BYOK_CONFIG)

| Pass | Eval | Headline metric |
|---|---|---|
| Dedup | `evals/dedup` | `goldensLost == 0` with `guard=content@0.3` |
| Severity | `evals/severity` | `filter_false_drop@high == 0` |
| Format | `evals/format` | `ident_recall_mean ≥ 0.5`, low `parse_fail` |

## Live matrix (smoke)

| Model | Severity | Format | Dedup | Notes |
|---|---|---|---|---|
| **gpt-5.4-mini** (baseline) | ✅ drop@high=0 · acc=0.75 | ✅ auto=0.88 · idents=0.75 | ✅ lost=0 · goodDup=2 | Platform secondary today |
| **kimi-k2.7-code** | ✅ drop@high=0 · acc=0.63 | ✅ auto=1.0 · idents=0.76 | ✅ lost=0 · goodDup=1 · under=1 | structuredOutputs warn; more under-merge |
| **glm-5.2** | ✅ drop@high=0 · acc=0.75 | ✅ auto=1.0 · idents=0.88 | ✅ lost=0 · goodDup=0 · under=2 | No structuredOutputs → weak merge |
| **haiku-4.5** | ✅ drop@high=0 · acc=0.13 | ✅ auto=1.0 · idents=0.72 | ✅ lost=0 · goodDup=2 | Severity over-scores vs heuristic (false_keep=1) |
| gemini-3-flash-preview | ❌ infra | ❌ infra | ❌ infra | Google prepayment credits depleted |
| gemini-2.5-flash | ❌ infra | ❌ infra | ❌ infra | Same Google credits |

### Reading

- **Headline gates (smoke):** all models that ran live passed `false_drop@high=0` and
  `goldensLost=0` and format auto-pass.
- **Quality caveats:**
  - **glm-5.2** / **kimi**: AI SDK warns `responseFormat` unsupported → dedup under-merges
    more (spam) rather than over-merging (safer direction with content guard).
  - **haiku severity** exact_acc low vs our **heuristic** judge — not LLM-judge ground
    truth; needs real judge before trusting severity quality.
  - Smoke set is **tiny** (3 PRs). Ship decision needs full 39-PR dedup set + N≥4 runs.
- **Gemini:** blocked by billing; re-run when credits restored.

## Commands

```bash
# CI (no keys)
node evals/dedup/run.js --mock=identity --gate
node evals/severity/run.js --mock=heuristic --gate
node evals/format/run.js --mock=perfect --gate

# Live single model
node evals/severity/run.js --model=gpt-5.4-mini --gate
node evals/format/run.js --model=gpt-5.4-mini --gate
node evals/dedup/run.js --model=gpt-5.4-mini --guard=content --contentthresh=0.3 --gate

# Matrix
node evals/dedup/run-matrix.js
```

## Ship rule (PR2)

Every recommended BYOK model must either:

1. Pass headlines on the **full** dataset with N≥4, **or**
2. Be fail-soft for secondary (keep agent severity / keep-all dedup / skip format)

Never silently treat a weak model as if it were platform `gpt-5.4-mini`.

## Prod flip (PR2 — DONE 2026-07-09)

`resolveSecondaryPassModel` + dedup path:

1. If `byokConfig.main` (else fallback) → **client BYOK** (default)  
2. Else trial/demo / no BYOK → platform `gpt-5.4-mini`
