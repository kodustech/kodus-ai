# prose-recovery

> - **Answers:** When a finder run ends in prose only, does the prose recovery extract the findings the prose reports and leave out the hypotheses it dismissed?
> - **Runs:** on demand, by hand (#1938); on the scripted model on every PR (`evals/wiring-smoke.js`).
> - **Run it:** `node evals/prose-recovery/run.js --model=<id> [--gate]`
> - **Gate:** `--gate` fails below the model's floor in `targets.json`; a model with none reports ungated.
> - **Cost:** one recovery call per case, 32 calls.

Drives production's `recoverFindingsFromProse` (`libs/code-review/infrastructure/agents/core/finder.agent.ts`),
the call `extractFindingsWithRecovery` makes when a finder run ends with no findings, on the
slot `ValidateConfigStage` routes for the code review, as `evals/parse` reaches it.

The cases (`cases.json`) are finder prose written for this eval, with invented code and
paths: 18 that analyze hypotheses and dismiss every one, 8 that report defects, and 6 that
report some and dismiss others. Every case passes the cheap gate in front of the call
(`looksLikeFindings`), so the eval measures the call, not the gate.

A finding is matched to a case by its file only. Each file a case expects is one check: a
finding on it came out. A case with dismissed hypotheses adds one check: none came out, which
with nothing expected means no finding at all, and otherwise none on a dismissed file; each
dismissed hypothesis sits on its own file for that. The metric is the share of all checks
right; `metrics.extracted` and `metrics.dismissedLeftOut` split it.

Deliberate break: the recovery prompt of #1938's report, which asks for every finding the
prose describes, leaks dismissed hypotheses on the dismiss cases (`targets.json` records it).
