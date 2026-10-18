# Coding-agent instructions eval

> - **Answers:** Does the review post changes that break the repository's coding-agent instructions (CLAUDE.md), quoting them, without inventing violations or leaking the label when the setting is off?
> - **Runs:** every engine PR against the scripted model (`evals/wiring-smoke.js`); nightly on DeepSeek on the controlled set when one of its files changed, and weekly on every tier-0 model (`evals/nightly-evals.js`).
> - **Run it:** `node evals/repo-instructions/run.js --model=deepseek-v4-flash@fireworks [--set=controlled|full] --gate --output=<result.json>`
> - **Gate:** `--gate` fails below the floor for the model and set in `evals/repo-instructions/targets.json` (violation sites the review posts with the setting on), and on any `repo_instruction` finding with the setting off; a model or set with no floor exits 2, not gated. The result is the shared shape (`evals/shared/eval-result.js`).
> - **Cost:** two production reviews per case (instructions on and off) on a real checkout of the PR, with a real model; none under the scripted model.

The generalist reads the coding-agent instructions that cover a pull request's changed files (`libs/code-review/infrastructure/agents/collaborators/repo-instructions.ts`) and may report a finding labeled `repo_instruction`. Those findings go through the review's severity and quantity filters like any other: the setting lets Kody read the files, it does not override the team's posting threshold. This eval measures what reaches the PR under the team's default settings.

## Cases

Built at run time by `evals/repo-instructions/cases.js` from the committed kody-rules GitHub cases (`evals/kody-rules/github-cases.json`): real merged PRs whose violations of a convention are enumerated line by line, with the PR as the platform returns it. Each case's target branch gets a `CLAUDE.md` that states the convention the PR breaks, plus a decoy instruction (pnpm, lockfiles) the diff never touches; the team turns the setting on. The diffs, files and violation sites are real; the instruction text is written by the builder.

Sets (`CASE_SETS` in `cases.js`): `controlled`, one case per repository and convention, the nightly and every model's weekly run; `full`, every case, on demand.

## What it reports

With instructions on:

- **occurrenceRecall** (the gated number): violation sites covered by a `repo_instruction` finding the review posts (same file, line within 2).
- **loopOccurrenceRecall** (`reported`, not gated): the same over the finder's own findings, before the review's filters. The diagnostic for where findings are lost.
- **shippedRate**: posted `repo_instruction` findings over the finder's. The finder rates a convention break `low`, so the default `medium` severity filter drops most of them.
- **precision**: posted `repo_instruction` findings on a real violation site over all posted ones.
- **citationRate**: posted `repo_instruction` findings that name `CLAUDE.md` and repeat the convention verbatim (20+ characters).
- **decoyHits**: posted `repo_instruction` findings about the decoy. Should be 0.
- **otherFindings**: bug, security and performance findings, to compare with the off arm.

With instructions off:

- **leakedInstructionLabels**: findings labeled `repo_instruction`. Must be 0.
- **otherFindings**: the baseline for the on arm.

Bug recall with instructions on is covered by finder-recall (`evals/investigation/README.md`) on the same engine; this eval does not repeat it.

## Exit codes

0 measured and at or above the floor, 1 below the floor or a leak (`--gate`), 2 not measured (more than 5% of runs failed, no floor for the model and set, or the result breaks the shared shape).
