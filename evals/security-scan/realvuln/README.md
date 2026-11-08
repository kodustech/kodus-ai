---
license: mit
language:
  - en
  - code
task_categories:
  - text-classification
  - token-classification
tags:
  - security
  - vulnerability-detection
  - sast
  - code
  - python
  - benchmark
  - cwe
pretty_name: RealVuln
size_categories:
  - n<1K
configs:
  - config_name: findings
    data_files: findings.jsonl
    default: true
  - config_name: repos
    data_files: repos.jsonl
  - config_name: scan_results
    data_files: scan_results.jsonl
---

# RealVuln

Ground-truth vulnerability labels for 26 intentionally-vulnerable Python repositories, plus scanner outputs from 16 security tools (rule-based SAST, general-purpose LLMs, and security-specialized agents).

Companion dataset for the paper **"RealVuln: Benchmarking Rule-Based, General-Purpose LLM, and Security-Specialized Scanners on Real-World Code"** ([arXiv:2604.13764](https://arxiv.org/abs/2604.13764)).

## Dataset summary

| Split | Rows | Description |
|-------|------|-------------|
| `findings` | 796 | Human-labeled vulnerabilities and FP traps |
| `repos` | 26 | Repository metadata (URL, commit SHA, language, framework) |
| `scan_results` | 12,684 | Raw scanner outputs across 16 scanners |

- **676** confirmed vulnerabilities + **120** false-positive traps (`is_vulnerable: false`)
- **73** unique primary CWEs across 26 repositories
- Every finding includes a `primary_cwe` and an `acceptable_cwes` list for tolerant matching
- All labels are human-authored (`manual_review` source)

## Usage

```python
from datasets import load_dataset

findings = load_dataset("Kolega-Dev/RealVuln", "findings", split="train")
repos    = load_dataset("Kolega-Dev/RealVuln", "repos",    split="train")
scans    = load_dataset("Kolega-Dev/RealVuln", "scan_results", split="train")

# Pull vulnerabilities for one repo
pygoat = findings.filter(lambda r: r["repo_id"] == "pygoat")

# Join scanner findings to ground truth on (repo_id, file)
```

The actual vulnerable source code is not redistributed here. Each row in `repos` provides the `repo_url` and `commit_sha` so you can clone the exact revision used for labeling.

## Schema

### `findings.jsonl`

| Field | Type | Notes |
|-------|------|-------|
| `repo_id` | string | Join key against `repos.jsonl` and `scan_results.jsonl` |
| `finding_id` | string | Stable identifier within the repo |
| `is_vulnerable` | bool | `false` rows are FP traps — a scanner flagging these is penalized |
| `vulnerability_class` | string | e.g. `sql_injection`, `xss`, `path_traversal` |
| `primary_cwe` | string | e.g. `CWE-89` |
| `acceptable_cwes` | list[string] | Scanner CWE matches any entry in this list |
| `file` | string | Path relative to the repo root |
| `start_line`, `end_line` | int | Vulnerability location, ±10 line tolerance when matching |
| `function` | string \| null | Enclosing function if known |
| `severity` | string | `low` / `medium` / `high` / `critical` |
| `expected_category` | string | Coarse grouping for per-category metrics |
| `source` | string | Provenance of the label (`manual_review`) |
| `cve_id` | string \| null | Linked CVE where applicable |
| `description` | string | Explanation of the flaw |
| `manually_verified` | bool \| null | Human verification flag |
| `poc` | string \| null | Proof-of-concept payload or exploit steps |

### `repos.jsonl`

Repository metadata: `repo_id`, `repo_url`, `commit_sha`, `language`, `framework`, `loc`, `type`, `authorship` (human / LLM / mixed), `authorship_model`, `authorship_confidence`, `authorship_evidence`, `schema_version`.

### `scan_results.jsonl`

One row per scanner finding, across 16 tools. Deterministic scanners produce one pass (`run: null`); stochastic agentic scanners were evaluated across three runs (`run: "run-1" | "run-2" | "run-3"`).

| Field | Type | Notes |
|-------|------|-------|
| `repo_id` | string | Join key |
| `scanner` | string | Scanner identifier (e.g. `semgrep`, `kolega-v0.0.1`) |
| `run` | string \| null | `run-N` for stochastic scanners, `null` otherwise |
| `check_id` | string | Scanner-specific rule ID |
| `file` | string | Reported path |
| `start_line`, `end_line` | int | Reported location |
| `severity` | string | Scanner-reported severity |
| `message` | string | Human-readable description from the scanner |
| `cwe` | string \| null | Primary CWE reported by the scanner |
| `all_cwes` | list[string] | All CWEs in the scanner metadata |
| `finding_id` | string \| null | Scanner-assigned finding ID if present |

### `cwe_families.json`

CWE groupings used for per-category metrics. Structure: `{ family_name: { "cwes": [...], "label": "..." } }`.

## Scanners evaluated

Rule-based SAST: `semgrep`, `snyk`, `sonarqube`.
General-purpose LLMs (agentic, 3 runs each): `claude-haiku-4-5-v1`, `claude-haiku-4-5-agentic-v1`, `claude-sonnet-4-6-agentic-v1`, `claude-opus-4-6-agentic-v1`, `gemini-3.1-pro-agentic-v1`, `grok-3-agentic-v1`, `grok-4.20-reasoning-agentic-v1`, `kimi-k2.5-agentic-v1`, `minimax-m2.7-agentic-v1`, `qwen-3.5-397b-agentic-v1`, `glm-5-agentic-v1`.
Security-specialized: `kolega-v0.0.1`, `seclab-taskflow-agent-v1`.

## Scoring

The benchmark's primary metric is F3 (recall-weighted, β=3), motivated by the cost asymmetry between missed vulnerabilities and false positives in security settings. F1 and F2 are also reported. A scanner finding matches a ground-truth entry when:

1. File path matches
2. Reported CWE appears in the GT entry's `acceptable_cwes`
3. Reported line is within ±10 lines of the GT `start_line` / `end_line`

Full scoring pipeline and dashboard in the [GitHub repository](https://github.com/kolega-ai/Real-Vuln-Benchmark).

## Citation

```bibtex
@article{realvuln2026,
  title  = {RealVuln: Benchmarking Rule-Based, General-Purpose LLM, and Security-Specialized Scanners on Real-World Code},
  author = {Pellew, John and Raza, Faizan},
  year   = {2026},
  eprint = {2604.13764},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CR}
}
```

## Links

- GitHub: https://github.com/kolega-ai/Real-Vuln-Benchmark
- Paper: https://arxiv.org/abs/2604.13764
- Live leaderboard: https://kolega-ai.github.io/Real-Vuln-Benchmark/

## License

MIT. Scanner outputs are reproduced from their respective tools under fair use for benchmarking. The vulnerable repositories themselves retain their upstream licenses and are referenced by URL+SHA rather than redistributed.
