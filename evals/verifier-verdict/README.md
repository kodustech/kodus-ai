# verifier-verdict — verdict delivery

> - **Answers:** Does a verdict the verifier actually delivered reach the gate — and did the run get a step to deliver one at all?
> - **Runs:** every engine PR (`evals/wiring-smoke.js`).
> - **Run it:** `pnpm eval:verifier-verdict` · `pnpm eval:verifier-verdict:gate` · `pnpm eval:verifier-verdict:capture`
> - **Gate:** exit 1 on a delivered verdict the extractor lost, or on a final step that can end with no verdict.
> - **Cost:** none (no model). `capture.js` reads Langfuse only.

Not [promotion](../promotion/README.md): that one asks whether the keep/drop
_judgment_ is right on frozen evidence, with a model. This one asks whether the
judgment the model already made survives the plumbing. A verdict can be perfect
and still be thrown away.

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

What it deliberately does **not** count as a delivered verdict: a value the
parser cannot read. Production reaches the verdict through `JSON.parse`, which
accepts only `true`/`false`, so a Python-style `{"keep": False}` correctly
fail-opens — reading it as a refutation here would score a healthy run as a lost
verdict. The key, by contrast, IS matched loosely (`normalizeKeyName` lowercases
it and strips `_-` before production compares it). Such rows are counted and
printed under the shapes the parser does not read by design, never gated.

Proven both ways: revert the text path and the refutation rows go RED with the
production rationale `no parseable verdict — kept by default`; restore it and
they pass. Run it and read the ledger rather than trusting a count here.

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

Proven in three states on the real spec: with no finalize policy the last steps
are unguided and the gate fails; with a tool-forcing policy the ledger reports
tools restricted and fails; with the text-forcing one it passes. Run it to see
the per-step table.

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

### What production delivers

The counts live in [observed.json](observed.json) — capture writes them, nothing
is typed by hand, and `evals/AGENTS.md` forbids restating them here. Refresh:

```bash
node evals/verifier-verdict/capture.js --days 10 --limit 200 --write-observed
```

Read `observed.json` before trusting issue #1937's Impact section. That section
generalised from one org; across orgs the mix is different, the affected models
have moved, and the `none` share — runs that deliver no verdict at all — is the
larger hole. The file carries its own caveats and its capture date, because the
fleet mix moves week to week: two captures ten days apart disagreed enough that
any number quoted in prose would already be wrong.

## Known limits

- `capture.js` identifies the verifier by its system prompt because the trace
  does not name it: `verifier.agent.ts` builds `agent/verify:file#line` but every
  observation arrives as a generic `invoke_agent <model>`. Fix that and this
  eval gets cheaper and the per-finding attribution above becomes possible.
- No provider breakdown. `byokProvider` is not on the trace (`metadata` carries
  `organizationId`, `teamId`, `prNumber`, `pullRequestId`, `repositoryId`,
  `scope`), so the table is by model as a proxy.
