# Local Sandbox Cleanup Hardflow V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure self-hosted local sandboxes created under the OS temp directory are removed when leases are released, invalidated, expired, or abandoned by crashed workers.

**Architecture:** Local sandbox directory cleanup is a provider capability exposed through the same lease lifecycle that already coordinates E2B sandboxes. Mongo lease deletion becomes a claimed `DELETING` transition before destructive cleanup so acquire, invalidate, and both reaper passes cannot race each other into stale reuse, double delete, or lost retry state.

**Tech Stack:** TypeScript, NestJS services, Mongoose repository methods, Jest unit tests, local filesystem cleanup via `fs.rm`.

---

## Design Invariants

- Only direct children of `os.tmpdir()` whose basename starts with `kodus-sandbox-` may be deleted by local cleanup.
- Local sandbox `sandboxId` is its absolute repo directory path so later workers can reconnect or delete it.
- `ISandboxProvider.connectToSandbox()` is optional-provider behavior: E2B connects by API; local validates an existing safe directory; null remains unsupported.
- Any destructive cleanup first claims the lease as `DELETING`; acquire must not clear `killAt` or recurse forever on `DELETING`.
- `invalidate()` must win an atomic transition to `INVALIDATED` before clearing `killAt`, soft-draining, deleting, or local-cleaning. If another worker already claimed `DELETING`, invalidate exits without side effects.
- Expired and idle reaper passes must claim by the original `expiresAt` or `killAt` value they read, preventing stale scans from deleting a lease that was refreshed or reacquired.
- E2B kill failures keep the lease document for retry; local missing directories are treated as already-clean success.

## Files

- Create: `libs/sandbox/infrastructure/services/local-sandbox-cleanup.ts`
- Create: `libs/sandbox/infrastructure/services/local-sandbox-cleanup.spec.ts`
- Create: `libs/sandbox/infrastructure/repositories/sandbox-lease.repository.spec.ts`
- Modify: `libs/sandbox/domain/contracts/sandbox.provider.ts`
- Modify: `libs/sandbox/infrastructure/providers/local-sandbox.service.ts`
- Modify: `libs/sandbox/infrastructure/providers/local-sandbox.service.spec.ts`
- Modify: `libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts`
- Modify: `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts`
- Modify: `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts`
- Modify: `libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts`
- Modify: `libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts`

### Task 1: Safe Local Cleanup Primitive

- [ ] Step 1: Add failing tests in `local-sandbox-cleanup.spec.ts` for deleting a direct `/tmp/kodus-sandbox-*` directory, rejecting non-matching paths, rejecting nested paths, and treating missing paths as success.
- [ ] Step 2: Run `pnpm test -- --runTestsByPath libs/sandbox/infrastructure/services/local-sandbox-cleanup.spec.ts --no-coverage --runInBand` and confirm the new tests fail because the module is missing.
- [ ] Step 3: Implement `isSafeLocalSandboxPath()` and `cleanupLocalSandboxPath()` using `path.resolve`, `os.tmpdir`, and `fs.rm`.
- [ ] Step 4: Re-run the same test command and confirm it passes.

### Task 2: Provider Reconnect Contract

- [ ] Step 1: Add failing tests proving local `sandboxId` is the temp directory path and `connectToSandbox()` reconnects only to an existing safe local sandbox path.
- [ ] Step 2: Run local provider tests and confirm failures before implementation.
- [ ] Step 3: Add optional `connectToSandbox(sandboxId: string)` to `ISandboxProvider`; implement it in `LocalSandboxService` by reusing command wrappers over the existing repo directory.
- [ ] Step 4: Re-run provider tests and confirm they pass.

### Task 3: Repository Claim Semantics

- [ ] Step 1: Add repository tests for refreshed `expiresAt`, `DELETING` enum support, guarded `markInvalidated`, guarded `clearKillAt`, `markDeletingIfNoActiveLeases`, `markDeletingIfReadyToKill`, and `markDeletingIfExpired`.
- [ ] Step 2: Run repository tests and confirm they fail before implementation.
- [ ] Step 3: Implement repository methods with single Mongo updates that include the original timestamp/state guards.
- [ ] Step 4: Re-run repository tests and confirm they pass.

### Task 4: Manager Lifecycle Cleanup

- [ ] Step 1: Add manager tests for local release cleanup, active local invalidate marking `INVALIDATED`, no side effects after losing to `DELETING`, creator-failure cleanup, and `DELETING` acquire timeout without recursive cold-start.
- [ ] Step 2: Run manager tests and confirm failures before implementation.
- [ ] Step 3: Wire local cleanup into release, invalidate, creator failure, stale local reconnect, and `DELETING` handling.
- [ ] Step 4: Re-run manager tests and confirm they pass.

### Task 5: Reaper Cleanup and Retry Behavior

- [ ] Step 1: Add reaper tests for expired local cleanup, idle local cleanup, stale timestamp claim loss, E2B kill failure retry, missing E2B API key retry, and missing local directory success.
- [ ] Step 2: Run reaper tests and confirm failures before implementation.
- [ ] Step 3: Update expired and idle reaper loops to claim `DELETING`, perform provider-specific cleanup, and delete only after successful cleanup.
- [ ] Step 4: Re-run reaper tests and confirm they pass.

### Task 6: Full Verification and Review Gate

- [ ] Step 1: Run focused sandbox/code-review tests.
- [ ] Step 2: Run Prettier, ESLint, `git diff --check`, and `pnpm run typecheck:libs-gate`.
- [ ] Step 3: Perform self-review from Kody bot's perspective: race windows, retry semantics, local path safety, and unrelated CI limitations.
- [ ] Step 4: Commit without AI co-author, push a new branch, create a draft PR, and monitor Kody/CI before asking for review.

## Execution Record

- RED baseline: migrated tests only, then confirmed failures for missing local cleanup helper, local reconnect, repository claim methods, and guarded state semantics.
- GREEN focused tests: `pnpm test -- --runTestsByPath libs/sandbox/infrastructure/services/local-sandbox-cleanup.spec.ts libs/sandbox/infrastructure/repositories/sandbox-lease.repository.spec.ts libs/sandbox/infrastructure/providers/local-sandbox.service.spec.ts libs/sandbox/infrastructure/providers/local-sandbox.exec-streams.spec.ts libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts test/unit/code-review/pipeline/stages/create-sandbox.stage.spec.ts --no-coverage --runInBand` passed with 6 suites and 84 tests.
- Additional self-review fix: added a failing test for a `/tmp/kodus-sandbox-*` regular file and changed cleanup existence checks to require a real directory.
- Formatting/lint gates passed for all changed files.
- `pnpm run typecheck:libs-gate` passed with no TS2304 errors in `libs/`.
- Wider known limitations: `pnpm run typecheck` fails on existing repo-wide test/CLI type errors unrelated to sandbox changes; `pnpm run build:worker` fails locally because private `libs/ee/configs/environment/environment` is not present.
