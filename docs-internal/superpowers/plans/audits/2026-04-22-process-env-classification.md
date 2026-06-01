# Audit — process.env.* classification in apps/web/src

Date: 2026-04-22
Resolves design open question Q4 (`docs/superpowers/specs/2026-04-15-web-runtime-config-design.md`).

Total raw occurrences: 59 (after excluding `.spec.` files)
Total unique files: 25

## Server-only envs (stay as process.env.X, gain `import 'server-only'` per Task 7)

| Env | File | Line | Notes |
|---|---|---|---|
| WEB_HOSTNAME_API | apps/web/src/core/utils/helpers.ts | 22 | Pre-classified by Task 0a |
| WEB_PORT_API | apps/web/src/core/utils/helpers.ts | 35 | Pre-classified by Task 0a |
| WEB_NODE_ENV | apps/web/src/core/utils/helpers.ts | 52 | Server-only usage; also in self-hosted.ts |
| WEB_NODE_ENV | apps/web/src/core/utils/self-hosted.ts | 1 | Helper: `isSelfHosted` check |
| WEB_HOSTNAME_BILLING | apps/web/src/features/ee/subscription/_services/billing/utils.ts | 9 | Pre-classified by Task 0a |
| WEB_PORT_BILLING | apps/web/src/features/ee/subscription/_services/billing/utils.ts | 18 | Pre-classified by Task 0a |
| WEB_HOSTNAME_MCP_MANAGER | apps/web/src/lib/services/mcp-manager/utils.ts | 30 | Pre-classified by Task 0a |
| WEB_PORT_MCP_MANAGER | apps/web/src/lib/services/mcp-manager/utils.ts | 46 | Pre-classified by Task 0a |
| WEB_OAUTH_GITHUB_CLIENT_ID | apps/web/src/core/config/auth.ts | 56 | Used in NextAuth server config only |
| WEB_OAUTH_GITHUB_CLIENT_SECRET | apps/web/src/core/config/auth.ts | 57 | Used in NextAuth server config only |
| WEB_OAUTH_GITLAB_CLIENT_ID | apps/web/src/core/config/auth.ts | 66 | Used in NextAuth server config only |
| WEB_OAUTH_GITLAB_CLIENT_SECRET | apps/web/src/core/config/auth.ts | 67 | Used in NextAuth server config only |
| WEB_GITLAB_OAUTH_URL | apps/web/src/core/config/auth.ts | 60 | NextAuth server config |
| WEB_GITLAB_OAUTH_URL | apps/web/src/core/config/auth.ts | 61 | NextAuth server config |
| WEB_NEXTAUTH_SECRET | apps/web/src/core/config/auth.ts | 100 | NextAuth server config |
| AUTH_SECRET | apps/web/src/core/config/auth.ts | 102 | NextAuth fallback |
| NEXTAUTH_SECRET | apps/web/src/core/config/auth.ts | 101 | NextAuth fallback |
| NODE_ENV | apps/web/src/core/config/auth.ts | 103 | Conditional check |
| NODE_ENV | apps/web/src/lib/services/fetch.ts | 60 | Dev-only logging |
| NODE_ENV | apps/web/src/lib/services/kodyRules/fetch.ts | 163 | Dev-only logging |
| GLOBAL_API_CONTAINER_NAME | apps/web/src/core/utils/helpers.ts | 14 | Server-side networking config |
| GLOBAL_BILLING_CONTAINER_NAME | apps/web/src/features/ee/subscription/_services/billing/utils.ts | 14 | Server-side networking config |
| GLOBAL_MCP_MANAGER_CONTAINER_NAME | apps/web/src/lib/services/mcp-manager/utils.ts | 42 | Server-side networking config |
| GLOBAL_GITLAB_CLIENT_ID | apps/web/src/core/integrations/gitlabConnection.ts | 5 | OAuth module-level read (server only per auth.ts) |
| GLOBAL_GITLAB_REDIRECT_URL | apps/web/src/core/integrations/gitlabConnection.ts | 6 | OAuth module-level read (server only per auth.ts) |
| WEB_GITLAB_OAUTH_URL | apps/web/src/core/integrations/gitlabConnection.ts | 3 | OAuth module-level read |
| WEB_GITLAB_SCOPES | apps/web/src/core/integrations/gitlabConnection.ts | 4 | OAuth module-level read |
| WEB_GITHUB_INSTALL_URL | apps/web/src/core/integrations/gitHubConnection.ts | 3 | Module-level read (server file) |
| WEB_BITBUCKET_INSTALL_URL | apps/web/src/core/integrations/bitbucketConnection.ts | 3 | Module-level read (server file) |
| WEB_POSTHOG_KEY | apps/web/src/core/utils/posthog-server-side.ts | 7 | Server-side analytics initialization |
| WEB_POSTHOG_KEY | apps/web/src/core/utils/posthog-server-side.ts | 61 | Conditional check |
| WEB_POSTHOG_KEY | apps/web/src/core/utils/posthog-server-side.ts | 117 | Conditional check |
| WEB_POSTHOG_KEY | apps/web/src/core/utils/posthog.ts | 5 | Client-side analytics (server module) |
| WEB_POSTHOG_KEY | apps/web/src/core/utils/posthog.ts | 6 | Client-side analytics initialization (server module) |
| WEB_ANALYTICS_SECRET | apps/web/src/features/ee/cockpit/_services/analytics/utils.ts | 18 | Server-side auth check |
| WEB_ANALYTICS_SECRET | apps/web/src/features/ee/cockpit/_services/analytics/utils.ts | 51 | Server-side auth header |
| WEB_ANALYTICS_HOSTNAME | apps/web/src/features/ee/cockpit/_services/analytics/utils.ts | 25 | Server-side networking |
| WEB_PORT_ANALYTICS | apps/web/src/features/ee/cockpit/_services/analytics/utils.ts | 26 | Server-side networking |
| WEB_ANALYTICS_SECRET | apps/web/src/features/ee/cockpit/layout.tsx | 51 | Server-side gating in layout |
| WEB_TOKEN_DOCS_GITHUB | apps/web/src/core/components/system/git-token-docs.tsx | 5 | Server-only file |
| WEB_TOKEN_DOCS_GITLAB | apps/web/src/core/components/system/git-token-docs.tsx | 6 | Server-only file |
| WEB_TOKEN_DOCS_BITBUCKET | apps/web/src/core/components/system/git-token-docs.tsx | 7 | Server-only file |
| WEB_TOKEN_DOCS_AZUREREPOS | apps/web/src/core/components/system/git-token-docs.tsx | 8 | Server-only file |
| RELEASE_VERSION | apps/web/src/app/api/version/route.ts | 6 | Route handler (server only) |

