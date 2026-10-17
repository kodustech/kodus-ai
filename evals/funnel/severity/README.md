# funnel/severity

> - **Answers:** Of the known bugs a review's findings reach the severity pass with, how many does it keep above the default threshold?
> - **Runs:** nightly on the controlled set when the severity pass or the snapshot changes (`evals/nightly-evals.js`); weekly on every tier-0 model's controlled set and DeepSeek's full set (`evals/weekly.js`); its control pair on every PR (`evals/wiring-smoke.js`).
> - **Run it:** `node evals/funnel/severity/run.js --model=<id> [--set=controlled|full]`
> - **Gate:** `--gate` fails below the floor for the model and set in `targets.json` (`sets.<set>.models`); a model with none reports ungated.
> - **Cost:** one severity call per PR that has a known bug among its findings.

Runs `AgentReviewStage.reclassifyAndFilterSeverity` (`agent-review.stage.ts`)
on what reached it in the snapshot's review (`evals/funnel/snapshot`): the
severity classifier on the PR's findings in one call, then the team's
threshold, here the default config's `severityLevelFilter: medium`
(`default-kodus-config.yml`), the threshold most teams run (441 set it
explicitly; 296 run `critical`, BigQuery mirror 2026-10-15). A known bug is
lost when every finding that matches it is classified below the threshold. The
control pair: a crash on every checkout stays, a naming preference is dropped.
See `evals/funnel/README.md` for the snapshot and the known bugs.
