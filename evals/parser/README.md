# Prose-findings recovery eval

Two layers validate the prose-findings recovery (`recoverFindingsFromProse` /
`extractFindingsWithRecovery` in `finder.agent.ts`) — the fallback that recovers
findings when the model writes them as prose in `reasoning` and omits the
`suggestions` array (the dominant Anthropic omission mode).

## Layer 1 — wiring (deterministic, in CI)

`libs/code-review/infrastructure/agents/core/finder.agent.spec.ts` →
`describe('prose-findings recovery')`. No LLM: a mocked recoverer + hand-built
`RunState` fixtures assert the logic that silently breaks in refactors:

- `extractFindings` **preserves the prose** `reasoning` when `suggestions` is omitted.
- `extractFindingsWithRecovery` only calls the recoverer when `suggestions` is
  empty, passes it the prose, merges the result, keeps empty on no-recovery, and
  is a safe no-op when no recoverer is injected.

Run: `pnpm test --testPathPatterns="finder.agent.spec"`

## Layer 2 — recovery quality (real LLM, on demand)

`run.js` + `fixtures.json`. Feeds REAL captured prose payloads through the ACTUAL
production `recoverFindingsFromProse` (via `getInternalModel`, same per-mode
resolution prod uses) and checks the recovery is faithful: it extracts at least
the expected number of findings and references the right files.

Not a CI test — it calls a real LLM and is non-deterministic.

```bash
# cloud path (gpt-5.4-mini):
API_OPEN_AI_API_KEY=$BYOK_OPENAI_API_KEY node evals/parser/run.js

# a specific re-structurer model (mirrors what a BYOK / self-hosted client's own
# model would do — the recovery uses the client's model, not gpt-5.4-mini, in
# those modes). Uses the tier0-models seam:
RECOVERY_MODEL=kimi-k2.7-code       node evals/parser/run.js
RECOVERY_MODEL=claude-sonnet-4-6    node evals/parser/run.js
```

The runner first does a **reachability probe** and reports `MODEL ERROR` when a
model is unreachable / the key is bad — distinct from a genuine "recovered 0
findings" quality miss (`recoverFindingsFromProse` swallows errors by design, so
without this an infra failure would masquerade as a bad model).

Observed (early): gpt-5.4-mini and claude-sonnet-4-6 recover faithfully;
kimi-k2.7-code recovers the bugs but is looser on file attribution.

Fixtures are Sonnet-5 reasoning-only payloads captured from the finder-recall
eval. Add new ones to `fixtures.json` as new omission shapes appear.