## Client-needed envs (migrate to publicConfig + useConfig() in Waves 1-4)

| Env | File | Line | Wave | Notes |
|---|---|---|---|---|
| GLOBAL_GITLAB_CLIENT_ID | apps/web/src/core/integrations/gitlabConnection.ts | 5 | 1 | OAuth — also used in Wave 1 migration |
| GLOBAL_GITLAB_REDIRECT_URL | apps/web/src/core/integrations/gitlabConnection.ts | 6 | 1 | OAuth redirect — also used in Wave 1 migration |
| WEB_GITLAB_SCOPES | apps/web/src/core/integrations/gitlabConnection.ts | 4 | 1 | OAuth scopes — also used in Wave 1 migration |
| WEB_GITLAB_OAUTH_URL | apps/web/src/core/integrations/gitlabConnection.ts | 3 | 1 | OAuth URL — also used in Wave 1 migration |
| WEB_SUPPORT_DOCS_URL | apps/web/src/core/components/system/get-started-checklist.tsx | 41 | 2 | Client component link |
| WEB_SUPPORT_DOCS_URL | apps/web/src/core/components/system/get-started-sidebar-button.tsx | 47 | 2 | Client component link |
| WEB_SUPPORT_DOCS_URL | apps/web/src/core/components/system/support-sidebar-button.tsx | 85 | 2 | Client component link |
| WEB_SUPPORT_DOCS_URL | apps/web/src/core/layout/navbar/_components/support.tsx | 27 | 2 | Client component link |
| WEB_SUPPORT_DISCORD_INVITE_URL | apps/web/src/app/(setup)/setup/choose-workspace/page.tsx | 168 | 2 | Client page link |
| WEB_SUPPORT_DISCORD_INVITE_URL | apps/web/src/core/components/system/support-sidebar-button.tsx | 102 | 2 | Client component link |
| WEB_SUPPORT_DISCORD_INVITE_URL | apps/web/src/core/layout/navbar/_components/support.tsx | 35 | 2 | Client component link |
| NEXT_PUBLIC_WEB_SUPPORT_DOCS_URL | apps/web/src/core/components/system/support-sidebar-button.tsx | 84 | 2 | Already marked NEXT_PUBLIC (redundant with WEB_SUPPORT_DOCS_URL) |
| WEB_TOKEN_DOCS_GITHUB | apps/web/src/core/components/system/git-token-docs.tsx | 5 | 2 | **DISCREPANCY** — file marked server but exports object for client use |
| WEB_TOKEN_DOCS_GITLAB | apps/web/src/core/components/system/git-token-docs.tsx | 6 | 2 | **DISCREPANCY** — file marked server but exports object for client use |
| WEB_TOKEN_DOCS_BITBUCKET | apps/web/src/core/components/system/git-token-docs.tsx | 7 | 2 | **DISCREPANCY** — file marked server but exports object for client use |
| WEB_TOKEN_DOCS_AZUREREPOS | apps/web/src/core/components/system/git-token-docs.tsx | 8 | 2 | **DISCREPANCY** — file marked server but exports object for client use |
| WEB_GITHUB_INSTALL_URL | apps/web/src/core/integrations/gitHubConnection.ts | 3 | 3 | OAuth install URL — also used in Wave 3 migration |
| WEB_BITBUCKET_INSTALL_URL | apps/web/src/core/integrations/bitbucketConnection.ts | 3 | 3 | OAuth install URL — also used in Wave 3 migration |
| WEB_RULE_FILES_DOCS | apps/web/src/app/(app)/settings/code-review/_components/generate-rules-options/index.tsx | 250 | 4 | Client component link |

