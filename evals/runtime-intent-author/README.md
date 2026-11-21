# runtime-intent-author

> - **Answers:** Do the intent probes Kody Runtime's intent author writes from a PR's description catch the planted bug and leave the correct PR alone, when the bug and the correct PR share one description?
> - **Runs:** on demand (`node evals/runtime-intent-author/run.js`). Not in `evals/stages.js` or the wiring smoke: those list code-review steps, and the Runtime's author is not one.
> - **Run it:** `node evals/runtime-intent-author/run.js --model=<id>` · `--reps=N` (3) · `--cases=<id,...>` · `--output=<result.json>` · `--scripted` (each case's hand-written answer, no model, no key: checks the wiring and the gate, measures no model) · `--scripted=observed` (the answers the real Runs gave: a case fixed in the prompt must fail on them and one fixed in the gate or the checks must hold, `observedHolds`; exit 1 otherwise)
> - **Gate:** none yet. No floor until two runs of one commit calibrate it (rule 9). The decision's bar is docs/runtime/intent-oracle.md "Done when".
> - **Cost:** one model call per case and repetition, about 1k input tokens each. Not run against a paid model yet.

## What it drives

Production's `IntentAuthor` (`apps/runtime/src/worker/intent/intent-author.ts`): its prompt and its checks (`libs/runtime/planner/intent-author.ts`: a quote must be a substring of its source, assertions inside the closed set). Its `LlmGateway` calls `RuntimeLlmGatewayUseCase.execute` → `ByokRuntimeLlmProvider` on the org's stored BYOK config (`evals/shared/model-route.js`), as `evals/runtime-intent` does. Each probe whose request matches a recorded one is decided by production's gate on the recorded answers: `decideProbe`, `decideNewEndpoint`, then `decideStatedIntent` (`libs/runtime/gate/stated-intent.ts`).

The author reads what production hands it: the PR's title and description, the diff's HTTP entry points and the planner's requests to them as `requestTemplates` (their shape only, `requestTemplatesOf`). No diff, no file, no base answers (production does not pass them yet).

## Cases

`cases.json`: the four kr-shop features of docs/runtime/intent-oracle.md, each a bug PR and a correct PR with the same description (the bodies as the PRs have them). `recorded` holds what base, the bug PR and the correct PR answered to the requests the description names; the base's 404 body on the quote route stands in (only its status was recorded). `scripted` is a hand-written author answer for `--scripted`, not a model's.

| Case | Bug | Correct |
|---|---|---|
| kr-shop-coupon | #7 `charge` 400 where `total` is 320 | #8 `charge` 320 |
| kr-shop-filter | #9 reads `?items`: `?item=keyboard` lists both orders | #10 lists order 1 only |
| kr-shop-total | #11 `total` 52 for 2 × 50 | #12 `total` 100 |
| kr-shop-max-quantity | #13 also refuses 10 units | #14 accepts 10, refuses 11 |

### Regression cases

The failure shapes of the Runs with the real model (the first real-model rounds). Each reads its feature's PR, templates and recorded answers and scores one check; `observed` is the answer the Run's author gave.

| Case | Shape | Check |
|---|---|---|
| regression-request-body | #7 sent `{"monitor":2,"coupon":"SAVE20"}`, 400 | every `POST /orders/quote` body has the template's `item` and `quantity` |
| regression-required-field | #13/#14 sent `{"quantity":10}`, 400 on base too | every `POST /orders` body keeps `item` |
| regression-text-names-parameter | the planner's template copies the bug's `?items` | the probe uses the text's `?item=` and catches #9 |
| regression-weak-assertion | #9 asserted `$[0].item`, which the bug satisfies | the bug is caught |
| regression-answer-cut | #8 cut at 8192 output tokens | the answer is the JSON asked for |
| regression-route-rule | #12 asserted `$.unitPrice * 2` | the rule explains the planner's `GET /orders/2` on the correct PR |
| regression-no-probe | #10 got 0 probes | at least one probe |
| regression-filter-every | v1d: #10 asserted the length and one element; the narrowed list stayed a regression | the correct PR's list is a described change |
| regression-quoted-message | v1d: #13 asserted `$ ==` the quoted message against `{"error":…}` | the correct PR is not flagged |
| regression-unevaluable | v1e: #8 `$request.body.quantity` and a field asserted on a 400 | the correct PR is not flagged |
| regression-invented-value | v1e: #28 sent `?limit=0`, which the text never gives | the correct PR is not flagged |
| regression-shape-twin | v1e: #18 status 201 on `{item: mouse}`, planner's `{item: widget}` stayed a regression | the held status explains the planned probe |
| regression-new-route-404 | v1e: #20 main's Express 404 page against the PR's JSON 404 | not a regression |

`observedHolds`: a shape fixed in the gate or the checks holds on the answer the Run gave; one fixed in the prompt fails on it. `--scripted=observed` exits 1 when a case ends otherwise. The #18 and #20 descriptions are reconstructed (marked in `source`).

## Metrics

- **bug caught:** a scored probe is an `intent_mismatch` on the bug PR's answers.
- **correct not flagged:** no scored probe is an `intent_mismatch` on the correct PR's answers (a `described_change` is counted apart).
- **unscored:** a probe whose request was not recorded says nothing either way; a run with no scored probe is not counted.
