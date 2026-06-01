# Audit — internal hostname helpers, client vs server importers

Date: 2026-04-22
Resolves design open question Q3 (`docs/superpowers/specs/2026-04-15-web-runtime-config-design.md`).

## helpers.ts (WEB_HOSTNAME_API, WEB_PORT_API)

Exports: `pathToApiUrl()`, `createUrl()` (and others like `isJwtExpired`, `parseJwt`, `formatNameToAvatar`, `greeting`, etc.)

Internal hostname used: `process.env.WEB_HOSTNAME_API` and `process.env.WEB_PORT_API` (lines 22, 35)

| Importer | Type | Functions Used | Action needed for Task 7 |
|---|---|---|---|
| apps/web/src/app/(app)/issues/_components/issue-details-right-sheet.tsx | client | pathToApiUrl | Refactor: move pathToApiUrl calls to a route handler proxy, call /api/proxy/api from client |
| apps/web/src/app/(app)/issues/_components/severity-level-select.tsx | client | pathToApiUrl | Refactor: move pathToApiUrl calls to a route handler proxy, call /api/proxy/api from client |
| apps/web/src/app/(app)/issues/_components/status-select.tsx | client | pathToApiUrl | Refactor: move pathToApiUrl calls to a route handler proxy, call /api/proxy/api from client |
| apps/web/src/app/(app)/settings/_components/route-button-with-override-count.tsx | client | pathToApiUrl | Refactor: move pathToApiUrl calls to a route handler proxy, call /api/proxy/api from client |
| apps/web/src/app/(app)/settings/code-review/[repositoryId]/custom-messages/page.tsx | client | pathToApiUrl | Refactor: move pathToApiUrl calls to a route handler proxy, call /api/proxy/api from client |
| apps/web/src/features/ee/sso/_page-component.tsx | client | pathToApiUrl | Refactor: move pathToApiUrl calls to a route handler proxy, call /api/proxy/api from client |
| apps/web/src/features/ee/subscription/_components/license-key-settings.tsx | client | pathToApiUrl | Refactor: move pathToApiUrl calls to a route handler proxy, call /api/proxy/api from client |
| apps/web/src/core/config/auth.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/core/utils/segment.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/features/ee/cockpit/_services/analytics/utils.ts | server | createUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/features/ee/cockpit/layout.tsx | server | greeting | None — generic helper, not affected by env migration |
| apps/web/src/features/ee/cockpit/not-available.tsx | server | greeting | None — generic helper, not affected by env migration |
| apps/web/src/features/ee/onboarding/_hooks/use-finish-onboarding-reviewing-pr.ts | server | waitFor | None — generic helper, not affected by env migration |
| apps/web/src/features/ee/onboarding/_hooks/use-finish-onboarding-without-selecting-pr.ts | server | waitFor | None — generic helper, not affected by env migration |
| apps/web/src/features/ee/subscription/_services/billing/fetch.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/features/ee/subscription/_services/billing/utils.ts | server | createUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/auth/fetchers.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/cliKeys/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/codeManagement/hooks/use-lazy-repository-tree.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/codeManagement/types.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/dryRun/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/globalParameters/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/integrations/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/integrations/integrationConfig/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/issues/fetch.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/issues/hooks.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/kodyRules/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/mcp-manager/utils.ts | server | createUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/organizationParameters/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/organizations/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/parameters/fetch.ts | server | codeReviewConfigRemovePropertiesNotInType | None — generic helper, not affected by env migration |
| apps/web/src/lib/services/parameters/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/permissions/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/pull-request-messages/fetch.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/pull-request-messages/hooks.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/pull-requests/fetch.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/ruleFeedback/fetch.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/setup/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/skills/fetch.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/ssoConfig/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/teamMembers/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/teams/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/usage/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/userLogs/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/users/fetch.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |
| apps/web/src/lib/services/users/index.ts | server | pathToApiUrl | None — keep direct env read, add `import 'server-only'` to helper |

## billing/utils.ts (WEB_HOSTNAME_BILLING)

Exports: `billingFetch()`

Internal hostname used: `process.env.WEB_HOSTNAME_BILLING` (line 9), calls `createUrl()` from helpers.ts

Direct importers of billing/utils.ts:
- None via direct import path (`from "*billing/utils"`)
- Only `billingFetch` is used via internal import in `billing/fetch.ts` (SERVER)

