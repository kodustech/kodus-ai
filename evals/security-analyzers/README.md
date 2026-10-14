# Do the deterministic analyzers find what the reviewer misses?

> - **Answers:** Does a deterministic analyzer catch vulnerabilities the LLM reviewer does not? Scoring a scanner in isolation cannot answer that — a finding the reviewer already makes is a duplicate, not new evidence.
> - **Runs:** on demand, not in CI. It costs real model calls and the corpora are built by hand; it ran to decide which analyzers to ship and is kept as the record of that decision.
> - **Run it:** `node evals/security-analyzers/llm-vs-analyzers.js` · `node evals/security-analyzers/agent-path.js`
> - **Gate:** none. This is a measurement, not a regression gate — no threshold blocks a PR on it.
> - **Cost:** one security-review call per sample, per run, against a live model. The 90-sample corpus exhausted a credit balance mid-run; see the caveat below.

**The rule pack this compares against was removed** after these measurements
(`libs/code-review/infrastructure/analyzers/` now ships only the secret and
dependency scans). The rule-pack numbers below are kept because they are the
evidence for that removal — but the command to reproduce them is gone with it.

The security benchmark (`scripts/security-benchmark/`) scores analyzers in
isolation. That is not the question the feature has to answer: a finding the
LLM reviewer already makes is not new evidence, it is a duplicate. The value of
an analyzer is what it catches that the reviewer does not.

This runs the production security review prompt over the same 66 published
vulnerabilities the benchmark uses, and crosses the two.

```bash
# analyzer detections first, per sample
node scripts/security-benchmark/run.mjs scripts/security-benchmark/dataset.json \
    --name betterleaks --json /tmp/bl.json \
    --tool "betterleaks dir {dir} --report-format sarif --report-path {out} --no-banner --exit-code 0"

node evals/security-analyzers/llm-vs-analyzers.js --analyzers=/tmp/bl.json
node evals/security-analyzers/llm-vs-analyzers.js --tranche=noise
```

## Result (claude-sonnet-4-6)

| | recall, 66 vuln | quiet on 14 noise |
|---|---|---|
| LLM security review | **56/66 (84.8%)** | 13/14 |
| Kodus rule pack | 8/66 (12.1%) | 14/14 |
| betterleaks | 6/66 (9.1%) | 13/14 |
| analyzers combined | 14/66 (21.2%) | — |

Crossing them:

```
both              14
analyzer ONLY      0     <- no incremental recall
LLM ONLY          42
neither           10
```

**Every analyzer detection was already found by the reviewer.** On this corpus
the analyzers add no recall, and their precision advantage is within noise on
n=14. Under dilution (below) the secret scan alone recovers one or two
detections of 66; the rule pack recovers none at any size.

## What this does NOT settle

Every sample is application source code, so only the rule pack and the secret
scan can fire. The result says nothing about the five analyzers that need file
types this corpus does not contain — workflows, IaC, lockfiles, OpenAPI,
protobuf.

That distinction matters most for **dependencies**. `osv-scanner` answers a
factual question — is this exact package version named in an advisory database
— which a model cannot answer reliably from a diff at all. Pattern-matching
rules compete with the reviewer on its own ground; a database lookup does not.
The categories worth keeping are the ones doing something the reviewer
structurally cannot, not the ones doing it slightly more cheaply.

## Three checks on the result

Raised in review: the corpus might be favouring the model. All three were run.

**1. Training-data contamination.** 60 of the 66 samples carry a GHSA id with a
publication date; 39 were published in Aug–Sep 2026, after any plausible
training cutoff.

| cohort | n | LLM | analyzers | analyzer-only |
|---|---|---|---|---|
| published Aug–Sep 2026 | 39 | 84.6% | 15.4% | 0 |
| published Jun 2026 onward | 51 | 84.3% | 13.7% | 0 |
| published before Jun 2026 | 9 | 77.8% | 11.1% | 0 |

The model does slightly *better* on the newest advisories. Contamination does
not explain the result.

**2. Sample size favouring the model.** An inverted fix is one to eight files,
all about the vulnerability. `scripts/security-benchmark/dilute.mjs` plants each
one inside real changed files drawn from sampled public PRs, shuffled so
position carries no signal.

| files per sample | LLM recall | analyzer-only |
|---|---|---|
| 1–8 (original) | 84.8% | 0 |
| 25 | 72.7 / 74.2 / 77.3% | 1 / 2 / 1 |
| 50 | 69.7 / 68.2% | 1 / 1 |

This objection was right about the effect and wrong about the conclusion. The
reviewer really does degrade with pull-request size — roughly 16 points from 8
files to 50 — but that does not rescue the analyzers. Analyzer-only plateaus at
one or two of 66, and **every single one is a secret** (`private-key-block`,
`aws-access-key`). The rule pack contributes zero analyzer-only detections at
every dilution level.

**3. Run-to-run variance.** Four runs of the undiluted corpus:

```
caught in ALL runs   54      the 14 analyzer-detected samples:
caught in SOME runs   7        caught by the LLM in all 4 runs  14
caught in NO run      5        caught only sometimes             0
```

Of the 7 samples the reviewer catches inconsistently, analyzers detect **zero**.
The unstable set is precisely where the analyzers are also blind, so "the rule
catches it every time" does not apply to anything the rule catches.

## The real-PR corpus — this reverses the result

