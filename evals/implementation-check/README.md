# implementation-check — did the developer make the change?

> - **Answers:** After a push, does the implementation check record whether the developer made the change each suggestion asked for, on every model?
> - **Runs:** every PR against the scripted model (`evals/wiring-smoke.js`); nightly on one model when a file it loads changed (`evals/nightly-evals.js`); weekly on every tier-0 model against its floor (`evals/weekly.js`, part `review`); in `evals/experiment.js --step=implementation-check`.
> - **Run it:** `node evals/implementation-check/run.js --model=claude-sonnet-5-5 --repeats=2`
> - **Gate:** `--gate` fails below the model's floor in `targets.json` (share of verdicts right); exit 2 when more than 5% of verdicts did not measure.
> - **Cost:** one model call per case per repeat, a few thousand tokens each (39 cases).

`run.js` drives `SuggestionService.checkImplementedSuggestions`, the method the
implementation-verification processor calls with the PR's saved suggestions and
the files changed since the last review. The model is the org's code review
route, through production's `PermissionValidationService` over a stored BYOK
config (`evals/shared/model-route.js`). The eval supplies the data: the saved
suggestions, the changed files as GitHub returns their patches, and a PR store
that records what the check writes.

A verdict is what the store holds for a suggestion after the check, the value
the Cockpit's rate and the next review read. It is right when it agrees with the
case on whether the suggestion was applied (`implemented` or
`partially_implemented`, as the Cockpit counts it). A verdict the check records
as unmeasured does not count either way, and more than 5% of them is exit 2.
The result also reports the precision and recall of "applied", the share of
exact statuses, and the unmeasured share.

## Cases

`cases.json` is built by `build-cases.js` from `sources.js`: eight suggestions on
real files at the head of public benchmark PRs (cal.com, Sentry, Keycloak,
Grafana, Discourse; TypeScript, Python, Java, Go, Ruby, JavaScript), read from
`evals/investigation/datasets`. Three carry a proposed fix, three were shipped
without one (`improvedCode` empty, #1833), two are Kody Rules. Each one gets
follow-up edits written by hand, so the right status is known by construction:

| Edit | Expected |
|---|---|
| fixed as suggested | implemented |
| fixed another way | implemented |
| same file edited elsewhere (control) | not implemented |
| suggested lines edited, problem kept (control) | not implemented |
| one of two asks done | partially implemented |

Three cases check several suggestions in one push, and two start from a recorded
partial that a later push leaves alone, which must stay partial.

Rebuild after editing `sources.js`: `node evals/implementation-check/build-cases.js`
(`--check` fails when `cases.json` is stale).