## Mixed envs (server + client, decision needed)

| Env | Server use | Client use | Decision |
|---|---|---|---|
| WEB_NODE_ENV | apps/web/src/core/utils/helpers.ts:52, apps/web/src/core/utils/self-hosted.ts:1 | apps/web/src/app/(auth)/sso-callback/page.tsx:13 | **KEEP SERVER-ONLY** — sso-callback needs conditional server-side logic; refactor client caller to use route handler proxy or remove env check from client. Note: sso-callback IS marked `"use client"` but uses WEB_NODE_ENV to gate redirect logic that should be server-only. Task 7 refactor will need to extract this check into a server action or route handler. |
| WEB_SUPPORT_TALK_TO_FOUNDER_URL | apps/web/src/features/ee/subscription/@status/_components/_modals/select-new-plan.tsx:340 | apps/web/src/core/components/system/support-sidebar-button.tsx:119, apps/web/src/core/layout/navbar/_components/support.tsx:43, apps/web/src/features/ee/subscription/choose-plan/page.client.tsx:428 | **MIGRATE TO WAVE 2** — 3 client usages outweigh 1 server usage. Move to publicConfig. Server usage in select-new-plan.tsx should be refactored to accept URL as prop or via context. |

## Wave assignment summary

- **Wave 1 (OAuth)**: 4 envs (GLOBAL_GITLAB_CLIENT_ID, GLOBAL_GITLAB_REDIRECT_URL, WEB_GITLAB_SCOPES, WEB_GITLAB_OAUTH_URL), 2-4 consumer files
  - All currently in server-only file (gitlabConnection.ts)
  - Auth.ts also reads GLOBAL_GITLAB_CLIENT_ID + GLOBAL_GITLAB_REDIRECT_URL as part of server config
  - These will migrate to publicConfig but consumers (gitlabConnection.ts) are server files that won't change their file classification
  
- **Wave 2 (Doc/Support)**: 7 client-needed envs + 2 mixed → 9 total (WEB_SUPPORT_DOCS_URL, WEB_SUPPORT_DISCORD_INVITE_URL, WEB_SUPPORT_TALK_TO_FOUNDER_URL, WEB_TOKEN_DOCS_GITHUB, WEB_TOKEN_DOCS_GITLAB, WEB_TOKEN_DOCS_BITBUCKET, WEB_TOKEN_DOCS_AZUREREPOS), ~10 consumer files across client components
  - Includes NEXT_PUBLIC_WEB_SUPPORT_DOCS_URL (redundant with WEB_SUPPORT_DOCS_URL — consolidate to one)
  - WEB_TOKEN_DOCS_* in git-token-docs.tsx (server file) but likely imported by client components
  - WEB_SUPPORT_TALK_TO_FOUNDER_URL is mixed; migrate to Wave 2

- **Wave 3 (Install URLs)**: 2 envs (WEB_GITHUB_INSTALL_URL, WEB_BITBUCKET_INSTALL_URL), 2 consumer files
  - Both in server-only integration files (gitHubConnection.ts, bitbucketConnection.ts)
  - Currently module-level reads; will need refactor to support client-side reading via publicConfig

- **Wave 4 (Release/Terms/Rules)**: 3 envs (RELEASE_VERSION, WEB_TERMS_AND_CONDITIONS, WEB_RULE_FILES_DOCS), 3 consumer files
  - RELEASE_VERSION: route handler (server only)
  - WEB_RULE_FILES_DOCS: client component (generate-rules-options/index.tsx)
  - WEB_TERMS_AND_CONDITIONS: not found in current codebase — **DISCREPANCY**

