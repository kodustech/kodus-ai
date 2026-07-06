# Local Sandbox Cleanup Hardflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop self-hosted local sandbox `/tmp/kodus-sandbox-*` directory leaks without corrupting active leases, orphaning E2B sandboxes, or weakening local sandbox security.

**Architecture:** Treat the Mongo lease document as the only durable retry record. Local filesystem cleanup, E2B kill, and lease deletion must be ordered so a failed resource cleanup leaves a retryable lease, while a successful cleanup can atomically delete only inactive leases. Local sandbox behavior must be separated from E2B behavior because local paths are worker-local and E2B sandbox ids are globally reconnectable.

**Tech Stack:** NestJS services, Mongoose repository, Jest unit tests, local filesystem sandbox provider, E2B SDK, cron-based reapers with distributed locks.

---

## Why This Restart Exists

The previous PR sequence found too many real issues after publication:

- #1381: 16 Kody finding threads, 22 Kody review submissions.
- #1386: 24 Kody finding threads, 28 Kody review submissions.
- #1463: 21 Kody finding threads, 28 Kody review submissions.
- #1464: 3 Kody finding threads, 3 Kody review submissions.

The repeated findings were not random. They clustered into these failure classes:

1. Lease lifecycle races: `release`, `invalidate`, `reapExpiredLeases`, `killIdleSandboxes`, stale reconnect, and concurrent `acquire` paths were reviewed independently instead of as one state machine.
2. Cleanup retry loss: previous changes sometimes deleted the lease document before confirming local directory cleanup or E2B kill success.
3. Worker-local path semantics: a local `/tmp/kodus-sandbox-*` path visible on one worker may be missing on another worker; missing locally is not the same as safely cleaned globally.
4. Security hardening regressions: shell filtering, environment isolation, symlink checks, and path validation affected existing Graph/AST callers.
5. Mongo semantics: `modifiedCount` vs `matchedCount`, unbounded queries, schema enum/index support, and atomic delete conditions were not reviewed up front.

This plan makes those classes explicit before implementation.

---

## Current Main Baseline

Fresh worktree:

- Branch: `fix/local-sandbox-cleanup-hardflow`
- Base: `origin/main` at `62822636b`
- Closed PR: #1464
- Dirty old worktree retained only as reference: `.worktrees/fix-local-sandbox-tmp-cleanup-v2`

Current relevant files on main:

- `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts`
    - E2B-oriented release/invalidate/create/connect behavior.
    - No local sandbox-specific cleanup path.
    - `connectToExisting` assumes E2B when `API_E2B_KEY` exists.
- `libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts`
    - Deletes expired and idle lease docs unconditionally after attempted E2B kill.
    - Uses unbounded query result sets.
- `libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts`
    - Has `upsertAcquire`, `decrementLease`, `updateReady`, `markInvalidated`, `findExpired`, `delete`, `setKillAt`, `clearKillAt`, `findReadyToKill`.
    - Lacks local cleanup guards such as `deleteIfNoActiveLeases`, `markDeletingIfNoActiveLeases`, and bounded ready-to-kill query.
- `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts`
    - Must be checked before adding any state such as `DELETING`.
- `libs/sandbox/infrastructure/providers/local-sandbox.service.ts`
    - Creates local sandboxes in `tmpdir()` with prefix `kodus-sandbox-`.
    - Existing security hardening must not be broadened in this cleanup PR unless required for cleanup correctness.

---

## Non-Goals

Do not include these in the first replacement PR:

- Broad local sandbox shell/security hardening unrelated to cleanup lifecycle.
- Graph CLI command rewriting.
- Large dependency injection refactors.
- Reworking all sandbox provider abstractions.
- Solving every historical Kody finding from old PRs if it is unrelated to `/tmp` cleanup correctness.

If any of those are still needed, create follow-up issues or separate PRs.

---

## Hard Rules

