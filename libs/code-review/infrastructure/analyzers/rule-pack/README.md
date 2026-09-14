# Kodus security rule pack

27 hand-written rules for the deterministic pass of code review.

## Why these are written in-house

Semgrep's registry rules are licensed for internal business use only and may
not be made available to others as a service — which is precisely what Kody
does. The `opengrep/opengrep-rules` fork carries **LGPL-2.1 + Commons Clause**,
which forbids a product whose value derives substantially from the rules.

Neither is safe to ship. These rules are ours, so the question does not arise.
The engine (opengrep, LGPL-2.1) is invoked as a subprocess, which is fine.

## Measured against `scripts/security-benchmark/`

| | Broad packs (~1,900 rules) | This pack (27 rules) |
|---|---|---|
| Vulnerabilities flagged | 6/60 (10.0%) | **8/60 (13.3%)** |
| Noise samples clean | 10/11 | **11/11** |
| Findings per sample | 0.17 | 0.32 |
| Full-dataset wall time | ~10 min | **~4 s** |
| Licensing | Commons Clause | ours |

Better on both axes with 1.4% of the rules, and fast enough to fit the ≤3s
per-review budget with room to spare. Rule loading dominates analyzer runtime,
so pack size *is* the latency budget — if this grows past ~50 rules, re-measure
before merging.

Detected classes: command injection 2/6, XSS 2/6, SQL injection 1/6, SSRF 1/6,
unsafe deserialization 1/6, XXE 1/6. Nothing yet on path traversal, hardcoded
credentials, weak crypto, or code injection.

## Design rules

**Precision first.** Every finding here is intended to be publishable without a
verifier pass, so each rule carries `pattern-not` clauses for the safe form —
argument-array subprocess calls, parameterized queries, constant URLs, escaped
output, sanitized HTML. The benchmark's noise tranche exists to keep that
honest.

**One language per rule.** A semgrep pattern must parse in *every* language the
rule declares, so a `pattern-either` mixing Python `if x:` with JavaScript
`if (x) {}` fails to load. Rules are split by language rather than grouped by
vulnerability class.

**Quote patterns containing `:`.** `shell: true` inside an unquoted YAML scalar
parses as a mapping and silently invalidates the whole file.

## Adding a rule

Re-measure before merging — a rule that adds one detection and one noise
finding is not worth it:

```bash
node scripts/security-benchmark/run.mjs scripts/security-benchmark/dataset.json \
    --name "rule pack" \
    --tool "opengrep scan --config libs/code-review/infrastructure/analyzers/rule-pack \
            --sarif --output {out} --quiet {dir}"
```

Read the `rules credited with a detection` list, not just the recall number. A
maintainability rule landing on a vulnerable line scores as a hit without being
a real detection — that is how the broad pack earned credit for
`open-never-closed` on a path traversal.
