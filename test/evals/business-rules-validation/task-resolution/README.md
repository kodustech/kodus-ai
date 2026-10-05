# Business-logic task resolution

**Answers:** given a PR and the trackers an org connected, does the judge read the task the PR points at, stay silent, or tell the author what to fix? And does the fetch ever write to a tracker?

**Runs:** in the unit suite (`*.spec.ts`), on every PR.

**Run it:** `npx jest test/evals/business-rules-validation/task-resolution` (add `BR_RESOLUTION_STRICT=1` to run the open-issue cases as normal tests).

**Gate:** a case with `passesOnMain: true` must pass. A case with `passesOnMain: false` reproduces an open issue and runs as `it.failing`; when a fix makes it pass, flip the flag in the same PR.

**Cost:** no model, no network beyond 127.0.0.1.

## How it drives the engine

`drive-current-stage.ts` runs today's `BusinessLogicValidationStage` with the real provider, skill runner, capability seeds and learning loop. Only the boundaries are replaced:

- the mcp-manager's connection list;
- the MCP servers behind it (`fake-mcp-host.ts`): Kodus MCP and Git Issues run their production factories and tools over a fake git host (`fake-code-host.ts`); Linear, Rovo and custom plugins are fakes declared in each fixture;
- the judge, whose input is captured instead of sent to a model. The fetcher's agentic fallback runs on a model that makes no tool calls.

A fixture describes behavior (`validated`, `comment`, `silent`), not the stage's internals, so the resolver that replaces the stage gets its own driver over the same files. A driver lists the fixture fields it cannot express; a case using one is skipped and named as not measured (today: `settings`, the task source an org picks).

## Adding a case

One JSON file in `fixtures/`, in an invented domain (never a customer's repo, ids or code). `defaults.ts` holds the repository and diff most cases share; state only what differs.
