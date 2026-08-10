# Kodus Trace — PR 1667 validation evidence

Date: 2026-08-10

Starting implementation: `b83244b1acefc436d2a473a8e8a04bb9070f9b6b`

Comparison base: `9d269f5f350fb590142f698e49c8fbb93d74ed6b`

This file records the local validation performed against issue 582. The test
fixtures use temporary repositories, temporary Trace homes, and local bare
remotes. They do not use the developer's real `~/.kodus` or agent settings.

## Definition of Done output

### `apps/cli: pnpm test`

```text
RUN  v4.1.9 /Users/gabrielmalinosqui/orca/workspaces/kodus-ai/thresher/apps/cli

Test Files  120 passed (120)
     Tests  930 passed (930)
  Duration  80.61s (transform 748ms, setup 0ms, import 2.82s, tests 70.73s, environment 5ms)
```

### `apps/cli: pnpm test:integration`

```text
RUN  v4.1.9 /Users/gabrielmalinosqui/orca/workspaces/kodus-ai/thresher/apps/cli

Test Files  1 passed (1)
     Tests  44 passed (44)
  Duration  14.69s (transform 28ms, setup 0ms, import 44ms, tests 14.58s, environment 0ms)
```

### Repository root: `pnpm test`

PostgreSQL was provided at `127.0.0.1:5432` with a dedicated migrated database,
`trace_validation_1667`.

```text
Test Suites: 8 skipped, 610 passed, 610 of 618 total
Tests:       59 skipped, 5634 passed, 5693 total
Snapshots:   8 passed, 8 total
Time:        115.877 s
Ran all test suites.
```

The skipped tests above are pre-existing. The final diff adds no disabled or
pending tests.

### Repository root: `pnpm build:apps`

```text
webpack 5.106.2 compiled successfully in 172 ms
webpack 5.106.2 compiled successfully in 417 ms
webpack 5.106.2 compiled successfully in 496 ms
webpack 5.106.2 compiled successfully in 780 ms
webpack 5.106.2 compiled successfully in 2789 ms
webpack 5.106.2 compiled successfully in 3158 ms
```

## Functional evidence map

The process-level evidence is executable and lives beside the implementation:

- `apps/cli/src/__tests__/trace-git-e2e.test.ts`: compiled CLI, generated real
  `pre-push` hooks, non-checked-out refs, renamed refs, multi-ref pushes, tags,
  deletions, direct Trace pushes, recursion count, and detached timing.
- `apps/cli/src/__tests__/process-e2e.test.ts`: local-only lifecycle, retry
  buffer, HTTP bodies, model stdin, local records, branch records, UI JSON, and
  planted-secret search across every boundary.
- `apps/cli/src/services/trace/__tests__/distill.e2e.test.ts`: replacement,
  second-clone recall, stable IDs, shared pin/forget, correction survival after
  re-distillation, same-shard correction/distillation races, NFF retry, and
  collision incidents.
- `apps/cli/src/services/__tests__/git-hooks.service.test.ts`: realistic hook
  stdin plus upgrade/removal fixtures, duplicate blocks, missing end markers,
  no trailing newline, legacy `post-commit`, and preservation of user hooks.
- `apps/cli/src/services/trace/__tests__/ui-server.test.ts`: list/detail/empty,
  missing/truncated records, redacted JSON, self-contained assets, cached git
  reads, invalid Host rejection, and the actual loopback Host/port.
- `libs/cli-review/application/use-cases/__tests__/build-trace-context-pack.use-case.spec.ts`:
  repository/team-scoped branch reads, path matching, provider failure,
  byte-inert empty packs, confidence budget, and pinned budget override.
- `libs/code-review/pipeline/stages/finish-comments.stage.spec.ts`: the sticky
  comment consumes the exact same selected decision array as prompt context.
- `libs/code-review/modules/prompts.module.spec.ts`: focused Nest module
  compilation and resolution of `LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN` with the
  Trace dependency present.

## Additional review findings

- Cross-branch trailer linkage reproduced; fixed by requiring an exact branch
  match except on detached HEAD.
- Duplicate `turn_end` not reproduced by dispatching a completed turn again;
  the production guard and persist-before-send ordering already prevent it.
- Orphan-branch record loss reproduced as a mutable local-ref race during a
  multi-ref push; fixed by pushing each immutable commit SHA. A second stale
  same-shard scenario exposed remote correction loss during NFF retry; the
  retry now reads the freshly fetched remote ref and has a regression test.
- Wrong hook removal reproduced with review and Trace hooks side by side;
  ownership is now explicit and covered in both uninstall directions.
- Per-commit session-history rereads were not reproduced with a multi-commit
  branch: session collection occurs once after the commit-summary loop.
- UI git subprocess growth was addressed by loading the decision index once
  for the server lifetime; repeated detail requests reuse it.
- Model-invented scope outside every touched path was tested and rejected.
  Directory prefixes that match touched files remain supported intentionally,
  as required by issue 582.

## Evidence still requiring an external surface

- The in-app browser was unavailable during this run, so screenshots of the
  three UI states still need to be attached to the PR. HTTP rendering, Host
  rejection, truncation, escaping, redaction, and no-external-asset behavior
  are covered by the process/server tests above.
- A live provider PR comment create/update cycle was not performed from this
  worktree. The provider-independent branch reader and exact sticky-comment
  payload are covered with provider mocks; the final live-provider check must
  be attached to the PR before merge.
