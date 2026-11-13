# security-scan

> - **Answers:** Of the published vulnerabilities in a repository, how many does a security scan capped at a few dollars report, and of what it reports, how much is real?
> - **Runs:** on demand, before a change to the scan ships (`libs/security-scan/`).
> - **Run it:** `node evals/security-scan/run.js --model=deepseek-v4-flash@fireworks [--cases=<id,...>] [--budget=3] [--sandbox=local|e2b] [--gate]`
> - **Gate:** `--gate` fails a language whose precision is below `targets.json`; a language with too few judged findings is not measured (exit 2).
> - **Cost:** one scan per case, stopped at `--budget` dollars of the model (default $3), 14 cases.

Each case is a repository at a commit with published advisories (VulnGym v0.1.5, Tencent, CC-BY-4.0, https://github.com/Tencent/VulnGym; the cases kept in `vulngym-cases.json` are the advisories whose class the scan looks for: authorization, injection, SSRF, data exposure). The runner calls production's `SecurityScanEngine.run`, the same call the job makes, over production's sandbox (`--sandbox=e2b` also runs the reproduction tests), with the model routed the way an org's BYOK model is routed (`evals/shared/model-route.js`) and the job's spend meter.

A finding matches an advisory when it is of the advisory's class and lands in a file of the advisory's path (the vulnerable operation, the entry point or a step between) within 15 lines; another class at the same place goes to a person like any off-list finding. `--rescore` matches a saved run again with the current rule. Recall is the share of in-scope advisories matched. Precision needs a judgment the dataset cannot give: a finding off the list may be a real vulnerability nobody published. The result lists every off-list finding with its key; a person reads the code and records `real` or `false` under that key in `adjudications.json`. Precision is (matched + judged real) over (matched + judged); unjudged findings are reported, never counted. A sample is enough: the gate needs `minJudgedPerLanguage` judged findings per language (`targets.json`).

What a green number does not prove: the cases are TypeScript, Python and Go. The scan's heuristics cover every language kodus-graph parses; a language with no case here is not measured.
