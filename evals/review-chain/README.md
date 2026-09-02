# review-chain — LLM-resilience ledger

Two deterministic, no-key, gating checks over the review chain's LLM boundaries:

1. **`run.js` — the wiring ledger. This is a LINT/tripwire, NOT behavioral
   coverage.** It greps each boundary's source for resilience markers and gates
   on two things only: a boundary that *lost* a marker it had (regression), and a
   new `LLM.run(` call-site with no manifest entry (an undeclared phase). It does
   NOT run a model, does NOT prove the marker is on the live path, and does NOT
   prove recovery is correct — its classification rests on a one-time human read.
   Do not count it as "the chain is tested." Its teeth are regression + discovery.
2. **`shape-invariance.js` — the behavioral check.** Drives the REAL recovery
   functions over many payloads × every #1786 wire shape and proves they all
   normalize to one canonical envelope. This is where "recovery actually works"
   is exercised (together with the per-boundary `.spec.ts` contract tests).

The guarantee itself — *every phase that calls an LLM survives the #1786 output
zoo (bare array, fenced, `<think>` leak, renamed key, …), recovering or degrading
safe, never silently dropping findings* — is proven by (2) + the specs; (1) only
keeps new phases from escaping and old ones from quietly unwiring.

```sh
node evals/review-chain/run.js          # print the ledger
node evals/review-chain/run.js --gate   # exit 1 on a regression / undeclared site
pnpm eval:review-chain                   # the gating form
```

Exit: `0` pass · `1` gate (regression or undeclared call-site) · `2` infra.

## What it proves — and what it does not

- **Wiring (static).** Every output-processing boundary routes model output
  through the shared resilience: a `schema:` through the structured executor
  (→ tier-a / tier-a2 recovery in `structured-review-call`), or the shared shape
  layer (`normalizeEnvelope` / `extractJsonFromText`) — not a bespoke
  `JSON.parse` on raw model output that bypasses it. This is the class that bit
  the kody-rules shard (a bare `[]` failed the wire schema and dropped silently);
  the fix is now a **regression gate** — strip the shard's `recoverEnvelopeShape`
  and this eval goes red.
- **Discovery.** No phase escapes: every real `LLM.run(...)` /
  `runStructuredReviewCall(...)` / `runTextReviewCall(...)` call-site in the
  review chain must be claimed by a manifest entry. Add an LLM-calling phase
  without declaring its resilience posture → the eval fails.
- **Not the recovery logic itself.** That `[]`→`{violations:[]}` etc. is
  *correct* is proven by the per-boundary contract specs
  (`structured-review-call.spec`, `structured-output-repair.spec`, and the
  42-row boundary matrices). This ledger asserts the **architecture**; those
  assert the **behavior**. Together = the whole-chain guarantee.
- **No model.** The live legs (real finder / shard / severity seams on a fixture
  PR + metamorphic relations, report-only, needs keys) are a separate Layer 2.

## The ledger statuses

| status | meaning |
|---|---|
| `WIRED` | routes through the shared resilience at or above its declared floor |
| `DECLINED` | must NOT recover off-schema output by design (the compiler → a regex detector) |
| `ACCEPTED` | known non-gating posture (text-only, or a parallel/bespoke extractor that degrades safe) — tracked, not blocking |
| `REGRESSED` | dropped below its resilience floor → **gate** |
| `UNDECLARED` | an LLM call-site with no manifest entry → **gate** |

## Maintaining the manifest

`BOUNDARIES` in `run.js` is the source of truth for the phases and their
resilience floor (`requires`). When you add or move an LLM-calling phase, add or
update its entry. The accepted, non-gating entries and their status:

- **classify-severity** — bespoke `parseSeverityResponse`; degrades safe to
  all-medium (no dropped findings). Wiring it onto the shared
  `extractJsonFromText` is a nice-to-have, and needs its own RED→GREEN (no
  dedicated spec today).
- **reference-detector** — uses a parallel `extractJsonFromResponse` that carries
  its OWN tested 42-row contract (aggressive bracket-slice + fail-safe on
  malformed). It is NOT a silent-loss gap. A swap to `extractJsonFromText`
  regresses 5 of its contract rows (the shared extractor is deliberately more
  conservative), so consolidating is a semantics migration + test update, not a
  drop-in — left as-is.
- **format-suggestion-content** — text call, output used as prose; no shape
  concern.

## Files

- `run.js` — the wiring lint/tripwire (regression + undeclared call-site).
  `pnpm eval:review-chain`. Self-tested by `run.spec.ts`.
- `shape-invariance.js` — the behavioral metamorphic check: many content-varied
  payloads × every #1786 wire shape → one canonical envelope, driving the real
  `normalizeEnvelope` + `extractJsonFromText`. `pnpm eval:shape-invariance`.

## What NONE of this covers (be honest)

Semantic correctness of a well-formed answer — recall / false negatives. A model
that returns a schema-valid `{codeSuggestions:[]}` on a PR that *does* have bugs
passes every check here. That needs a golden set + a live model (the run-suite
`--model=` legs), not a deterministic gate. The largest prod bucket (empty
responses, ~27%) is likewise a model/transport question, not a shape one.
