# Coding-agent instructions eval

> - **Answers:** Does the generalist report changes that break the repository's coding-agent instructions (CLAUDE.md), quoting them, without inventing violations or leaking the label when the setting is off?
> - **Runs:** every engine PR, against the scripted model (`evals/wiring-smoke.js`). Not gated in CI.
> - **Run it:** `pnpm eval:repo-instructions` · `node evals/repo-instructions/run.js --model=gpt-5.4 --arm=both`
> - **Gate:** none yet. A floor needs two calibration runs of the same commit, per `evals/AGENTS.md`.
> - **Cost:** two generalist runs per case (instructions on and off) with a real model; none under the scripted model.

The generalist reads the coding-agent instructions that cover a pull request's changed files (`libs/code-review/infrastructure/agents/collaborators/repo-instructions.ts`) and may report a finding labeled `repo_instruction`. This eval measures that finding type.

## Cases

Built at run time by `evals/repo-instructions/cases.js` from the committed kody-rules GitHub cases (`evals/kody-rules/github-cases.json`): real merged PRs whose violations of a convention are enumerated line by line. Each case gets a `CLAUDE.md` that states the convention the PR breaks, plus a decoy instruction (pnpm, lockfiles) the diff never touches. The diffs, files and violation sites are real; the instruction text is written by the builder.

## What it reports

With instructions on:

- **precision**: `repo_instruction` findings on a real violation site (same file, line within 2) over all `repo_instruction` findings.
- **occurrenceRecall**: violation sites covered by a `repo_instruction` finding.
- **citationRate**: `repo_instruction` findings that name `CLAUDE.md` and repeat the convention verbatim (20+ characters).
- **decoyHits**: `repo_instruction` findings about the decoy. Should be 0.
- **otherFindings**: bug, security and performance findings, to compare with the off arm.

With instructions off:

- **leakedInstructionLabels**: findings labeled `repo_instruction`. Must be 0.
- **otherFindings**: the baseline for the on arm.

Bug recall with instructions on is covered by finder-recall (`evals/investigation/README.md`) on the same engine; this eval does not repeat it.

## Exit codes

0 measured, 2 infra (more than 5% of runs failed, reason logged). There is no quality failure exit until a floor exists.
