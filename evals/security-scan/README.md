# security-scan

> - **Answers:** Of the published vulnerabilities in a repository, how many does a security scan capped at a few dollars report, and of what it reports, how much is real?
> - **Runs:** on demand, before a change to the scan ships (`libs/security-scan/`).
> - **Run it:** `node evals/security-scan/run.js --model=deepseek-v4-flash@fireworks [--cases=<id,...>] [--budget=3] [--sandbox=local|e2b] [--gate]`
> - **Gate:** `--gate` fails a language whose precision is below `targets.json`; a language with too few judged findings is not measured (exit 2).
> - **Cost:** one scan per case, stopped at `--budget` dollars of the model (default $3), 14 cases.

Each case is a repository at a commit with published advisories (VulnGym v0.1.5, Tencent, CC-BY-4.0, https://github.com/Tencent/VulnGym; the cases kept in `vulngym-cases.json` are the advisories whose class the scan looks for: authorization, injection, SSRF, data exposure). The runner calls production's `SecurityScanEngine.run`, the same call the job makes, over production's sandbox (`--sandbox=e2b` also runs the reproduction tests), with the model routed the way an org's BYOK model is routed (`evals/shared/model-route.js`) and the job's spend meter.

A finding matches an advisory when it is of the advisory's class and lands in a file of the advisory's path (the vulnerable operation, the entry point or a step between) within 15 lines; another class at the same place goes to a person like any off-list finding. `--rescore` matches a saved run again with the current rule. Recall is the share of in-scope advisories matched. Precision needs a judgment the dataset cannot give: a finding off the list may be a real vulnerability nobody published. The result lists every off-list finding with its key; a person reads the code and records `real` or `false` under that key in `adjudications.json`. Precision is (matched + judged real) over (matched + judged); unjudged findings are reported, never counted. A sample is enough: the gate needs `minJudgedPerLanguage` judged findings per language (`targets.json`).

What a green number does not prove: the cases are TypeScript, Python and Go. The scan's heuristics cover every language kodus-graph parses; a language with no case here is not measured.

## Runner boundaries and saved judgments

The eval calls production's engine, fingerprint function and `SCAN_MAX_UNITS`.
It does not run the database job or 20-minute sandbox hand-offs; one sandbox
holds a case until it finishes or reaches the same request-level spend cap.
Production persists the plan, progress, identities and conservative spend
between slices; processor contract tests cover that boundary. Local runs
attach no reproduction test; use `--sandbox=e2b` to execute it.
Per-repository results include map errors, coverage and calls by task. A green
wiring smoke requires completed lenses and a verifier call, not only a map.

VulnGym scoring assigns a finding to at most one advisory and an advisory to
at most one finding, including `--rescore`. Unassigned findings need judgment.
Judgment keys include the start line. The legacy verdicts lacked source runs,
lines and judge provenance and were removed instead of guessed; their count
is recorded in `adjudications.json`. New judgments must record the source
result's hash, judge and date in `_metadata`. Scores before this migration
are not comparable to scores after it without rescoring the original output.

`--set=negative` scans the three pinned library controls in `clean-controls.json`
with the same engine and limits. `--gate` fails if a control reports a finding;
inspect that finding against its pinned source before labelling it false.
Runs record the engine commit, dirty state, dataset hashes, served model and
measurement time. `--rescore` keeps the original measurement provenance.
