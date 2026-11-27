# libs/runtime/planner

The shared core of a Run's test planner (ADR-069): an agent that reads the repository at the Run's base and head through a `RepoReader` and submits the probes to run, plus the diffs it plans with no model call. It runs where `RUNTIME_PLANNER_HOST` says: in the product API (`libs/runtime/api/application/use-cases/test-planner.use-case.ts`, the default) or in the runtime-worker (`apps/runtime/src/worker/agent/worker-plan-client.ts`). See [`libs/runtime/README.md`](../README.md) "planner".

## Owns
- The agent: `test-planner.agent.ts` `planTests`, `testPlannerTools`, `testPlannerPrompt`, `testPlannerSystemPrompt`, `TEST_PLANNER_LIMITS`, `TEST_PLANNER_VERSION`, and the tools `submit_plan`, `exec_on_base`, `browser_explore`.
- The intent author (docs/runtime/intent-oracle.md): `intent-author.ts` `intentAuthorMessages` (one turn, the PR's title, description and linked tasks and the diff's HTTP routes as untrusted data), `checkIntentProbes` (a quote must be a substring of its source, whitespace normalized; assertions outside the closed set are dropped; ids `intent-<n>`), `requestTemplatesOf` (the planner's requests to the diff's routes, shape only: never `expected`, `purpose`, assertions or claims, never a credential header), `isIntentAnswer` and `INTENT_AUTHOR_RETRY` (the worker's one retry), `hasStatedIntent`, `authorTextOf` (a description without Kody's summary: empty when the body is only that summary), `statedIntentSources` (with no author text and no task, the summary's text as the `kody-summary` source, which never explains a difference), `INTENT_AUTHOR_LIMITS`, `INTENT_AUTHOR_VERSION`. The worker makes the call (`apps/runtime/src/worker/intent/intent-author.ts`).
- Plans without a model: `plan-without-model.ts` `planWithoutModel` (only dependency versions or only comments move; each file goes in `cannotProve`).
- Bounded repository reads: `repo-reader.ts` `RepoReader` (with an optional `readMany`, at most `READ_MANY_MAX` paths a call), `repoPath`, `READ_LIMITS`, secret files and assignments masked (`isSecretFile`, `redactForModel`, `modelView`); `file-window.ts` windows of numbered lines (`windowedView`, `WINDOW_LIMITS`); `code-search.ts` `searchCode`, a literal grep (`SEARCH_LIMITS`).
- The repository's notes for the planner: `environment-notes.ts` `readEnvironmentNotes` (`.kodus/runtime-notes.md` at the base commit, redacted through `modelView`, at most `ENVIRONMENT_NOTES_LIMITS.promptChars`), carried in every round's prompt as data. A read failure plans without them.
- Routes reaching a changed file through imports: `import-graph/` ([its AGENTS.md](import-graph/AGENTS.md)).

## Does not own
- Git credentials, model slots and BYOK: the caller hands an `AgentRunner` and the readers (the API's `GitRepoReader`, the worker's planner-source client).
- The plan contract and its checks: `libs/runtime/contracts/run-plan.ts` (`checkPlanSubmission`, `RUN_PLAN_LIMITS`).
- Running the planned probes and deciding: the runtime-worker and `libs/runtime/gate`.

## Rules and limits
- No import of `api/`, the recipe author, `@libs/llm`, Nest, `fs` or `child_process` (`planner-boundary.spec.ts`).
- Nothing of the repository is executed, and no pattern is compiled from model text, so a search cannot hang.
- Every read is bounded (bytes, count, time) and passes `redactForModel` before the model sees it.
- The intent author never reads the diff, a changed file or the repository (`planner-boundary.spec.ts`): a planner that reads the code copies the bug. A change to its prompt or checks bumps `INTENT_AUTHOR_VERSION`.
- The import graph's route is a hint, never the answer (the prompt says so, and says a workspace package imported by name is in-repo code). A round-0 plan with no probe, while a route reaches the changed code and `exec_on_base` is available, is sent back once to explore on the base machine (`exploreNudged`); the next submission stands. A first submission keeps room for one fix step (the stop policy reserves three steps before it, two after a refusal).
- Budgets: round 0 (reads the code) `TEST_PLANNER_LIMITS.maxTokens` 80k and 20 steps; rounds 1 and 2 (start from notes) `laterRoundTokens` 50k and 12 steps (`plannerRoundTokens`). The three are 180k, inside a Run's default 200k, and a PR's 600k holds three Runs.
- A change to the prompt, tools or limits bumps `TEST_PLANNER_VERSION`; the Run records it. It touches the review pipeline: carry eval evidence (root `AGENTS.md`, docs/runtime/planner-eval.md).
- The README's note that moving the loop to the worker "requires a gateway contract" is stale: the worker host and the model-turn gateway exist.

## Where new code goes
- A new tool: `testPlannerTools`, with its bound in `TEST_PLANNER_LIMITS` and a case in `test-planner.agent.spec.ts`; `planner-parity.spec.ts` checks the API's re-export answers the same.
- A new no-model rule: `plan-without-model.ts`.

## Tests
- `node node_modules/jest/bin/jest.js --runInBand libs/runtime/planner` (pure, a scripted `AgentRunner`).

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (8, tests apart): `code-search.ts`, `environment-notes.ts`, `file-window.ts`, `index.ts`, `intent-author.ts`, `plan-without-model.ts`, `repo-reader.ts`, `test-planner.agent.ts`

Imports these Runtime modules:

- [`libs/runtime/contracts`](../contracts/AGENTS.md)
- [`libs/runtime/entry-points`](../entry-points/AGENTS.md)
- [`libs/runtime/planner/import-graph`](import-graph/AGENTS.md)
- [`libs/runtime/probe`](../probe/AGENTS.md)
- [`libs/runtime/redaction`](../redaction/AGENTS.md)
- [`libs/runtime/run`](../run/AGENTS.md)

Imported by:

- [`apps/runtime/src/worker/agent`](../../../apps/runtime/src/worker/agent/AGENTS.md)
- [`apps/runtime/src/worker/intent`](../../../apps/runtime/src/worker/intent/AGENTS.md)
- [`apps/runtime/src/worker/run`](../../../apps/runtime/src/worker/run/AGENTS.md)
- [`libs/runtime/api/application`](../api/application/AGENTS.md)
- [`libs/runtime/api/application/recipe-author`](../api/application/recipe-author/AGENTS.md)
- [`libs/runtime/api/application/use-cases`](../api/application/use-cases/AGENTS.md)
- [`libs/runtime/planner/import-graph`](import-graph/AGENTS.md)

<!-- module-map:end -->
