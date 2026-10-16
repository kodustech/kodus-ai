# funnel

> - **Answers:** Of the known bugs the finder finds, where in the stages after it is each one lost?
> - **Runs:** each stage nightly (`evals/nightly-evals.js`, `funnel-<stage>`), ungated until the relabeled dataset lands; `snapshot.js` by hand.
> - **Run it:** `node evals/funnel/<anchoring|dedup|severity|verify>/run.js --model=<id>`
> - **Gate:** none yet: every stage's `targets.json` is empty, so the nightly reports `ungated`.
> - **Cost:** see each stage; `snapshot.js` is one production review per nightly PR plus judge calls.

The steps after the agents' finders (verify, anchoring, dedup, severity) are
measured on one frozen input, so a step's number moves only when that step
does:

- `snapshot.js` runs one production review per nightly PR
  (`evals/investigation/agent-provider.js` → `evals/shared/review-stage.js`) and
  records, without changing it, what each step received: per agent loop the
  candidates verify judged and the files the finder investigated, each agent's
  verified findings before the path check, and what dedup and the severity
  pass got. Each finding carries the known bug it matches (the recall judge,
  the nightly's prompt). `snapshot/<model>.json` is committed.
- `known-bugs.js` is the one place the known bugs come from. Today it reads the
  datasets' `goldenComments`; the relabeled dataset (#2114) is a change there,
  then a new snapshot and two calibration runs per stage set the floors.
- `stage-run.js` hands each step its frozen input through the step's
  production function, with what the step reads besides (changed files,
  config, routed model, the agent's runner and tools) rebuilt by production's
  code from the PR's data, and counts the known bugs that reach it and survive.
- `controls.js` holds each step's control pair, on a repository written for
  them: what the step must keep and what it must remove. `--controls` runs
  only those (the wiring smoke does, with no GitHub fetch).

Each step runs alone on its own frozen input, not chained, so a loss is the
step's.
