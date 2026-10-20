# Business-logic validation eval

> - **Answers:** Does the business-logic stage report what a PR leaves out of the Jira ticket it closes, pass a PR that does all of it, and stay quiet when it cannot read the ticket?
> - **Runs:** nightly on one real model when a file it loads changed (`evals/nightly-evals.js`), gated on it; weekly on every tier-0 model (`evals/weekly.js`); every engine PR against the scripted model (`evals/wiring-smoke.js`).
> - **Run it:** `node evals/business-logic/run.js [--model=<tier-0 id>] [--gate] [--verify]`
> - **Gate:** `--gate` uses the per-model floor in `evals/business-logic/targets.json`. A judge call that fails (a key, a quota, a timeout) is not measured (exit 2), never a miss.
> - **Cost:** per case, the judge call, its second look at a MISSING requirement, and the verify call with `--verify`; three cases.

It runs production's `BusinessLogicValidationStage` (`production-stage.js`):
`BusinessValidationService` finds the task the PR names, reads it through the
Jira tracker over production's `MCPManagerService` and MCP adapter, and judges
the diff against it with the real skill
(`libs/agents/skills/business-rules-validation/SKILL.md`);
`BusinessLogicPublisher` renders the PR comment. The eval supplies data only:

- the mcp-manager service's answer: the team's two connections, Kodus MCP
  (production's own server, which reads no task) and Atlassian Rovo
  (`atlassian-rovo-default`);
- an Atlassian MCP (`getAccessibleAtlassianResources`, `getJiraIssue`,
  `getVisibleJiraProjects`) that answers from the case's ticket in Atlassian's
  shape, and with Jira's 404 text for a ticket it does not have;
- the code host's answers about the PR, and the comments written on it;
- no earlier validation run of the PR;
- the team's settings: business logic on, and the org's model config
  (`evals/shared/model-route.js`: a stored BYOK config holding the model).

What is scored is what the stage records and publishes: its outcome
(`gap_found`, `success`, `skipped`) and, for a gap, whether the published
comment names what is missing.

## Cases

`cases.json`, with the diffs and tickets in `files/`:

- `missing-requirement` — PROJ-101 asks soft-delete to also revoke the user's
  sessions; the PR only sets `deleted_at`. Expected: a gap whose comment names
  the sessions.
- `fully-implemented` — PROJ-102 asks for `lastSyncedAt`, updated on sync and
  tested; the PR does all three. Expected: a pass.
- `no-task-context` — PROJ-103 cannot be read (Jira answers 404). Expected:
  skipped, no gap claimed.

Beside it, with no model: `test/evals/business-rules-validation/task-resolution`
reads which task a PR names through each tracker's scripted MCP server. With a
real model, gated on `RUN_BR_EVAL=1`: `requirement-accuracy.live.spec.ts` (the
judge's answer per requirement against a gold), `gap-check.live.spec.ts` (the
second look at a MISSING one) and `analyzer-verdict.live.spec.ts`.