1. Never delete the only durable lease record before the associated resource cleanup has succeeded, except when the resource is proven already gone.
2. Never remove a local directory unless the lease has first been atomically blocked from new reuse.
3. Never delete a lease document after cleanup unless an atomic guard proves `leaseCount <= 0`.
4. Never treat a missing local path on the current worker as proof that another worker cleaned it unless the path belongs to an expired/crashed-worker recovery path.
5. Never let E2B kill failure delete the only retry record for a still-running remote sandbox.
6. Every state transition must have a recovery path after worker crash.
7. Every query used by a cron must be bounded or intentionally documented as bounded by an indexed predicate.
8. Every Kody finding class listed above must map to at least one test or explicit non-goal.

---

## State Model

Use the current states unless a task explicitly adds `DELETING`:

- `CREATING`: creator acquired the lease and is creating a sandbox.
- `READY`: sandbox id/path is available for reuse.
- `PAUSED`: existing state; do not expand behavior in this PR unless current callers depend on it.
- `INVALIDATED`: PR closed/force-pushed during creation.
- `DELETING` if added: cleanup is in progress; joiners must not reuse the sandbox and must retry or cold-start after bounded wait.

Required invariant:

```text
READY + local sandbox path => directory may exist only on the worker that created it.
READY + E2B sandbox id     => sandbox can be globally reconnected via E2B.
DELETING                  => no caller may reuse sandboxId/path.
deleted lease doc          => no resource remains that needs retry cleanup, or resource is proven unreachable/gone.
```

---

## Failure Matrix

| Path                                           | Cleanup succeeds                                                            | Cleanup fails                                     | Concurrent acquire                                                     | Worker crash                         |
| ---------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| local `release()` last lease                   | delete lease with `deleteIfNoActiveLeases`                                  | keep retryable lease                              | atomic mark/delete prevents active directory deletion                  | reaper recovers if state/doc remains |
| local `invalidate()` READY                     | block reuse, cleanup, guarded delete                                        | keep retryable lease                              | no new reuse after block                                               | reaper recovers                      |
| local creator path after `updateReady` failure | cleanup local dir, guarded/doc delete                                       | keep lease doc                                    | no returned sandbox                                                    | reaper recovers                      |
| local reconnect missing path                   | rollback this acquire; cold-start only if no active leases and path missing | preserve lease on uncertain errors                | no global delete while active leases remain                            | expired reaper handles stale doc     |
| E2B idle-kill                                  | kill remote first, then guarded delete                                      | keep lease for retry                              | `clearKillAt`/guard prevents killing active lease                      | next cron retries                    |
| E2B expired reaper                             | kill remote or detect gone, then delete                                     | keep doc for retry unless provider says not found | expired leases may be crashed-worker leases; deletion must be explicit | next cron retries                    |

---

## Kody-Style Pre-Review Checklist

Before opening any replacement PR, answer each item in the PR body:

- Can a failed local `rm` leave a `/tmp/kodus-sandbox-*` directory without a lease record? Expected answer: no.
- Can a concurrent `acquire` have its active local directory removed by `release`, `invalidate`, or reaper? Expected answer: no.
- Can an E2B kill failure remove the Mongo record needed to retry kill? Expected answer: no.
- Can a local path from worker A cause worker B to delete global state while worker A still owns the directory? Expected answer: only in expired crashed-worker recovery, with documented guard.
- Can `setKillAt` idempotently write the same timestamp without being misread as a lost race? Expected answer: yes, guarded match result is used.
- Are cron scans bounded? Expected answer: yes or documented with indexed low-cardinality bound.
- Does every new Mongo state have schema enum and index support? Expected answer: yes.
- Are existing local provider security behaviors unchanged unless covered by tests in this PR? Expected answer: yes.

---

## PR Split

Replacement work should be split if the first implementation grows beyond cleanup lifecycle:

1. PR A: local sandbox cleanup lifecycle only.
2. PR B: E2B kill/reaper retry semantics and bounded cron queries if not needed by PR A.
3. PR C: local sandbox provider security hardening follow-ups if still necessary.

Start with PR A.

---

## Task 1: Baseline Tests and Existing Behavior Map

**Files:**

- Read: `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts`
- Read: `libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts`
- Read: `libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts`
- Read: `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts`
- Read: `libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts`
- Read: `libs/sandbox/infrastructure/providers/local-sandbox.service.spec.ts`

- [ ] **Step 1: Run current sandbox tests before implementation**

Run:

