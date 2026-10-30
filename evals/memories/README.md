# memories

> - **Answers:** When a team has a memory, does the review follow it — quiet where the memory says the code is intended, a finding where it says the code is wrong — without silencing a real bug the memory does not cover?
> - **Runs:** nightly when the finder or its cases change (`evals/nightly-evals.js`), weekly on every tier-0 model against its floor (`evals/weekly.js`), and on every PR in `evals/wiring-smoke.js` against the scripted model.
> - **Run it:** `node evals/memories/run.js --model=<id>` · `--no-memories` runs the same cases with none
> - **Gate:** `--gate` fails below the model's floor in `evals/memories/targets.json`.
> - **Cost:** one finder run (finder and verify) per case, 10 cases.

A memory is a Kody Rule of type `memory`. The review hands the team's memories
to the finder as "Team Conventions" in its system prompt (`formatMemoryRules`,
`libs/code-review/infrastructure/agents/prompts/prompt-builder.ts`). The eval
runs the real finder through `evals/investigation/agent-provider.js` on small
pull requests, each with one memory, and reads the findings that survive verify.

`cases.js` holds the cases, written for the eval with invented code after the
kinds of memory production teams keep (437 active memories in 64 orgs, BigQuery
mirror, 2026-10-15): "do not flag this, it is intended" (fake fixture
credentials, auth done by the gateway, reports that load a whole period), a
convention (read settings through `config.get`), and a fact about the codebase
(`src/generated` comes from `openapi.yaml`). Each comes as a pair: one case the
memory decides, and one it must not silence, or code that already follows it.

Each case brings its repository (`repoFiles`), and the agent's grep, read and
listDir answer from it through the production local sandbox
(`LocalSandboxService`), which needs `rg` on the PATH. An expectation names a
file, the line, and the topic of the finding (a pattern on its text): `flag`
wants a finding about it there, `quiet` wants none. Findings on other topics do
not count either way.

`--no-memories` runs the same cases with no memory, to see which ones the memory
decides; the result is in `targets.json`.
