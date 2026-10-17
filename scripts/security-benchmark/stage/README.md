# Static analyzers benchmark

Not an eval: no model decides anything in this stage. It measures what the scanners production ships catch, and runs by hand (evals/stages.js lists the stage with its unit tests).

> - **Answers:** What do the analyzers production ships flag on published vulnerabilities and planted credentials, and do they stay quiet on code that only looks dangerous?
> - **Runs:** on demand, not scheduled: it needs the betterleaks version `docker/Dockerfile` pins, and the vuln tranche clones each advisory's repository.
> - **Run it:** `node scripts/security-benchmark/stage/run-stage.js --tranche=vuln|noise [--gate] [--output=<result.json>]`
> - **Gate:** `--gate` uses the per-tranche floors in `scripts/security-benchmark/stage/targets.json` (whole tranches only).
> - **Cost:** no model calls; one checkout and one scan per sample.

It runs production's `RunAnalyzersStage` (`run-stage.js`) on each sample of
`scripts/security-benchmark/dataset.json`: the repository at its vulnerable
commit, checked out by the self-hosted sandbox
(`LocalSandboxService.createSandboxWithRepo`; a sample with no published commit
is committed to a local repository the same sandbox clones), and the diff the
review is handed. Production's code does the rest: the release gate
(`DeterministicEvidenceGate` over `FeatureGateService` and its catalog), the
router (`AnalyzerToolRouter`), each tool's file selection, the scan in the
sandbox, SARIF parsing and path mapping (`parseAnalyzerSarif`), and the filter
to lines the diff adds. The eval supplies data: the samples, the team's setting
(the secret scan on), an organization on the beta track, and the flag store
answering on for the feature. A scan that did not run for any reason other than
production's own file selection is not a measurement (exit 2).

A sample counts as flagged when a finding the stage keeps covers one of its
vulnerable lines; a noise sample counts as quiet when the stage keeps none.

## Result (betterleaks 1.8.1, 2026-10-16)

Two runs of each tranche, identical sample by sample:

| tranche | what it holds | result |
|---|---|---|
| vuln | 60 published advisories and 6 planted credentials | 6 of 66 flagged: the 6 credentials; nothing raised on the 60 advisories |
| noise | 14 samples that only look like secrets or vulnerabilities | 14 of 14 quiet |

Production's file selection with the secret scan reading no file: vuln 0 of
66, gate red.

## What this does not settle

- The dependency scan (`osv-scanner`) has nothing to read: the corpus holds no
  lockfiles. Only the secret scan is measured.
- Whether an analyzer adds anything the LLM reviewer misses is not measured
  here. The 2026 comparison that decided which analyzers to ship
  (`llm-vs-analyzers.js`, `agent-path.js`, `refutation.js`, last at `fe480c4a9`)
  called the model outside production's path and reimplemented the line
  clipping; its numbers are in git history and are not repeated here.
- `scripts/security-benchmark/run.mjs` scores candidate scanners in isolation,
  before any of them is integrated; it is not this eval.
