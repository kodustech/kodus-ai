# custom-agents

> - **Answers:** Does a team's custom agent flag what its instructions ask for, only in its lane and only on the files its globs reach, and does a disabled agent stay silent?
> - **Runs:** on every PR in `evals/wiring-smoke.js` against the scripted model (what the review hands each agent); nightly when one of its files changed and weekly on every tier-0 model (`evals/nightly-evals.js`, `evals/weekly.js`), gated only for a model with floors in `targets.json`.
> - **Run it:** `node evals/custom-agents/run.js --model=<id>` · `--cases=<id,...>` · `node evals/custom-agents/mutations/run.js` breaks each property on purpose
> - **Gate:** `--gate` fails when the overall share or any one property falls below the model's floors in `evals/custom-agents/targets.json`.
> - **Cost:** one review per case (each agent's finder and verify), 10 cases; none under the scripted model.

Custom review agents (#2172) are team-defined reviewers that run beside the
built-in ones. The eval runs production's review stage on small pull requests
and reads what `AgentReviewStage` ships, after verify, the agent's floor and
cap, dedup and the formatter, where `evals/memories` reads it:
`evals/shared/review-stage.js` resolves the team's saved config through
`CodeBaseConfigService.getConfig`, fetches the changed files (ignored ones
included) through `FetchChangedFilesStage`, checks the PR's head out in
`LocalSandboxService` and runs `AgentReviewStage` with
`ReviewOrchestratorService` and its `CustomAgentProviderFactory`, as
`CodeReviewPipelineModule` builds it. A case becomes the platform's PR and the
team's config through the finder eval's own conversion (`agent-provider.js`
`prOf`/`teamOf`, the path `--team-config` takes); the model is the org's stored
BYOK config (`evals/shared/model-route.js`).

Each team saves its agents with the built-in categories off, so what ships is
the agents' own (a configuration production supports). The cases are written
for the eval in invented domains (billing in integer cents, an HTTP error
contract, database migrations), and each check names the property it holds
(`cases.js`). A `flag` or `quiet` check reads the findings stamped with the
agent's id; a `dispatch` check reads the agent loops production ran and the
files each was handed, needs no model, and so holds under the scripted model on
every PR.

## Properties

| Property | Promise | Held by |
|---|---|---|
| P1 in-lane | An agent flags each violation of its instructions in its scope, and stays quiet on code that follows them | this eval: 3 flags, 3 controls (a real model); `custom-agent.provider.spec.ts` (the instructions reach the prompt) |
| P2 lane-only | An agent posts nothing about a defect its instructions are not about | this eval: 3 checks (a real model); `custom-agent.provider.spec.ts` (the verifier gets the lane focus) |
| P3 scope | Nothing is posted on a file outside the agent's globs | this eval: 3 checks (a real model), 3 dispatch checks; `custom-agent-scope.spec.ts`, `review-orchestrator.custom-agents.spec.ts` |
| P4 explicit glob reaches an ignored file (#37) | An include glob with a literal segment whose last segment says more than `*` or `**` (`db/migrations/**/*.ts`, not `db/migrations/**`) reaches a file the team's ignorePaths set aside; a secret file (`.env*`, `*.pem`, `*.key`, ...) never | this eval: 2 flags, 1 control (a real model), 3 dispatch checks; `custom-agent-scope.spec.ts`, `review-orchestrator.custom-agents.spec.ts`, `fetch-changed-files.stage.spec.ts`, `agent-review.stage.custom-agents.spec.ts` |
| P5 floor → cap → dedup | The agent's severity floor and comment limit apply before dedup, so a finding they drop never takes a native one with it | `agent-review.stage.custom-agents.spec.ts` |
| P6 quote gate | A convention finding quotes only a guide linked to the agent or the agent's instructions | `convention-check.spec.ts` |
| P7 disabled | A disabled agent, or one a directory turns off with `enabled: false`, does not run | this eval: 1 dispatch check; `agent-review.stage.custom-agents.spec.ts`, `directory-custom-agents-cascade.spec.ts` |

A finding on a file outside the agent's files is also dropped by the mapper
every agent shares (`finding-mapper.ts`, "relevantFile not in changedFiles";
`finding-mapper.spec.ts`).

## Falsification

Each property has a deliberate break under `mutations/`, a patch to
production's code. `node evals/custom-agents/mutations/run.js` applies each,
runs the checks that hold its property, expects every one red (a jest failure,
or this eval's gate at exit 1; exit 2 is "not measured", never red), reverts,
checks the touched files are clean again, and prints the table. `--only=P3`
runs one property, `--model=<id>` picks the real model, `--skip-model` skips it.
More than 5% of the checks not measured, `--skip-model` included, exits 2.

Run on ca/eval, 2026-10-19 (`node evals/custom-agents/mutations/run.js`,
exit 0 then; with 2 of its 20 checks not measured, more than 5%, the runner
now exits 2 on the same run). Every patch was reverted and its files checked
clean after each one.

| Property | Break (`mutations/`) | Check | Result |
|---|---|---|---|
| P1 | `P1-instructions-dropped.patch`: the agent's instructions never reach its prompt | `custom-agent.provider.spec.ts` | red: 1 of 23 failed, "puts the team's instructions in the prompt" |
| P1 | same | this eval on the nightly model, P1's cases | **not measured**: no Fireworks key (see Measured) |
| P2 | `P2-lane-focus-dropped.patch`: no lane focus, so the verifier no longer drops findings outside the instructions | `custom-agent.provider.spec.ts` | red: 1 of 23 failed, "keeps to its lane by default and hands the verifier its focus" |
| P2 | same | this eval on the nightly model, P2's cases | **not measured**: no Fireworks key |
| P3 | `P3-include-globs-ignored.patch`: include globs not applied, an agent gets every changed file | `custom-agent-scope.spec.ts`, `review-orchestrator.custom-agents.spec.ts` | red: 13 of 68 failed |
| P3 | same | this eval, `--model=eval-fake --gate` | red, exit 1: P3 3/6 < 1, overall 14/22 |
| P4 | `P4-ignored-files-unreached.patch`: an explicit glob no longer reaches an ignored file | scope, orchestrator, fetch-changed-files and stage specs | red: 9 of 94 failed |
| P4 | same | this eval, `--model=eval-fake --gate` | red, exit 1: P4 1/6 < 0.66 (and P3 5/6: the migrations agent no longer runs, so its `never` check cannot hold) |
| P5 | `P5-floor-and-cap-after-dedup.patch`: the floor and cap run after dedup | `agent-review.stage.custom-agents.spec.ts` | red: 2 of 20 failed, the floor and the cap "never takes a native one with it" |
| P6 | `P6-any-file-quotable.patch`: the quote gate takes a quote from any repository file | `convention-check.spec.ts` | red: 3 of 47 failed |
| P7 | `P7-disabled-agent-runs.patch`: `enabled: false` ignored in the stage and in the dispatch | `custom-agent-scope.spec.ts`, `agent-review.stage.custom-agents.spec.ts` | red: 1 of 70 failed, "dispatches the enabled agents" |
| P7 | same | this eval, `--model=eval-fake --gate` | red, exit 1: P7 0/1 |
| P7 | `P7-directory-override-ignored.patch`: a directory agent with an inherited id is added beside it, so `enabled: false` there no longer turns it off | `directory-custom-agents-cascade.spec.ts` | red: 3 of 6 failed |

P5 was not falsifiable at first: with the floor and cap moved after dedup, the
stage spec stayed green (20 of 20). Its two ordering tests scripted the dedup
to keep the native finding, and an agent finding outside its lane never keeps a
group anyway (`preferCustomAgentKeep`), so the order could not change what
shipped. They now give the agent a finding in its lane that the dedup keeps,
which only the floor or cap running first can stop from taking the native
comment with it; green before the break, red under it.

The model-judged halves of P1 and P2 (does a real agent stop flagging without
its instructions, start posting general bugs without its lane focus) are not
proven: they need a run with the nightly model's key. Until then P1 and P2 are
falsified only at the unit level, which shows the wiring breaks, not that the
model's behaviour depends on it.

## Measured

- **eval-fake** (scripted model, the wiring smoke): two runs on ca/eval, 17 of
  22 each, every check alike (P1 3/6, P2 3/3, P3 6/6, P4 4/6, P7 1/1); its
  findings name no file of the case, so every flag check is wrong and every
  quiet and dispatch check right. 30 model calls, 14,000 tokens in and 1,400
  out per run, no cache. Floors in `targets.json` equal what it observed.
- **deepseek-v4-flash@fireworks** (the nightly model): **not measured**. Two
  runs on 2026-10-19 exited 2: no Fireworks key in the environment or
  `~/.kodus-dev/config`. No floor is written for it, so its nightly and weekly
  runs exit 2 until two runs of one commit calibrate it (evals/README.md rule 9).
