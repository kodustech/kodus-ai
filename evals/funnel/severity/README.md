# funnel/severity

> - **Answers:** Of the known bugs the finder's findings reach the severity pass with, how many does it keep above the default threshold?
> - **Runs:** nightly when the severity pass or the snapshot changes (`evals/nightly-evals.js`), ungated until the relabeled dataset lands; Friday on every tier-0 model.
> - **Run it:** `node evals/funnel/severity/run.js --model=<id>`
> - **Gate:** none yet (`targets.json`): the value is reported as ungated.
> - **Cost:** one severity call per PR that has a known bug among its findings.

Runs the production severity pass on the frozen findings that survived verify
(`evals/funnel/snapshot`): `classifySeverity` on the PR's findings in one call,
then `survivesSeverityFilter` at `severityLevelFilter: medium`, the default in
`default-kodus-config.yml` and the threshold most teams run (441 set it
explicitly; 296 run `critical`, BigQuery mirror 2026-10-15). A known bug is
lost when every finding that matches it is classified below the threshold. See
`evals/funnel/README.md` for the snapshot and the known bugs.