```bash
pnpm test -- --runTestsByPath libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts libs/sandbox/infrastructure/providers/local-sandbox.service.spec.ts libs/sandbox/infrastructure/providers/local-sandbox.exec-streams.spec.ts test/unit/code-review/pipeline/stages/create-sandbox.stage.spec.ts --no-coverage --runInBand
```

Expected: pass, or record unrelated baseline failures before code changes.

- [ ] **Step 2: Record current cleanup behavior**

Add a short note to this plan under "Baseline Notes" with:

```text
release local path behavior:
invalidate local path behavior:
expired reaper local path behavior:
idle reaper local path behavior:
creator failure local path behavior:
local reconnect behavior when API_E2B_KEY exists:
```

- [ ] **Step 3: Stop if baseline has sandbox failures**

If baseline sandbox tests fail, fix or explain the baseline first. Do not implement cleanup changes on a failing baseline.

---

## Task 2: Add Local Sandbox Path Cleanup Utility

**Files:**

- Create: `libs/sandbox/infrastructure/services/local-sandbox-cleanup.ts`
- Test: `libs/sandbox/infrastructure/services/local-sandbox-cleanup.spec.ts`

- [ ] **Step 1: Write failing tests**

Add tests for:

```typescript
expect(isLocalSandboxPath(join(tmpdir(), 'kodus-sandbox-abc'))).toBe(true);
expect(isLocalSandboxPath('/var/tmp/kodus-sandbox-abc')).toBe(false);
expect(await cleanupLocalSandboxDirectory(validExistingDir)).toBe(true);
expect(await cleanupLocalSandboxDirectory(validMissingDir)).toBe(false);
await expect(cleanupLocalSandboxDirectory('/etc')).resolves.toBe(false);
```

Run:

```bash
pnpm test -- --runTestsByPath libs/sandbox/infrastructure/services/local-sandbox-cleanup.spec.ts --no-coverage --runInBand
```

Expected: fail because the utility does not exist.

- [ ] **Step 2: Implement utility**

Required exported functions:

```typescript
export function isLocalSandboxPath(sandboxId?: string): boolean;
export async function localSandboxDirectoryExists(
    sandboxId?: string,
): Promise<boolean>;
export async function cleanupLocalSandboxDirectory(
    sandboxId?: string,
): Promise<boolean>;
```

Required behavior:

- Accept only absolute paths whose parent directory is `resolve(tmpdir())`.
- Require basename prefix `kodus-sandbox-`.
- Return `false` for invalid paths.
- Return `false` for missing local sandbox directories.
- Throw non-`ENOENT` `lstat` errors so callers can preserve retry records.
- Use `rm(resolved, { recursive: true, force: true })` only after existence check succeeds.

- [ ] **Step 3: Verify utility tests**

Run the same test command. Expected: pass.

---

## Task 3: Repository Atomic Guards

**Files:**

- Modify: `libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts`
- Modify: `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts`
- Test: `libs/sandbox/infrastructure/repositories/sandbox-lease.repository.spec.ts`

- [ ] **Step 1: Write repository tests**

Add tests using a mocked `leaseModel` for:

```typescript
deleteIfNoActiveLeases('pr') returns true when deletedCount is 1
deleteIfNoActiveLeases('pr') returns false when deletedCount is 0
setKillAt('pr', sameDate) returns true when matchedCount is 1 and modifiedCount is 0
setKillAt('pr', date) returns false when matchedCount is 0
findReadyToKill(now, limit) calls .limit(limit)
```

- [ ] **Step 2: Add guarded repository methods**

Required methods:

```typescript
async deleteIfNoActiveLeases(prKey: string): Promise<boolean>
async setKillAt(prKey: string, killAt: Date): Promise<boolean>
async findReadyToKill(now: Date, limit: number): Promise<Array<Pick<SandboxLeaseModel, '_id' | 'sandboxId' | 'killAt'>>>
```

Required behavior:

- `deleteIfNoActiveLeases` must filter `{ _id: prKey, leaseCount: { $lte: 0 } }`.
- `setKillAt` must filter `{ _id: prKey, leaseCount: { $lte: 0 }, sandboxId: { $exists: true, $ne: '' } }`.
- `setKillAt` must return `matchedCount > 0`, not `modifiedCount > 0`.
- `findReadyToKill` must apply an explicit limit.