- **Server-only (Task 7)**: 8 envs + 3 mixed → 11 total (WEB_NODE_ENV, WEB_HOSTNAME_API, WEB_PORT_API, WEB_HOSTNAME_BILLING, WEB_PORT_BILLING, WEB_HOSTNAME_MCP_MANAGER, WEB_PORT_MCP_MANAGER, plus 3 in auth.ts + NODE_ENV variants), ~15 consumer files
  - All internal hostnames/ports: no migration needed, just add `import 'server-only'`
  - AUTH_SECRET, NEXTAUTH_SECRET, WEB_NEXTAUTH_SECRET: NextAuth server config
  - NODE_ENV / WEB_NODE_ENV: used for conditional server-side logic
  - Container names (GLOBAL_*_CONTAINER_NAME): internal networking
  - WEB_POSTHOG_KEY: used in server-side analytics; also in client-side posthog.ts (but server module, no directive)
  - WEB_ANALYTICS_*: internal backend networking
  - WEB_TOKEN_DOCS_*: see Wave 2 discrepancy

## Discrepancies vs. plan

1. **git-token-docs.tsx marked "server" but likely imported by client**
   - File has no `"use client"` directive, so classified as server by Task 0b rules
   - However, it exports a plain object containing WEB_TOKEN_DOCS_* values
   - If imported by client components, it enables tree-shaking of the env reads; no actual client usage of process.env directly
   - Wave 2 task should verify: either add `"use client"` directive to git-token-docs.tsx, or leave as-is and migrate WEB_TOKEN_DOCS_* to publicConfig anyway
   - **Action**: Task 4 (Wave 2) must check git-token-docs.tsx imports; if client components import it, add directive or refactor exports to use useConfig()

2. **WEB_TERMS_AND_CONDITIONS not found in apps/web/src**
   - Plan lists it in Wave 4, but grep found zero occurrences
   - May be unused, removed in a recent commit, or defined differently
   - **Action**: Task 6 (Wave 4) should verify before adding to publicConfig

3. **NEXT_PUBLIC_WEB_SUPPORT_DOCS_URL appears alongside WEB_SUPPORT_DOCS_URL**
   - Both reference the same value in support-sidebar-button.tsx (lines 84–85)
   - NEXT_PUBLIC_ is the Next.js convention for inlining values into the bundle at build time
   - WEB_SUPPORT_DOCS_URL is the custom env that will migrate to publicConfig
   - **Action**: Task 4 (Wave 2) should remove the NEXT_PUBLIC_ reference once publicConfig is in place; update next.config.js to stop injecting NEXT_PUBLIC_WEB_SUPPORT_DOCS_URL

4. **sso-callback/page.tsx is a client component using WEB_NODE_ENV**
   - File marked `"use client"` but reads WEB_NODE_ENV for server-side gating
   - This suggests the env check in sso-callback should be moved to a server action or route handler
   - **Action**: Task 7 (server-only) must refactor sso-callback to move the WEB_NODE_ENV check out of the client component, either into a server action or middleware

5. **select-new-plan.tsx uses client hooks but no directive**
   - File uses useState and useRouter without `"use client"` directive
   - Likely relies on a parent layout having the directive
   - Reads WEB_SUPPORT_TALK_TO_FOUNDER_URL and should be treated as client for Wave 2 purposes
   - **Action**: Task 4 (Wave 2) should treat as client; optionally add `"use client"` directive for clarity

6. **OAuth modules (gitlabConnection, gitHubConnection, bitbucketConnection) are server files but contain values for Wave 1 & 3**
   - These modules do module-level reads of process.env (e.g., `const github = process.env.WEB_GITHUB_INSTALL_URL || ""`; `const clientId = process.env.GLOBAL_GITLAB_CLIENT_ID`)
   - In current next.config.js, these are build-time inlined, so no runtime penalty
   - Post-migration, these modules must be refactored to read from publicConfig or accept the values as arguments
   - **Action**: Waves 1 and 3 must include refactoring of integration modules to support runtime config reading (likely via dependency injection or factory pattern)

## Summary of findings

| Category | Count | Notes |
|---|---|---|
| Total unique envs found | 39 | Across 25 files, 59 occurrences |
| Server-only (no client use) | 29 | Include auth, internal hostnames, analytics, posthog |
| Client-needed (client use only) | 8 | Wave 1–4 candidates |
| Mixed (both) | 2 | WEB_NODE_ENV, WEB_SUPPORT_TALK_TO_FOUNDER_URL — both need decisions |
| Discrepancies found | 6 | See "Discrepancies vs. plan" section |

**Recommendation before proceeding to Task 1:**
- Clarify Wave 4 status of WEB_TERMS_AND_CONDITIONS (unused?)
- Verify git-token-docs.tsx imports in client components (adds `"use client"` or refactor)
- Document refactor strategy for integration modules (Waves 1 & 3) — factory injection or dependency prop injection
