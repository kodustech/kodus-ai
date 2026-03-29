# Better Stack Sentry Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current Sentry destination with the provided Better Stack DSN and ensure Nest.js error tracking initializes in the real bootstrap path for `api`, `worker`, and `webhooks`.

**Architecture:** Introduce one shared Sentry bootstrap utility that owns SDK initialization and import it through app-local `instrument.ts` entry files so Sentry starts before Nest modules load. Keep the existing global exception filter reporting behavior, but point the SDK to the Better Stack DSN through the new bootstrap and remove the dead legacy setup path.

**Tech Stack:** NestJS, TypeScript, Jest, `@sentry/nestjs`

### Task 1: Add bootstrap test coverage

**Files:**
- Create: `test/unit/core/infrastructure/config/log/sentry-bootstrap.spec.ts`
- Reference: `test/unit/api/exceptions-filter.spec.ts`

**Step 1: Write the failing test**

```typescript
it('initializes Sentry with the Better Stack DSN only once', async () => {
  // mock @sentry/nestjs init/isInitialized
  // call shared bootstrap twice for the same service
  // expect init called once with the Better Stack DSN
});
```

**Step 2: Run test to verify it fails**

Run: `yarn jest test/unit/core/infrastructure/config/log/sentry-bootstrap.spec.ts --runInBand`
Expected: FAIL because the shared bootstrap utility does not exist yet.

**Step 3: Write minimal implementation**

Create the shared bootstrap utility with a fixed Better Stack DSN, environment/release metadata, and idempotent initialization.

**Step 4: Run test to verify it passes**

Run: `yarn jest test/unit/core/infrastructure/config/log/sentry-bootstrap.spec.ts --runInBand`
Expected: PASS

### Task 2: Wire real app bootstrap entrypoints

**Files:**
- Create: `apps/api/src/instrument.ts`
- Create: `apps/worker/src/instrument.ts`
- Create: `apps/webhooks/src/instrument.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/webhooks/src/main.ts`
- Create or Modify: `libs/core/infrastructure/config/log/sentry.ts`

**Step 1: Write the failing test**

Use the bootstrap test from Task 1 as the guardrail; no new production code until the shared init test is red.

**Step 2: Run test to verify it fails**

Run: `yarn jest test/unit/core/infrastructure/config/log/sentry-bootstrap.spec.ts --runInBand`
Expected: FAIL before implementation, PASS after Task 1.

**Step 3: Write minimal implementation**

Import each app-local `instrument.ts` file before the app module loads and call the shared bootstrap with a service name that distinguishes `api`, `worker`, and `webhooks`.

**Step 4: Run test to verify it passes**

Run: `yarn jest test/unit/core/infrastructure/config/log/sentry-bootstrap.spec.ts --runInBand`
Expected: PASS

### Task 3: Replace the legacy bootstrap path

**Files:**
- Delete or Modify: `libs/core/infrastructure/config/log/otel.ts`
- Search: `scripts/dev/fetch-env-qa.sh`
- Search: `scripts/dev/fetch-env-prod.sh`

**Step 1: Write the failing test**

Use the same bootstrap test to ensure the repo now has one canonical Sentry init path.

**Step 2: Run test to verify it fails**

Run: `rg -n "API_SENTRY_DNS|setupSentryAndOpenTelemetry" libs apps test scripts`
Expected: shows the old implementation before cleanup.

**Step 3: Write minimal implementation**

Remove or rewrite the dead legacy file so the repository no longer points to the previous DSN-based bootstrap path.

**Step 4: Run test to verify it passes**

Run: `rg -n "API_SENTRY_DNS|setupSentryAndOpenTelemetry" libs apps test scripts`
Expected: no active bootstrap references remain.

### Task 4: Verify affected behavior

**Files:**
- Test: `test/unit/core/infrastructure/config/log/sentry-bootstrap.spec.ts`
- Test: `test/unit/api/exceptions-filter.spec.ts`

**Step 1: Run targeted tests**

Run: `yarn jest test/unit/core/infrastructure/config/log/sentry-bootstrap.spec.ts test/unit/api/exceptions-filter.spec.ts --runInBand`
Expected: PASS

**Step 2: Run quick static verification**

Run: `git diff -- apps/api/src/main.ts apps/worker/src/main.ts apps/webhooks/src/main.ts libs/core/infrastructure/config/log test/unit/core/infrastructure/config/log/sentry-bootstrap.spec.ts test/unit/api/exceptions-filter.spec.ts`
Expected: Only the Better Stack Sentry bootstrap replacement is present.