- [ ] **Step 3: Verify repository tests**

Run:

```bash
pnpm test -- --runTestsByPath libs/sandbox/infrastructure/repositories/sandbox-lease.repository.spec.ts --no-coverage --runInBand
```

Expected: pass.

---

## Task 4: Local Release and Invalidate Cleanup

**Files:**

- Modify: `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts`
- Test: `libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts`

- [ ] **Step 1: Write failing manager tests**

Add tests for:

```typescript
release removes local sandbox directory when last lease reaches zero
release keeps lease when local cleanup returns false
release does not call Sandbox.setTimeout for local sandbox paths
release skips local cleanup when delete/mark guard reports re-acquired lease
invalidate removes local sandbox directory before deleting inactive lease
invalidate preserves lease when local cleanup fails
```

- [ ] **Step 2: Implement local release path**

Required behavior:

- Branch on `isLocalSandboxPath(updated.sandboxId)` before E2B idle-kill logic.
- Do not call `Sandbox.setTimeout` for local paths.
- Do not call `leaseRepo.delete(prKey)` unconditionally.
- Cleanup local directory only after an atomic no-active guard prevents reuse.
- Delete lease only after cleanup succeeded and `deleteIfNoActiveLeases` returns true.
- If cleanup fails, keep the lease record for retry.

- [ ] **Step 3: Implement local invalidate path**

Required behavior:

- For `CREATING`, preserve existing `INVALIDATED` behavior.
- For `READY` local sandbox path, block reuse before cleanup.
- Delete lease only when cleanup succeeded and no active leases remain.
- If cleanup fails, keep lease for retry and log warning.

- [ ] **Step 4: Verify manager tests**

Run:

```bash
pnpm test -- --runTestsByPath libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts --no-coverage --runInBand
```

Expected: pass.

---

## Task 5: Local Creator Failure and Local Reconnect Semantics

**Files:**

- Modify: `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts`
- Test: `libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts`

- [ ] **Step 1: Write failing tests**

Add tests for:

```typescript
creator-path local cleanup failure preserves the lease for reaper retry
creator-path local cleanup success allows lease cleanup
local reconnect missing directory rolls back this acquire and cold-starts only when no active leases remain
local reconnect provider failure with existing directory preserves lease and rethrows original error
local reconnect must not call Sandbox.connect for local paths even when API_E2B_KEY exists
```

- [ ] **Step 2: Implement local reconnect branch**

Required behavior:

- Detect local sandbox paths before E2B connect.
- Use `sandboxProvider.connectToExistingSandbox` when available.
- On reconnect failure:
    - remove local `leaseId` tracking;
    - decrement the acquire that just joined;
    - only treat it as stale/cold-start if no active leases remain and `localSandboxDirectoryExists` returns false;
    - if the directory exists or existence check fails, preserve the lease and rethrow.

- [ ] **Step 3: Implement creator failure cleanup**

Required behavior:

- If a local sandbox was created and a later step fails, call local cleanup.
- If local cleanup returns false or throws, preserve the lease document.
- Never delete the lease document after a failed local cleanup.

- [ ] **Step 4: Verify tests**

Run:

```bash
pnpm test -- --runTestsByPath libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts libs/sandbox/infrastructure/services/local-sandbox-cleanup.spec.ts --no-coverage --runInBand
```

Expected: pass.

---

## Task 6: Reaper Local and Remote Retry Semantics

**Files:**

- Modify: `libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts`
- Modify: `libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts`
- Test: `libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts`

- [ ] **Step 1: Write failing reaper tests**

Add tests for:

```typescript
expired reaper deletes local lease when local directory is missing and lease is expired
expired reaper keeps local lease when cleanup throws non-ENOENT error
idle reaper does not delete E2B lease when Sandbox.kill fails
idle reaper applies bounded findReadyToKill limit
expired reaper processes bounded batches or has explicit repository limit
```

- [ ] **Step 2: Implement reaper behavior**

Required behavior:

