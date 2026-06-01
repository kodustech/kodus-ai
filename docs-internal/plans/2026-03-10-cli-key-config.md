# CLI Key Config Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-key CLI configuration so owners can enable or disable repository configuration access for each CLI key.

**Architecture:** Store a generic `config` JSONB column on `team_cli_key`, expose it through the team CLI key API, and add a focused UI in the CLI keys screen to set `config.permissions.configureRepositories` on create and update. Keep the first scope minimal but shape it for future growth.

**Tech Stack:** NestJS, TypeORM, Next.js, React, TypeScript, Jest

### Task 1: Define and lock the backend contract

**Files:**
- Modify: `libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface.ts`
- Modify: `libs/organization/domain/team-cli-key/entities/team-cli-key.entity.ts`
- Modify: `libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract.ts`
- Test: `apps/api/src/controllers/__tests__/team-cli-key.controller.spec.ts`
- Test: `libs/organization/infrastructure/adapters/services/__tests__/team-cli-key.service.spec.ts`

**Step 1: Write the failing tests**

Add controller tests for:
- listing CLI keys returns `config`
- creating a CLI key forwards `config`
- updating a CLI key config returns the updated `config`

Add service tests for:
- `generateKey` persists default config
- `validateKey` returns config metadata

**Step 2: Run tests to verify they fail**

Run: `yarn test apps/api/src/controllers/__tests__/team-cli-key.controller.spec.ts libs/organization/infrastructure/adapters/services/__tests__/team-cli-key.service.spec.ts`

Expected: FAIL because config shape and update flow do not exist yet.

**Step 3: Implement the minimal domain contract**

Add a typed config shape with:

```ts
config?: {
  permissions?: {
    configureRepositories?: boolean;
  };
};
```

Update `ValidateKeyResult` to include `config`.

**Step 4: Run tests to verify progress**

Run the same test command and confirm remaining failures are now in persistence/controller layers only.

### Task 2: Persist config in the API and database

**Files:**
- Modify: `libs/organization/infrastructure/adapters/repositories/schemas/team-cli-key.model.ts`
- Modify: `libs/organization/infrastructure/adapters/repositories/team-cli-key.repository.ts`
- Modify: `libs/organization/infrastructure/adapters/services/team-cli-key.service.ts`
- Modify: `apps/api/src/controllers/team-cli-key.controller.ts`
- Modify: `apps/api/src/dtos/team-cli-key-response.dto.ts`
- Create: `libs/core/infrastructure/database/typeorm/migrations/2026031000000-AddConfigToTeamCliKey.ts`

**Step 1: Write the migration**

Add a nullable or default-empty `jsonb` column named `config` to `team_cli_key`.

**Step 2: Implement minimal persistence**

Map `config` through the model, repository, entity, service, and DTOs.

**Step 3: Add update endpoint**

Create a focused `PATCH /teams/:teamId/cli-keys/:keyId/config` endpoint that updates only the key config.

**Step 4: Run backend tests**

Run: `yarn test apps/api/src/controllers/__tests__/team-cli-key.controller.spec.ts libs/organization/infrastructure/adapters/services/__tests__/team-cli-key.service.spec.ts`

Expected: PASS

### Task 3: Add CLI key config controls to the web screen

**Files:**
- Modify: `apps/web/src/lib/services/cliKeys/types.ts`
- Modify: `apps/web/src/lib/services/cliKeys/index.ts`
- Modify: `apps/web/src/lib/services/cliKeys/fetch.ts`
- Modify: `apps/web/src/app/(app)/organization/cli-keys/_page-component.tsx`

**Step 1: Extend the client types and fetchers**

Support create payload with `config` and a new request to update key config.

**Step 2: Implement the UI**

Add:
- a create-time switch: “Allow repository configuration via CLI”
- a table column with a switch per key for toggling the same setting later

**Step 3: Verify the screen builds**

Run: `yarn build:web`

Expected: PASS

### Task 4: Final verification

**Files:**
- Review touched files only

**Step 1: Run focused verification**

Run:
- `yarn test apps/api/src/controllers/__tests__/team-cli-key.controller.spec.ts libs/organization/infrastructure/adapters/services/__tests__/team-cli-key.service.spec.ts`
- `yarn build:api`
- `yarn build:web`

**Step 2: Confirm behavior**

Verify:
- new keys can be created with repository config enabled or disabled
- existing keys can be toggled
- list responses include config
- `validateKey` carries config for future CLI endpoint enforcement