Since `billingFetch()` is a server-only async utility that reads `process.env.WEB_HOSTNAME_BILLING` only server-side, no client component can directly import or call it. The architecture is sound — `billingFetch` is only used in `billing/fetch.ts` (SERVER).

| Importer | Type | Functions Used | Action needed for Task 7 |
|---|---|---|---|
| apps/web/src/features/ee/subscription/_services/billing/fetch.ts | server | billingFetch (exported from utils.ts) | None — keep direct env read, add `import 'server-only'` to billing/utils.ts |

## mcp-manager/utils.ts (WEB_HOSTNAME_MCP_MANAGER)

Exports: `mcpManagerFetch()`, `MCPServiceUnavailableError`

Internal hostname used: `process.env.WEB_HOSTNAME_MCP_MANAGER` (line 30)

Importers:
- `apps/web/src/core/hooks/use-mcp-mentions.ts` (CLIENT) — imports `MCPServiceUnavailableError` only (not mcpManagerFetch)
- `apps/web/src/lib/services/mcp-manager/fetch.ts` (SERVER) — imports `mcpManagerFetch`

The CLIENT importer (`use-mcp-mentions.ts`) only imports the error class, not the function that reads the environment variable. The actual `mcpManagerFetch()` function is defined as async and only exported to server code (`mcp-manager/fetch.ts`).

| Importer | Type | Functions Used | Action needed for Task 7 |
|---|---|---|---|
| apps/web/src/core/hooks/use-mcp-mentions.ts | client | MCPServiceUnavailableError (error class only, not env-reading function) | None — MCPServiceUnavailableError is a pure class, no env usage |
| apps/web/src/lib/services/mcp-manager/fetch.ts | server | mcpManagerFetch | None — keep direct env read, add `import 'server-only'` to mcp-manager/utils.ts |

## Decision summary

### helpers.ts
- Status: **HAS CLIENT IMPORTERS** (7 client files import `pathToApiUrl`)
- These 7 client components directly call `pathToApiUrl()` which reads `process.env.WEB_HOSTNAME_API` and `process.env.WEB_PORT_API`
- Currently this works because the env vars are public (baked at build time for client bundle)
- After migration to runtime config, these 7 files need refactoring to call a route handler proxy instead

### billing/utils.ts
- Status: **ALL SERVER** (only `billing/fetch.ts` uses `billingFetch`)
- No client importers of `billingFetch`
- Architecture is safe; no refactoring needed beyond adding `import 'server-only'`

### mcp-manager/utils.ts
- Status: **SAFE - CLIENT ONLY IMPORTS ERROR CLASS** (use-mcp-mentions.ts imports `MCPServiceUnavailableError`, not the function)
- The actual `mcpManagerFetch()` is only used in `mcp-manager/fetch.ts` (SERVER)
- No refactoring needed beyond adding `import 'server-only'`

## Implication for Task 7

**Task 7 must create route handler proxies for helpers.ts before proceeding.**

Action plan:
1. Add `import 'server-only'` to `apps/web/src/core/utils/helpers.ts` (pathToApiUrl, createUrl)
2. Add `import 'server-only'` to `apps/web/src/features/ee/subscription/_services/billing/utils.ts`
3. Add `import 'server-only'` to `apps/web/src/lib/services/mcp-manager/utils.ts`
4. **Create new route handler proxies:**
   - Create `/api/proxy/api` route handler that:
     - Calls `pathToApiUrl()` server-side
     - Receives path and method from client
     - Forwards request to the resolved API URL
     - Returns response to client
   - Refactor these 7 client files to call `/api/proxy/api` instead of `pathToApiUrl()` directly:
     - apps/web/src/app/(app)/issues/_components/issue-details-right-sheet.tsx
     - apps/web/src/app/(app)/issues/_components/severity-level-select.tsx
     - apps/web/src/app/(app)/issues/_components/status-select.tsx
     - apps/web/src/app/(app)/settings/_components/route-button-with-override-count.tsx
     - apps/web/src/app/(app)/settings/code-review/[repositoryId]/custom-messages/page.tsx
     - apps/web/src/features/ee/sso/_page-component.tsx
     - apps/web/src/features/ee/subscription/_components/license-key-settings.tsx