- Local expired leases may be deleted when the directory is missing because expiration is crashed-worker recovery.
- Local non-expired idle cleanup must not delete global state just because a path is missing on the current worker.
- E2B kill failure must keep the lease record for retry unless the provider reports not found.
- Reaper queries must be bounded.

- [ ] **Step 3: Verify reaper tests**

Run:

```bash
pnpm test -- --runTestsByPath libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts --no-coverage --runInBand
```

Expected: pass.

---

## Task 7: Full Verification Before PR

**Files:**

- No implementation files unless prior tasks changed them.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm test -- --runTestsByPath libs/sandbox/infrastructure/repositories/sandbox-lease.repository.spec.ts libs/sandbox/infrastructure/services/local-sandbox-cleanup.spec.ts libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts libs/sandbox/infrastructure/providers/local-sandbox.service.spec.ts libs/sandbox/infrastructure/providers/local-sandbox.exec-streams.spec.ts test/unit/code-review/pipeline/stages/create-sandbox.stage.spec.ts --no-coverage --runInBand
```

Expected: pass.

- [ ] **Step 2: Run formatting and lint**

Run:

```bash
pnpm exec prettier --check libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts libs/sandbox/infrastructure/services/local-sandbox-cleanup.ts libs/sandbox/infrastructure/services/local-sandbox-cleanup.spec.ts libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts libs/sandbox/infrastructure/providers/local-sandbox.service.ts
pnpm exec eslint libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts libs/sandbox/infrastructure/services/local-sandbox-cleanup.ts libs/sandbox/infrastructure/services/local-sandbox-cleanup.spec.ts libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts libs/sandbox/infrastructure/providers/local-sandbox.service.ts
git diff --check
```

Expected: pass.

- [ ] **Step 3: Run typecheck and record known failures**

Run:

```bash
pnpm exec tsc --noEmit --pretty false 2>&1 | rg 'libs/sandbox|sandbox-lease|SandboxLease'
```

Expected: no new sandbox errors. If existing main has sandbox errors, record exact file/line in PR body.

- [ ] **Step 4: Kody pre-review**

Before creating the PR, manually answer the "Kody-Style Pre-Review Checklist" above. Do not open the PR until every answer is supported by a test, a code reference, or a documented non-goal.

---

## Baseline Notes

```text
release local path behavior:
  Current main does not branch on local sandbox paths. When leaseCount reaches
  zero and sandboxId is a local /tmp path, release writes killAt and, if
  API_E2B_KEY exists, attempts Sandbox.setTimeout with the local path.

invalidate local path behavior:
  Current main does not branch on local sandbox paths. READY/PAUSED leases use
  the E2B soft-drain path when API_E2B_KEY exists, then delete the lease doc
  unconditionally. No local directory cleanup is attempted.

expired reaper local path behavior:
  Current main treats every sandboxId as E2B when API_E2B_KEY exists, attempts
  Sandbox.kill, then deletes the lease doc unconditionally. No local directory
  cleanup is attempted and the result set is unbounded.

idle reaper local path behavior:
  Current main treats every ready-to-kill sandboxId as E2B when API_E2B_KEY
  exists, attempts Sandbox.kill, then deletes the lease doc unconditionally.
  No local directory cleanup is attempted and the result set is unbounded.

creator failure local path behavior:
  Current main attempts E2B kill only when API_E2B_KEY exists, then deletes the
  lease doc unconditionally. A local directory created before a later Mongo
  failure can be orphaned because no local cleanup path exists.

local reconnect behavior when API_E2B_KEY exists:
  Current main has no local reconnect branch. connectToExisting uses
  Sandbox.connect for any non-empty sandboxId when API_E2B_KEY exists, so a
  local /tmp path can be sent to E2B. On connect failure it deletes the lease
  and retries acquire as stale E2B.

baseline focused tests:
  2026-07-06: pnpm test -- --runTestsByPath
  libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts
  libs/sandbox/infrastructure/providers/local-sandbox.service.spec.ts
  libs/sandbox/infrastructure/providers/local-sandbox.exec-streams.spec.ts
  test/unit/code-review/pipeline/stages/create-sandbox.stage.spec.ts
  --no-coverage --runInBand
  Result: 4 suites passed, 39 tests passed.
```
