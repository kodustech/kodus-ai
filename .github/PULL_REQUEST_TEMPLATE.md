<!-- Title: Conventional Commits, e.g. fix(web): block indexing. CI fails otherwise. -->

## Summary

<!-- 1–3 sentences. What changes for the user (or for us, if internal)? -->

## Eval evidence

<!-- Required if the PR touches libs/code-review, libs/agent-harness, libs/kodyRules, libs/ee/{codeReview,kodyRules} or evals/. Stays under Summary: the rule reads only the first 1000 chars, comments included. Delete this section otherwise. -->

- Run: <link to the code-review evals workflow run on this branch>, or `Not applicable: <concrete reason>`
- Proof (feat/perf only): <metric> on <subset>, main <value> → branch <value>
- Design: <link to the design comment on the issue>

## Changelog routing (driven by the PR title prefix)

The prefix in your PR title decides where this change appears in the public changelog. No labels needed — the title is the source of truth.

| Prefix     | Public changelog                              |
| ---------- | --------------------------------------------- |
| `feat:`    | **Improvements** section (or tied to a tracked feature, see below) |
| `fix:`     | **Bug fixes** section                         |
| `perf:`    | **Performance** section                       |
| `docs:`, `style:`, `refactor:`, `test:`, `chore:`, `ci:`, `build:` | Hidden from public changelog |

## Test plan

<!-- Bullet list of the manual / automated checks. -->

- [ ]
- [ ]

## Notes for the reviewer

<!-- Anything non-obvious. Risks, follow-ups, screenshots for UX work. -->
