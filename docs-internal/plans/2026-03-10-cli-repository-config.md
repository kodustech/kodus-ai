# CLI Repository Config Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the CLI to list available repositories and add one or more repositories to the team review configuration using a team CLI key.

**Architecture:** Add a dedicated API surface for CLI config under `cli/config`, authenticated with the existing team CLI key flow. Reuse the existing repository persistence and code review config recalculation pipeline so the CLI and web stay consistent, but keep the CLI contract narrower and more ergonomic than the current web-only endpoints.

**Tech Stack:** NestJS controllers/use cases, existing Team CLI key auth service, platform code-management service, integration config service, Jest controller tests.

## Current State

- The web flow already does the right domain work:
  - fetches repositories with `GET /code-management/repositories/org`
  - persists selection with `POST /code-management/repositories`
  - recalculates code review repositories with `POST /parameters/update-code-review-parameter-repositories`
- CLI auth already exists via `x-team-key` or `Authorization: Bearer kodus_*`.
- The current code-management endpoints are JWT + `PolicyGuard` only, so the CLI cannot reuse them directly.
- `CreateRepositoriesUseCase` and `UpdateCodeReviewParameterRepositoriesUseCase` still assume `request.user` for some data, which is fine for web but needs a CLI-safe path.

## Options

### Recommended: Dedicated `cli/config` controller

- Add `CliConfigController` with focused endpoints for repository config.
- Validate the team key once per request, derive `organizationId` and `teamId`, and bypass user-scoped repository filtering.
- Reuse existing persistence/recalculation use cases with small changes to accept explicit org context when there is no authenticated user object.

Why this is the best first slice:

- keeps CLI concerns out of the web controller contract
- preserves current web behavior
- avoids reworking guards/middleware
- gives the CLI a stable API that can evolve without leaking web form semantics

### Alternative 1: Make `CodeManagementController` accept team keys too

- Lower file count, but it mixes browser and CLI contracts.
- Harder to reason about `PolicyGuard` vs team-key auth.
- Increases risk of permission regressions in existing web endpoints.

### Alternative 2: Put config endpoints inside `CliReviewController`

- Fastest in the short term, but wrong cohesion.
- Makes `cli-review` a dumping ground for unrelated config behavior.

## Proposed API

- `GET /cli/config/repositories/available?teamId=<teamId>`
  - Auth: `x-team-key` or `Bearer kodus_*`
  - Returns repositories available from the connected provider, including current `selected` state
- `GET /cli/config/repositories/selected?teamId=<teamId>`
  - Auth: `x-team-key` or `Bearer kodus_*`
  - Returns only currently selected repositories
- `POST /cli/config/repositories`
  - Auth: `x-team-key` or `Bearer kodus_*`
  - Body: `{ teamId: string, repositoryIds: string[] }`
  - Behavior:
    - fetch provider repositories
    - fetch current selected repositories
    - validate requested ids exist
    - merge requested ids into selected set
    - persist merged set
    - recalculate code review config repositories
  - Response: `{ status: true, addedRepositoryIds: string[], totalSelected: number }`

## Behavior Rules

- `teamId` must match the team bound to the CLI key.
- Adding an already-selected repository is a no-op, not an error.
- Missing repository ids return `400`.
- Invalid or revoked team keys return `401`.
- If the team has no code management integration, return `400` with a clear message.
- Recalculation of code review repositories must happen immediately after persistence.

## Task Breakdown

### Task 1: Add failing controller tests for CLI repository config

**Files:**
- Create: `apps/api/src/controllers/__tests__/cli-config.controller.spec.ts`

**Step 1: Write the failing test**

Cover:

- lists available repositories using team key auth
- lists selected repositories using team key auth
- appends new repositories by `repositoryIds`
- rejects invalid team key
- rejects repository ids not found in provider list
- rejects `teamId` mismatch between request and key

**Step 2: Run test to verify it fails**

Run: `yarn test apps/api/src/controllers/__tests__/cli-config.controller.spec.ts --runInBand`

Expected: FAIL because controller does not exist yet.

**Step 3: Commit**

Skip commit for now unless explicitly requested.

### Task 2: Add CLI config controller and route registration

**Files:**
- Create: `apps/api/src/controllers/cli-config.controller.ts`
- Modify: `apps/api/src/api.module.ts`

**Step 1: Write minimal implementation**

- add `@Controller('cli/config')`
- add a private helper to resolve the team key and enforce `teamId`
- add `GET /repositories/available`
- add `GET /repositories/selected`
- add `POST /repositories`

**Step 2: Run the new test**

Run: `yarn test apps/api/src/controllers/__tests__/cli-config.controller.spec.ts --runInBand`

Expected: still FAIL until dependencies/context handling are implemented.

### Task 3: Make repository persistence use cases CLI-safe

**Files:**
- Modify: `libs/platform/application/use-cases/codeManagement/create-repositories.ts`
- Modify: `libs/code-review/application/use-cases/configuration/update-code-review-parameter-repositories-use-case.ts`

**Step 1: Write the minimal code**

- allow `CreateRepositoriesUseCase` to accept explicit `organizationId` when request user is absent
- allow `UpdateCodeReviewParameterRepositoriesUseCase` to skip request-derived logging data when invoked from CLI

**Step 2: Re-run the controller test**

Run: `yarn test apps/api/src/controllers/__tests__/cli-config.controller.spec.ts --runInBand`

Expected: PASS.

### Task 4: Verify no regressions in adjacent CLI auth behavior

**Files:**
- Existing: `apps/api/src/controllers/__tests__/cli-review.controller.session-events.spec.ts`

**Step 1: Run focused tests**

Run: `yarn test apps/api/src/controllers/__tests__/cli-review.controller.session-events.spec.ts apps/api/src/controllers/__tests__/cli-config.controller.spec.ts --runInBand`

Expected: PASS.

### Task 5: Optional follow-up for the actual CLI client

**Files:**
- Outside this repo or later task, depending on where the CLI command lives

**Step 1: Add command surface**

- `kodus config repositories list`
- `kodus config repositories add <repo-id>`

**Step 2: Wire it to the new API**

- call `GET /cli/config/repositories/available`
- call `POST /cli/config/repositories`

This is intentionally out of scope for the first server-side slice if the CLI client lives elsewhere.
