# Verifier-verdict delivery eval

Issue #1937: the verifier wrote `{"keep": false}` in its final text instead of
calling `submitVerdict`. Only the tool payload was read, so the refutation was
discarded and the finding published with rationale
`no parseable verdict — kept by default`.

This eval answers one question: **was a verdict the model gave us thrown away?**
It does not measure review quality — whether dropping these refutations moves
precision/recall is the golden benchmark's job.

## Layer 1 — delivery (deterministic, no keys, CI)

`run.js` + `fixtures.json`. Replays each verdict-delivery shape through the
**production** `extractVerdict` (both of them: `verifier.agent.ts` and the
generic `llm-verdict.ts`, which `business-rules-verifier.ts` also uses) and
asserts the `keep` decision survives.

```bash
node evals/verifier-verdict/run.js          # print the ledger
node evals/verifier-verdict/run.js --gate   # exit 1 when a delivered verdict is lost
```

Shapes covered: the tool payload; a JSON object in the final text; a verdict
after a quoted code block; a verdict after an example object; a renamed key
(`shouldKeep`, `{result:{…}}`); and the two cases where fail-open is **correct** —
a run cut off mid-investigation with no text, and prose with no verdict at all.

It is a regression gate, not a one-off: strip the text path and it goes red.

Proven both ways at the time of writing, on the same 8 rows:

| tree           | LOST refutations | gate exit |
| -------------- | ---------------- | --------- |
| before the fix | 4 of 5           | 1         |
| after the fix  | 0 of 5           | 0         |

`parseMode` reads `undefined` on every pre-fix row — the field was hardcoded to
`'direct'` in `core-agent-loop.adapter.ts`, so the trace could not distinguish a
judged keep from a parse miss. That is why the fix records it for real.

## The finalize ledger — can the model deliver at all?

A verdict can only be read if the model got a step to write one. `run.js` walks
the **real** verifier spec step by step, at both depths, and asserts two things:

1. No step in the last stretch (`maxSteps - 2` onward, where `BudgetPolicy`
   deliberately goes quiet) is left with neither budget guidance nor a finalize
   nudge.
2. No policy restricts the active tools. This agent's contract is **text** — its
   prompt hands the model a JSON schema and says "Return a final JSON verdict",
   and never names the done tool. `model-strictness.ts` records that constraining
   this output halves recall (0.357 → 0.100) and declares the text fallback the
   intended channel for Anthropic and the OpenAI-compatible providers, which is
   most of the fleet. Forcing the tool mid-run contradicts the prompt.

```
light (default, confidence >= 5)  maxSteps=5   policies=[budget, force-text-finalize]
  step   budget-note  finalize-note  tools-restricted
  1..2   -            -              -
  3..5   -            yes            -
full (confidence < 5, evidence gate)  maxSteps=10
  2, 5   yes          -              -
  8..10  -            yes            -
```

Proven in three states, on the real spec:

| verifier policies                            | ledger                                               | gate |
| -------------------------------------------- | ---------------------------------------------------- | ---- |
| `[budget]` (before)                          | 6 unguided final steps — light 3,4,5 and full 8,9,10 | 1    |
| `[budget, force-finalize]` (forces the tool) | 6 steps restrict tools → contradicts the prompt      | 1    |
| `[budget, force-text-finalize]` (now)        | clean                                                | 0    |

Why `BudgetPolicy`'s `maxSteps < 6` short-circuit is **not** the bug: at light
depth the first two steps genuinely are free, and `computeBudgetBand` goes quiet
from `maxSteps - 2` precisely because a finalize policy is expected to take over
there. What was missing is that policy — the verifier had none, while the finder
carries two (`finder.agent.ts:192,198`).

Production rate this addresses, measured 2026-09-19 over 154 verifier runs: **31
(20%) produced no verdict at all**, and 16 of 24 sampled died on the final step
still calling tools. Fail-open then keeps the candidate, so the verifier is a
no-op for that fifth. Re-run `capture.js` after deploying to see the rate move —
that number is the metric, and it cannot be proven offline.

## Layer 2 — how often each shape occurs (Langfuse, on demand)

`capture.js` pulls `kodus-generalist-review-agent` traces, finds the verifier
runs, and writes a corpus `run.js` can replay.

```bash
node evals/verifier-verdict/capture.js --days 10 --limit 200
node evals/verifier-verdict/run.js --corpus /tmp/kodus-verifier-verdict/corpus.json
```

Needs `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` (env, `~/.kodus-dev/config`,
or `.env`).

**The corpus is never committed.** kodus-ai is public and the payloads are
customer source; `capture.js` writes to a temp dir by default. `fixtures.json`
carries the same shapes rewritten against a neutral codebase.

### Observed 2026-09-19 — 117 traces, 154 verifier runs, all orgs

`capture.js --days 10 --limit 200` (83 of the 200 trace fetches failed and were
skipped, so every count is a floor):

| delivery                                          | runs | share        |
| ------------------------------------------------- | ---- | ------------ |
| `tool` (called `submitVerdict`)                   | 77   | 50%          |
| `text` (verdict in prose — all discarded pre-fix) | 46   | 30%          |
| `none` (no verdict at all)                        | 31   | 20%          |
| of the `text` rows: a `keep:false` verdict        | 2    | 1.3% of runs |

Replayed through the production extractor (77 judgeable rows — the 77 `tool` rows
predate `toolPayload` capture and were skipped):

| tree           | refutations delivered | LOST  | gate |
| -------------- | --------------------- | ----- | ---- |
| before the fix | 2                     | **2** | 1    |
| after the fix  | 2                     | 0     | 0    |

After the fix, 43 rows read as `parseMode=text` and 34 as `default-keep`. Before
it, all 77 read `undefined`.

A third row carried `keep:false` somewhere in its text but `keep:true` as its
LAST verdict, and its prose is a genuine confirmation. Taking the last object —
the rule issue #1937's design comment asked for — is what keeps that real finding
from being dropped; a naive "contains keep:false" match gets it wrong.

Read this before trusting the issue's Impact section:

- **Magnitude is ~1%, not ~9%.** The issue's ~9% came from one org
  (`d088c820…`) with 169 text verdicts. Across orgs, half the runs call the tool
  normally.
- **The model moved.** The losses were `deepseek/deepseek-v4.1-flash` and
  `GLM-5.3-FLASH`. `claude-sonnet-4-6` — the model in the issue title — had a
  single text run and zero `keep:false` in this window; `claude-opus-5` had 17
  text runs and zero.
- **Sample skew:** newest-first, so this is 2026-09-17..19, not the issue's
  2026-09-09..15 window. It is today's fleet, not a replication of the issue.
- **A bigger hole sits next to this one:** most of those 31 `none` runs end with
  a `tool_call`-only message and no text — the verifier was cut off mid-
  investigation, step budget exhausted, and never produced a verdict. Fail-open
  keeps the candidate. This eval records it; the fix does nothing for it (there
  is nothing to parse) and no issue tracks it yet.

## Known limits

- `capture.js` identifies the verifier by its system prompt because the trace
  does not name it: `verifier.agent.ts` builds `agent/verify:file#line` but every
  observation arrives as a generic `invoke_agent <model>`. Fix that and this
  eval gets cheaper and the per-finding attribution above becomes possible.
- No provider breakdown. `byokProvider` is not on the trace (`metadata` carries
  `organizationId`, `teamId`, `prNumber`, `pullRequestId`, `repositoryId`,
  `scope`), so the table is by model as a proxy.
