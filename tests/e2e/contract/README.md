# Contract tests

The middle tier of the test pyramid for provider integrations, between the
fast, hermetic unit specs (`libs/**/*.spec.ts`, mocked, run on every commit)
and the full e2e matrix (`tests/e2e/scenarios/`, a real Kodus backend + a
real LLM, run on schedule / release gate).

**What this tier is for:** pinning the assumption a unit test's mock is
built on against the REAL provider API — not re-running our own logic. A
unit test can only be as correct as its mocked API shape; if the real API's
shape ever drifts, only a test that actually calls it will notice. Every
test here exists because a specific bug was traced back to a wrong
assumption about how a provider's API behaves:

- `azure-thread-shape.contract.test.ts` — Azure DevOps thread/comment
  grouping (the bug: a brand-new `@kody` mention, the root comment of a
  fresh thread, was never found because the resolver only searched
  `.replies`).
- `bitbucket-comment-shape.contract.test.ts` — Bitbucket's plain
  comments-list endpoint returns the acknowledgment and the real answer
  with identical shape (the bug: the e2e poll returned the ack as if it
  were Kody's terminal answer — a false green).
- `gitlab-discussion-shape.contract.test.ts` — GitLab wraps a plain,
  unpositioned note into a one-note discussion (the assumption that let
  `postReviewCommentAs` skip GitHub-style diff-positioning for GitLab).

**No LLM calls, no Kodus backend.** These call the real provider REST APIs
directly (same test credentials as `tests/e2e/scenarios/`), open a
throwaway PR/MR on the same fixture repo/branch (`refactor/use-map-storage`
→ `main`, confirmed mirrored across all four providers), assert the raw
API shape, and clean up. Cheap and fast relative to the full matrix —
no VM provisioning, no droplet, no model billing — but NOT free (real API
calls against real fixture repos), and NOT hermetic (needs live
credentials), which is why this is a separate `test:contract` script, not
folded into the default `test` glob.

## Running

Needs the same provider credentials as the e2e scenarios
(`GL_TEST_TOKEN`/`GL_TEST_REPO`, `BB_TEST_USER`/`BB_TEST_APP_PASSWORD`/
`BB_TEST_REPO`, `AZ_TEST_TOKEN`/`AZ_TEST_ORG`/`AZ_TEST_PROJECT`/
`AZ_TEST_REPO` — see `tests/e2e/README.md`'s env var table). A test skips
cleanly (not fail) when its provider's credentials aren't set.

```bash
pnpm run test:contract
```

## Adding one

Only add a contract test when a bug was (or would have been) caused by a
wrong assumption about a REAL API's shape/behavior — not for coverage's
own sake, and not to re-verify logic a unit test already pins. If the fix
was purely internal (our code mishandled data it already had correctly),
that's a unit test, not a contract test.
