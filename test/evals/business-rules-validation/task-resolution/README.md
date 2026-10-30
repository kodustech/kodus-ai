# Business-logic task resolution

**Answers:** given a PR and the trackers an org connected, does the judge read the task the PR points at, through the right tool, with its criteria taken from where the team keeps them? Or does it stay silent, or tell the author what to fix? And does the fetch ever write to a tracker?

**Runs:** in the unit suite (`*.spec.ts`), on every PR.

**Run it:** `npx jest test/evals/business-rules-validation/task-resolution` (add `BR_RESOLUTION_STRICT=1` to run the open-issue cases as normal tests).

**Gate:** every case must pass. A case marked `knownFailing` reproduces an open issue and runs as `it.failing`; the PR that fixes it removes the flag.

**Cost:** no model, no network beyond 127.0.0.1.

## What the cases cover

Three axes, one JSON file per case in `fixtures/`:

| Axis | Values |
|---|---|
| Connection and tool | Git Issues; Linear, Jira (Rovo), Notion; a custom plugin with the tool picked automatically, picked by the org, or read by the agent |
| Reference | `#12`, `owner/repo#12`, a key in title/branch/body, tracker URLs, `AB#8`, the team's id pattern |
| Where the task's value lives (`value-*` cases) | the description, a heading, a Jira custom field (text or ADF), Azure's AcceptanceCriteria (HTML), a Notion property, a ClickUp custom field, only attachments |

Each case states the outcome, and may also state:
- `criteria`: what the judge got as acceptance criteria, apart from the description;
- `toolsCalled`: the tracker tools called, in order. One read for a missing task proves "not found" was not taken for an outage, which is read twice;
- `taskContains` / `taskNotContains`, `commentContains`, `judgedTasks`, `checkPasses`.

Every case also asserts that no tool wrote to a tracker.

## How it drives the engine

`drive-current-stage.ts` runs `BusinessLogicValidationStage` with the real `BusinessValidationService`: reference extraction, tracker catalog, MCP sessions and resolver. Only the boundaries are replaced:

- the mcp-manager's connection list;
- the MCP servers behind it (`fake-mcp-host.ts`): Kodus MCP and Git Issues run their production factories and tools over a fake git host (`fake-code-host.ts`); every other tracker answers as `servers.ts` says its real server does;
- the judge, whose input is captured instead of sent to a model.

`servers.ts` holds, per server, the payload a task comes back in, the arguments it honors and how it says "not found". Each shape is marked `live` (recorded from the real server: Rovo answers compact fields unless `fields` is sent, and a missing key in the token owner's language with only `statusCode: 404`) or `docs`. When a server changes, change it there.

## Adding a case

One JSON file in `fixtures/`, in an invented domain (never a customer's repo, ids or code). `defaults.ts` holds the repository and diff most cases share; state only what differs.

## The judge, wherever the criteria live

`../criteria-location/criteria-location.live.spec.ts` reads one task with a known answer through each tracker (server payload → tracker → criteria location → judge) with the criteria in a different place each time, and requires every requirement right in every variant. Its first block (criteria reach the judge) runs on every PR; the judge block hits a real model and runs with `RUN_BR_EVAL=1` and the model credentials in the environment.
