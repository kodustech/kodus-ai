---
name: kodus-review-dev
description: Use when the user wants Kodus to review local changes through a local CLI build or non-production API such as `node dist/index.js`, localhost, or QA, including local `--prompt-only` flows.
---

# Kodus Review (Dev)

## Goal

Use the local Kodus CLI build in this repository to review changes and resolve issues. Prefer machine-friendly output via `--prompt-only`, then apply fixes in code.

If the request is to validate local changes against business rules, task requirements, or acceptance criteria, use `kodus-business-rules-validation` instead. The local review command does not trigger local business validation.

## Trigger Hints

- Treat mentions of `review`, `commit`, `push`, `open PR`, `merge`, `quality gate`, or `ready to ship` as triggers for this skill.
- For commit/push/merge requests, proactively ask to run local Kodus review first when a fresh review has not run yet in the current task.

## Workflow

1. Ensure local dev command is available.

- Prefer the helper script (do not rely on aliases).
- Use: `skills/kodus-review-dev/scripts/run-local-cli.sh --help`.
- If missing or failing, ask the user to confirm the local path and env values, then stop.

2. Ensure authentication if required.

- If the review fails with auth, ask the human to authenticate with `kodus auth login` in their terminal, then retry after they confirm.
- For team keys, use `auth team-key --key <key>` with the same helper script when provided by the user.

3. Run review using prompt-only output.

- Default: `skills/kodus-review-dev/scripts/run-local-cli.sh review --prompt-only`.
- If user specifies files: append `<files...>`.
- If user asks for staged/commit/branch: add `--staged`, `--commit <sha>`, or `--branch <name>`.
- If user wants fast: add `--fast`.

4. Parse results and apply fixes.

- Use the output to locate files and lines.
- Make minimal, targeted changes to address each issue.
- If an issue is not actionable or is a false positive, explain why and skip.

5. Re-run review if needed.

- After fixes, rerun `skills/kodus-review-dev/scripts/run-local-cli.sh review --prompt-only` to confirm issues are resolved.

## Notes

- Prefer `--prompt-only` for predictable parsing.
- Avoid `--interactive` unless the user explicitly asks.
- Redirect PR-vs-task validation requests to `kodus-business-rules-validation`.
- The helper script respects `KODUS_API_URL`, `KODUS_VERBOSE`, and `KODUS_CLI_ENTRYPOINT`.
- Do not use `--fix` unless the user explicitly asks.
