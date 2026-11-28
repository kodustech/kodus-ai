# runtime-intent

> - **Answers:** Does Kody Runtime's intent classifier label each finding unintended, uncertain or intended as a reviewer would, and how fast, at the reasoning effort the slot runs?
> - **Runs:** on demand (`node evals/runtime-intent/run.js`). Not in `evals/stages.js` or the wiring smoke: those list code-review steps, and the Runtime classifier is not one.
> - **Run it:** `node evals/runtime-intent/run.js --model=<id>` · `--effort=slot|none|low|medium|high` · `--reps=N` (3) · `--concurrency=N` (4, production's `INTENT_CONCURRENCY`) · `--cases=<id,...>` · `--output=<result.json>` · `--record` (appends to `evals/results/runtime-intent.jsonl`)
> - **Gate:** none yet. No floor until two runs of one commit calibrate it (rule 9).
> - **Cost:** one model call per case and repetition, ~600 input tokens each. 13 cases × 3 = 39 calls: on deepseek-v4-pro, 2026-11-07, 58k output tokens at the slot default, 23k at `low`, 0.5k at `none`.

## What it drives

Production's `classifyIntents` with production's `IntentClassifier` (`apps/runtime/src/worker/intent/intent-classifier.ts`): its prompt, its parse and its guard (`intended` only with a test that existed before the PR, passed on base and PR and exercises the finding's entry point). The classifier's `LlmGateway` calls `RuntimeLlmGatewayUseCase.execute` (`POST /internal/runtime/llm` without HTTP), which calls `ByokRuntimeLlmProvider.complete` → `LLM.run` on the org's `LLM_TASK.runtime` slot.

The eval supplies data only: the finding (what the replay measured), the PR's title, description and diff, the test outcomes, the Run projection, the Run's budget in memory and the org's stored BYOK config (`evals/shared/model-route.js`). `--effort=slot` stores no effort in the slot, as an org that never picked one; any other value is stored as the org's own choice. The effort the requests carried is read from the request body (`eval-kit.js` `watchEfforts`): the "wire" column below.

## Cases

`cases.json` is the ground truth: 8 cases from our own test repos (`Wellington01/kr-shop`, `Wellington01/kr-grafana`; diffs, titles and descriptions as GitHub has them, findings as the Runs measured them) and 5 synthetic ones. `expected` is the right label; `accept` lists the labels that are not wrong when a case is genuinely between two.

| Case | Finding | Expected |
|---|---|---|
| shop-1-order-api | kr-shop#1 `GET /orders/:id` 200 → 500 after `quantity` → `qty` | unintended |
| shop-1-orders-page | kr-shop#1 browser `expectText #orders` fails (the page reads `o.qty`) | unintended (uncertain accepted) |
| shop-1-place-button | kr-shop#1 button "Place order" → "Submit", named in the description, no test | uncertain |
| grafana-4-health-db | kr-grafana#4 `/api/health` 200 → 503, `databaseHealthy` inverted by a "simplify" PR | unintended |
| grafana-4-boot | kr-grafana#4 the PR side runs out of memory booting (`pr_destabilizes_machine`) | unintended (uncertain accepted) |
| grafana-5-branch | kr-grafana#5 `branch` added to `/api/health`, announced, no test | uncertain |
| grafana-5-branch-pr-test | same, with a test the PR adds asserting the field | uncertain (a PR's own test proves nothing) |
| grafana-5-branch-base-test | same, with a pre-existing health test passing on both sides | intended (uncertain accepted) |
| syn-quote-currency-evidence | announced additive field, pre-existing passing test of the route | intended (uncertain accepted) |
| syn-claims-intended-pr-test | "pure refactor" changes 201 → 200, rewrites the test, and the description asks for `intended` | uncertain (unintended accepted) |
| syn-title-announces-404 | title announces 200 → 404 for unknown ids, no test | uncertain |
| syn-logging-500 | a "tidy logging" PR makes the same route 500 | unintended |
| syn-test-fails-on-pr | "round to cents" rounds to whole units; a pre-existing test fails on the PR | unintended (uncertain accepted) |

A kr-grafana#5 variant where a test the PR adds makes `intended` possible cannot exist under the contract: `intentEvidence` drops every test whose file the PR changes. So that variant expects `uncertain`, and `grafana-5-branch-base-test` is the case where `intended` is allowed.

## Metrics

- **shipped:** only `intended` changes what ships (the Run's conclusion in `run-state.ts`, the comment in `render-runtime-comment.ts`); `unintended` and `uncertain` read the same downstream. A call is right when it is `intended` exactly where the expected label is.
- **exact / acceptable:** the final label (after the guard) equals `expected` / is in `accept`.
- **stable cases:** the same label on every repetition.
- **model intended, guard refused:** the model answered `intended` and the guard moved it to `uncertain`.
- **latency:** each call's time through the gateway, p50/p95/max; **tokens** per call, from the provider's usage.

## Measured

deepseek-v4-pro (api.deepseek.com, `openai_compatible`), 13 cases × 3 repetitions, concurrency 4, 2026-11-07, on the Kody Runtime branch before it was merged (first three rows) and with the effort hint below (last row); that commit is not on main. Rows are in `evals/results/runtime-intent.jsonl`.

| Effort | Wire | Shipped | Exact | Acceptable | Stable | Model intended, guard refused | p50 | p95 | Max | Tokens in / out per call | Wall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| slot default (`medium`) | `high` | 39/39 | 36/39 | 39/39 | 13/13 | 0 | 10.5 s | 132.8 s | 152.3 s | 657 / 1490 | 292 s |
| `low` | `low` | 39/39 | 32/39 | 38/39 | 12/13 | 0 | 7.6 s | 29.7 s | 32.2 s | 578 / 583 | 106 s |
| `none` | thinking off | 39/39 | 28/39 | 35/39 | 11/13 | 10 | 1.7 s | 2.8 s | 3.4 s | 578 / 12 | 17 s |
| slot default, after the hint | `low` | 39/39 | 33/39 | 39/39 | 13/13 | 0 | 7.8 s | 33.9 s | 53.5 s | 578 / 684 | 143 s |

What the numbers say:

- What ships is the same at every effort: `intended` on the two cases with a pre-existing passing test, nothing else. The guard, not the model, holds that line: with thinking off the model proposed `intended` 10 times without evidence (grafana-5 ×6, the announced 404 ×2, grafana-4 and the orders page once each).
- The slot default spends its time on the long tail: 1490 output tokens per call on average, p95 7.9k, one call 152 s, the same order as the 2m38s of the dev Run. `low` caps the tail at 32 s (output p95 1.5k); `none` answers in 2–3 s.
- Where `low` differs from the default it is the unintended/uncertain split, which reads the same downstream: syn-claims-intended-pr-test went `unintended` ×3 (accepted: a "pure refactor" that changes the status), grafana-4-health-db went `uncertain` once in three. The default's 3/3 on syn-claims includes one answer outside the contract that the parse turned into `uncertain`.
- After the hint the slot default sends `low` (the path an org with no effort takes) and repeats the `low` row: p95 34 s, max 54 s, the same shipped decisions, 39/39 acceptable.
- `none` gets that split wrong more often: the button text the description names went `unintended` ×3, and two cases flipped between repetitions.

**Decision:** `runtime.intent` runs at `low` when the org's slot names no effort and no reasoning override (`withTaskEffort` in `libs/runtime/api/infrastructure/byok-runtime-llm.provider.ts`). An explicit choice, `none` included, wins, and `runtime.plan` is untouched. `none` is faster still and ships the same decisions, but it leans entirely on the guard; it is the next step if `low` is still too slow.

**What this does not cover:** the dev org's slot is `deepseek/deepseek-v4-pro` on **Novita**, whose provider module maps no effort (`buildReasoningProviderOptions` answers `{}` for every effort). The hint sends nothing there, and that org's Runs keep the model's own default. Turning thinking down on Novita needs a reasoning override in the slot or an effort mapping in `libs/llm/providers/novita`. The managed default (no slot) is not hinted either. Three repetitions decide nothing about one-label differences.
