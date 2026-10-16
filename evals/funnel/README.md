# funnel

> - **Answers:** Of the known bugs the finder finds, where in the stages after it is each one lost?
> - **Runs:** each stage nightly (`evals/nightly-evals.js`, `funnel-<stage>`), ungated until the relabeled dataset lands; `snapshot.js` by hand.
> - **Run it:** `node evals/funnel/<anchoring|dedup|severity|verify>/run.js --model=<id>`
> - **Gate:** none yet: every stage's `targets.json` is empty, so the nightly reports `ungated`.
> - **Cost:** see each stage; `snapshot.js` is one finder run per nightly PR plus judge calls.

The stages after the finder (verify, anchoring, dedup, severity) are measured
on one frozen input, so a stage's number moves only when that stage does:

- `snapshot.js` runs the real finder (`evals/investigation/agent-provider.js`)
  on the nightly's PRs and records every candidate the verifier judged: the
  finding, its verdicts, whether it survived, and the known bug it matches (the
  recall judge, the nightly's prompt). `snapshot/<model>.json` is committed.
- `known-bugs.js` is the one place the known bugs come from. Today it reads the
  datasets' `goldenComments`; the relabeled dataset (#2114) is a change there,
  then a new snapshot and two calibration runs per stage set the floors.
- `stage-run.js` hands each stage the candidates that reach it (verify: all of
  them; the others: those verify kept), runs the stage's production code, and
  counts the known bugs that reach the stage and survive it.

Each stage runs alone on the same input, not chained, so a loss is the stage's.