Every corpus above is constructed. `scripts/security-benchmark/build-real-pr-corpus.mjs`
builds the one that is not: for each advisory it blames the vulnerable lines at
the commit before the fix, finds the pull request whose commit wrote them, and
takes that pull request's real diff. The vulnerable lines are then located
inside it BY CONTENT, and a sample is dropped unless they are genuinely among
the lines that PR added. 28 samples survive from 60 advisories, mean 45 files,
padded only with other merged PRs from the same repository.

```
                     LLM (3 runs)      rule pack     analyzer-only
real introducing PRs  1 / 1 / 0 of 28   3 of 28       3, every run
```

`both` is 0 and `neither` is 24–25. The rule pack's three detections are
credited to the right rules — command-injection on the command-injection
sample, SSRF on SSRF, deserialization on deserialization — and it stays clean on
all 14 noise samples.

### Why every earlier corpus flattered the model

The targets are equally strict in both — median 2 expected lines. What differs
is the haystack:

| corpus | added lines per sample (median) |
|---|---|
| inverted fix commit | **3** |
| real introducing PR | **916** (mean 2122, max 16106) |

The original asks the model to pick 2 vulnerable lines out of 3 added. A real
pull request asks it to pick 2 out of roughly 900. Diluting with extra FILES
does not fix this, which is why that test only moved the number from 84.8% to
68%: the vulnerable file still carried a tiny, conspicuous hunk. In a real PR
the flaw is buried inside a large legitimate change to the same file.

### Scaled to 90 samples — and the reversal softens

211 advisories in, **90 real-PR samples out**, across 72 repositories and all
10 CWE classes, mean 39 files each.

```
                  LLM (1 run)   rule pack   both   LLM-only   analyzer-only   neither
90 real PRs        6 of 90       6 of 90      2       4             4            80
```

At n=28 the analyzers appeared to beat the reviewer outright (3 vs 1, with
analyzer-only 3 and LLM-only 0). At n=90 they are **level, and complementary**:
the same 6.7% each, but only 2 of the 12 detections overlap. Each side finds
four the other never does.

That is a third distinct conclusion, and it is the one the largest and most
realistic corpus supports:

| corpus | what it said |
|---|---|
| inverted fix commit, 1–8 files | analyzers wholly redundant (analyzer-only 0) |
| real PRs, n=28 | analyzers clearly ahead (3 vs 1) |
| real PRs, n=90 | level and complementary (6 vs 6, 2 overlapping) |

The rule pack's 6 are credited to matching rules — SSRF on SSRF, deserialization
on deserialization, command injection on command injection — and it stays clean
on all 14 noise samples. betterleaks scores 0 because the synthetic secret
samples carry no advisory and so have no introducing PR.

**The honest caveat is large: this is ONE model run.** The Anthropic credit
balance ran out during run 2 (66 hard errors) and run 3 (90), and a fallback to
Google returned a project billing denial on all 90. Runs 2 and 3 reported
`LLM 0/90` purely because every call failed — a failure that reads exactly like
a result, which is why the error counts are checked rather than the headline.
Run 1 also had 7 unparseable replies, so its 6/90 is a slight undercount.

Both sides finding under 7% is the other thing worth saying plainly: 80 of 90
real vulnerabilities were found by neither.

### Through the production prompt path — the reversal disappears

`agent-path.js` runs the same corpus through production's own
`buildSelfContainedSystemPrompt` / `buildSelfContainedUserPrompt` with the real
`SecurityAgentProvider` identity, splits files with `chunkFilesByTokenBudget`,
and parses the `{reasoning, suggestions[]}` contract the real prompt demands.
`llm-vs-analyzers.js` does none of that — one call, whole diff, category prompt
only — while the analyzer side is production code in both. That asymmetry was
doing nearly all the work.

```
                         LLM      analyzers   both   LLM-only   analyzer-only
ad-hoc prompt, n=90       6         6           2       4           4
production prompt, n=81  37         6           5      32           1
```

(81 excludes 9 samples where a chunk call failed; none of those 9 detected, so
37 is a floor.)

The analyzers' apparent advantage on real PRs was an artifact of how the
reviewer was being prompted. With the production prompt the rule pack adds
**one** detection in 90 that the reviewer does not already make — a PHP unsafe
deserialization.

The jump is not just kinder scoring. `agent-path.js` scores a line RANGE
(production emits `relevantLinesStart`/`End`) where the older eval matched a
single line, so the two are confounded — but FILE-level hits, which are scored
identically in both, went from 35/90 to 56/90. The prompt is genuinely finding
more, not merely being credited more.

Still missing, so 37 remains a floor: the agent's tool loop (no sandbox here),
the other four agents, and the post-processing.

### Checks on the reversal

- **Not a context limit.** Misses are not concentrated in big diffs: on samples
  under 50k characters the model hit 0 of 10 expected lines.
- **Not a scoring artifact.** Expected-set sizes match the original corpus.
- **The failure is localisation.** The model flags the right FILE in 14 of 28
  and the right lines in 1 — the same right-neighbourhood-wrong-thing pattern
  seen in the undiluted misses.
- **Both are poor in absolute terms.** 24 of 28 real vulnerabilities are found
  by neither, so this is not an argument that the analyzers work well.
- n=28 is small, and betterleaks scores 0 here because the synthetic secret
  samples carry no advisory and so have no introducing PR to find.

## Fidelity

The production agent investigates the repository with tools; this issues a
single pass over the diff. Samples are one to eight files centred on a
vulnerability, so there is little repository to investigate — but the LLM
number here is a floor, not a ceiling, which makes the zero above stronger
rather than weaker.
