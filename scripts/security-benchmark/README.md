# Security benchmark

A benchmark for **deterministic security analyzers**, separate from the
code-review benchmark in `scripts/benchmark/`.

## Why it exists

The 50-PR code-review benchmark is a *logic-bug* corpus — nil dereferences,
wrong variable used, races, API contract violations. It contains **zero secrets
and zero vulnerable dependencies**, so it cannot score a security analyzer at
all. Measuring one against it produces a number that means nothing.

It is also the wrong shape for the failure mode we actually measured. Running
stock rule packs over those 50 PRs produced **38 in-diff findings for 1 true
positive**; gitleaks produced **11 findings, all false**. Our problem is
precision, not recall — so this benchmark scores both.

## What's in it

| Tranche | Count | Measures |
|---|---|---|
| `vuln` | 60 | Recall — can the tool find a real, published vulnerability? |
| `noise` | 11 | Precision — does the tool stay quiet on code that only *looks* dangerous? |

**Vulnerability samples** are built by inverting the fix commit of a published
GitHub advisory. The resulting diff *introduces* the vulnerability as added
lines — the exact shape a reviewer sees on a pull request, and the shape
diff-clipping needs. 10 CWE classes a pattern matcher can plausibly detect,
across 9 languages and 49 distinct repositories.

Classes deliberately excluded: races, auth logic errors, and anything needing
whole-program reasoning. Those belong to the LLM reviewer; seeding them here
would measure the wrong thing.

**Noise samples** are modelled on the false positives we actually observed —
predominantly text that *names* a credential rather than containing one
(`register("system.secret-key", ...)`, an i18n entry `"disable_2fa": "Disable
two-factor authentication"`) — plus near-miss negatives: argument-array
subprocess calls, parameterized SQL, constant-time digest comparison, a fetch
of a frozen constant URL. Every value is synthetic; nothing here is or
resembles a live secret.

Diffs are stored **inline** in `dataset.json`, so the benchmark stays
reproducible when upstream repositories rewrite history or disappear. It needs
no network, no forks, no Kody run, and no MongoDB — a full pass is seconds.

## Running it

```bash
# Rebuild the dataset (needs `gh` auth; hits the advisories API)
node scripts/security-benchmark/build-dataset.mjs \
    scripts/security-benchmark/dataset.json --per-cwe 6

# Score a tool. The template gets {dir} (tree to scan) and {out} (SARIF path).
node scripts/security-benchmark/run.mjs scripts/security-benchmark/dataset.json \
    --name "my rule pack" \
    --tool "opengrep scan --config ./rules --sarif --output {out} --quiet {dir}"

# Tools that print SARIF to stdout can omit {out}:
node scripts/security-benchmark/run.mjs scripts/security-benchmark/dataset.json \
    --name "gitleaks" \
    --tool "gitleaks dir {dir} --report-format sarif --report-path /dev/stdout --no-banner --exit-code 0"
```

Use `{out}` unless you have checked the tool really writes to stdout — opengrep
accepts `--output /dev/stdout` and silently produces nothing.

Add `--json out.json` for the per-sample breakdown.

## How scoring works

Findings are clipped to lines the diff **adds** before scoring — the same
treatment the review pipeline gives analyzer output.

- **Recall** comes from the `vuln` tranche: did the tool flag the vulnerable
  region at all?
- **Precision** comes from the `noise` tranche **alone**.

That split is deliberate. On a vulnerability sample, `expected` is *every*
added source line, so any in-diff finding there scores as a hit by
construction — a precision ratio computed across both tranches would be
guaranteed high and mean nothing. An earlier version of this script reported
90.9% precision that way; it was an artifact.

`VERBOSITY` (findings per vulnerability sample) is the other half of the noise
picture: a tool that flags every sample everywhere will look good on recall and
should be caught here.

The run also prints **which rules earned each detection**. Read that list. A
maintainability rule landing on a vulnerable line counts as a hit under this
scoring but is not a real detection — the current broad-pack baseline is
credited once for `python.lang.best-practice.open-never-closed` on a path
traversal, which is exactly that.

## Baseline

Broad opengrep language packs (~1,900 rules), the configuration the spike
showed to be unusable in production:

```
RECALL    6/60   (10.0%)
PRECISION 10/11 noise samples clean
VERBOSITY 0.17 findings per sample
```

Detected: XSS 2/6, command injection 1/6, path traversal 1/6, unsafe
deserialization 1/6, XXE 1/6. Nothing on SQL injection, SSRF, hardcoded
credentials, weak crypto, or code injection.

A curated pack has to beat this on recall without spending the noise budget.

## Known limitations

- **`expected` lines are every line the fix touched**, not a hand-audited
  "this exact line is the vulnerability". Recall is therefore generous about
  *where* a tool fires, and the credited-rules list is the only check on
  whether it fired for the right reason.
- **Advisory summaries stand in for golden comments.** They describe the
  vulnerability class accurately but are not written like review comments, so
  they are not comparable to the code-review benchmark's goldens.
- **The noise tranche is small (11) and does not currently trip gitleaks**,
  which scores 0 detections and 0 false findings across the whole dataset. Its
  real-world false positives came from large files with genuinely high-entropy
  strings elsewhere; these small synthetic samples do not reproduce that. Treat
  gitleaks' score here as uninformative rather than good.
- **Precision here is kinder than production.** Each sample is one to eight
  files centred on a vulnerability; a real PR carries far more unrelated code
  for a rule to trip over. The spike measured 38 in-diff findings for 1 true
  positive on real PRs. Use `scripts/benchmark/` for production-shaped
  precision, and this for whether a rule pack can detect anything at all.
- Samples are only as good as the advisory's fix commit. A fix that also
  refactors carries unrelated lines into `expected`. The builder caps changed
  lines at 120 to limit this.
