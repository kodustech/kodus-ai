# Issue #1826 — how this is measured, and why the earlier numbers were wrong

Every harness here drives the shipped engine. What differs is the layer BELOW
the engine, and that difference is what made the first round of measurements
misleading.

## The mistake worth not repeating

`BASELINE-1826.txt`, `AFTER-1826.txt` and `NEED-1826-*.txt` all substituted an
in-memory object for the repository lookup: `grep` was `line.includes(pattern)`
and `exists` was `hasOwnProperty`. That fake honours the lookup contract
perfectly and never raises — so it behaved strictly BETTER than either shipped
provider, and both providers were broken:

| | e2b (production) | local (self-hosted) |
|---|---|---|
| `exists()` on a file that is there | **false** | true |
| `exists()` when the parent dir is missing | false | **throws** |

The consequence, proven on this repository in `SIBLING-PROOF-*.txt`: production
told the judge a test file did not exist while reading that same file through
the same sandbox, and self-hosted skipped the rule outright.

**An eval that stubs a boundary cannot see a bug at that boundary.**

## The harnesses

| file | what it drives | needs |
|---|---|---|
| `context-fp-repro.js` | full path: retrieve → judge → claim-check | model key; `--sandbox=local\|e2b` for a real lookup |
| `lookup-conformance.js` | the lookup contract, as PASS/FAIL, per provider | nothing (local) / `API_E2B_KEY` (e2b) |
| `sibling-file-proof.js` | clones this repo and asks whether a file that exists, exists | same |
| `sandbox-lookup-repro.js` | corpus fixtures through a real sandbox, no model call | same |

`lookup-conformance.js` exits non-zero on a contract violation, so it can gate.

## Running it

```bash
# the contract, both providers — the check that was missing
node evals/kody-rules/lookup-conformance.js --provider=local
node evals/kody-rules/lookup-conformance.js --provider=e2b

# the corpus end to end, with a REAL sandbox
node evals/kody-rules/context-fp-repro.js \
  --cases=cases-1826-need --model=<key> --reps=5 --sandbox=local \
  --out=NEED-1826-REALSANDBOX.txt
```

Omitting `--sandbox` keeps the in-memory fake. That is legitimate for prompt
work — it is fast and deterministic — and illegitimate for any claim about what
the repository answers. The harness prints which one it used on the `lookup:`
line of every report, so a result can never be read without knowing.

## The corpora

- `cases-1826.json` — NEGATIVE: every correct answer is 0. Proves the claim
  checker, which can only drop a finding.
- `cases-1826-need.json` — POSITIVE and PAIRED: each rule runs with its
  `contextNeed` declared and again without (the `-CONTROL` twin, byte-identical
  otherwise). The gap between the twins is what retrieval is worth. Plus one
  guard where the sibling exists and the correct answer is 0.

## The unit test that now covers the boundary

`libs/code-review/infrastructure/agents/collaborators/repo-lookup.contract.spec.ts`
runs `buildRepoLookup` over LocalSandboxService's real `buildRemoteCommands` on
a real temp directory — real `rg`, real `find`. Reverting any of the three fixes
makes it fail (verified: 2, 1 and 2 tests respectively).
