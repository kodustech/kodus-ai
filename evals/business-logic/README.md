# Business-logic validation eval

> - **Answers:** Does the business-logic stage report what a PR leaves out of the Jira ticket it closes, pass a PR that does all of it, and stay quiet when it cannot read the ticket?
> - **Runs:** nightly on one real model when a file it loads changed, gated on its floor and measured again before alerting (`evals/nightly-evals.js`); every engine PR against the scripted model (`evals/wiring-smoke.js`).
> - **Run it:** `node evals/business-logic/run.js [--model=<tier-0 id>] [--gate] [--verify]`
> - **Gate:** `--gate` uses the per-model floor in `evals/business-logic/targets.json`.
> - **Cost:** per case, the analyzer call (and the verify call with `--verify`); three cases.

It runs production's `BusinessLogicValidationStage` (`production-stage.js`).
The stage runs `BusinessRulesValidationAgentProvider` with the real skill
(`libs/agents/skills/business-rules-validation/SKILL.md`), which finds its tools
through production's `MCPManagerService` and MCP adapter over HTTP. On the other
end, the Kodus MCP server is production's own (`McpAuthGuard`, `McpController`,
`McpServerFactory`, `CodeManagementTools`), its code host answering from the
case's PR. The eval supplies data only:

- the mcp-manager service's answer: the team's two connections, Kodus MCP and
  Atlassian;
- an Atlassian MCP (`getAccessibleAtlassianResources`, `getJiraIssue`) that
  answers from the case's ticket in Atlassian's shape, and with Jira's 404 text
  for a ticket it does not have;
- the code host's answers about the PR (its record and its files' patches);
- the team's settings: business logic on, no BYOK config (the managed route).

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

The unit suite (`test/evals/business-rules-validation`) covers the steps before
the analyzer (task quality, eligibility, the trajectory) with a scripted tool
caller and no model.
