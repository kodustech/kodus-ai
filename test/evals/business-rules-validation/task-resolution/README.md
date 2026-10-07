# Business-logic task resolution

**Answers:** given a PR and the trackers an org connected, does the judge read the task the PR points at, stay silent, or tell the author what to fix? And does the fetch ever write to a tracker?

**Runs:** in the unit suite (`*.spec.ts`), on every PR.

**Run it:** `npx jest test/evals/business-rules-validation/task-resolution` (add `BR_RESOLUTION_STRICT=1` to run the open-issue cases as normal tests).

**Gate:** every case must pass. A case marked `knownFailing` reproduces an open issue and runs as `it.failing`; the PR that fixes it removes the flag.

**Cost:** no model, no network beyond 127.0.0.1.

## How it drives the engine

`drive-current-stage.ts` runs `BusinessLogicValidationStage` with the real `BusinessValidationService`: reference extraction, tracker catalog, MCP sessions and resolver. Only the boundaries are replaced:

- the mcp-manager's connection list;
- the MCP servers behind it (`fake-mcp-host.ts`): Kodus MCP and Git Issues run their production factories and tools over a fake git host (`fake-code-host.ts`); Linear, Rovo and custom plugins are fakes declared in each fixture;
- the judge, whose input is captured instead of sent to a model.

A fixture describes behavior (`validated`, `comment`, `silent`), not the stage's internals. The driver lists the fixture fields it cannot express yet; a case using one is skipped and named as not measured (today: `settings`, the task source an org picks, #1884).

## Adding a case

One JSON file in `fixtures/`, in an invented domain (never a customer's repo, ids or code). `defaults.ts` holds the repository and diff most cases share; state only what differs.
