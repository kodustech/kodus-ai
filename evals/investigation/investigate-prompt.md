# Nightly eval regression: investigation

The nightly finder-recall eval of this repository (a code-review product) went
below its floor. Your job is to explain why, for the engineer who will read a
short Discord message about it tomorrow morning.

## Evidence

- `evals/investigation/results/evidence/facts.md`: tonight vs the last green night. Gate checks,
  recall and precision, noise level, the commits measured and the engine files
  they changed, a per-PR table, and for the PRs that dropped most, the known
  bugs lost with both nights' findings.
- `evals/investigation/results/evidence/engine.diff`: the diff of those engine files between the two
  nights.
- The full monorepo at the repository root. The review engine is in
  `libs/code-review/`, `libs/agent-harness/` and `libs/llm/`, and the eval is in
  `evals/investigation/` (runner `run-recall.js`, judge `recall-judge.js`, how
  the eval works in `evals/README.md`).

## How the eval works (so you don't misread the numbers)

The finder runs on 30 recorded PRs with known bugs. Tool calls are answered
from a recording. A judge model decides whether each finding matches a known
bug. Recall is the share of known bugs matched, averaged over PRs. With no code
change, one PR's recall can swing 50pp between nights, and the 30-PR mean moves
by the noise stated in facts.md. A pattern across many PRs is signal. One PR is
not.

## Task

1. Decide which of these explains the drop, with evidence:
   - `regression`: a measured commit changed engine behaviour in a way that
     explains the lost bugs. Name the commit and the file:line, and say how the
     change leads to those bugs being missed.
   - `noise`: the drop is within what the noise level allows and no change
     plausibly explains it.
   - `eval`: an eval-side cause, such as judge behaviour, replay fidelity or a
     dataset change, not the engine.
   - `unclear`: the evidence doesn't decide it. Name what's missing.
2. Look for patterns before reading code. Do the lost bugs share a kind
   (cross-file, security, concurrency)? Did findings or tool calls drop
   everywhere? Did one repository's PRs drop together?
3. Read the diff and the code it touches. Only name a commit you can connect to
   the pattern.
4. Propose the cheapest way to confirm, such as `pnpm eval:nightly` on the
   parent and the suspect commit, or a narrower run with
   `node evals/investigation/run-recall.js --cases=<ids>`.

## Output contract (final message only; you have NO write access)

Your FINAL message must be, in this order:

1. A short report in markdown (English is fine): the verdict, the pattern you
   saw, and the evidence trail with file:line.
2. As the very LAST element of the message, one fenced ```json block, exactly
   this shape:

```json
{
  "verdict": "regression | noise | eval | unclear",
  "confidence": "high | medium | low",
  "summary": "<2-3 sentences for the team's Discord: what happened and the most likely cause>",
  "suspects": [
    { "commit": "<short sha or empty>", "file": "<path:line or empty>", "why": "<one sentence>" }
  ],
  "confirm": "<one command or step>"
}
```

Rules: this investigation is strictly read-only. File writes and shell commands
are denied by policy, so don't attempt them. Don't invent code, commits or
numbers that aren't in the evidence or the repo. If you can't tie the drop to a
change, say `noise` or `unclear` with `low` confidence, and keep `suspects`
empty. That's a useful answer too.
