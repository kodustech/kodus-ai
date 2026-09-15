<!--
  Thanks for sending a PR! The PR title MUST follow Conventional Commits, e.g.
    feat(code-review): add agent-first reviewer
    fix(web): block app.kodus.io from search-engine indexing
    chore(deps): bump posthog-node to 4.x
  CI will fail otherwise.
-->

## Summary

<!-- 1–3 sentences. What changes for the user (or for us, if internal)? -->

## Eval evidence

<!--
  Required when the PR touches libs/code-review, libs/agent-harness, libs/kodyRules,
  libs/ee/codeReview, libs/ee/kodyRules or evals/. Keep it here, right under Summary:
  the review rule only reads the first 1000 characters of this description.
  Delete the section otherwise.
-->

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
