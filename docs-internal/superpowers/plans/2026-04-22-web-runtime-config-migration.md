# Web Runtime Config Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move env injection in `apps/web` from build-time (next.config.js `env:` block) to runtime via Server Component → Client Context, eliminating the multi-replica 404 bug and the divergent `Dockerfile.web.selfhosted`.

**Architecture:** Server component root layout reads `process.env.X` per request and passes it to a `ConfigProvider` (client component) as a prop. Next.js serializes the prop in the SSR HTML; client hydrates the React Context. Any client component reads values via `useConfig()` hook instead of `process.env.X` directly. Internal hostnames stay server-only via `import 'server-only'` and are accessed only from route handlers / SSR / server actions / middleware.

**Tech Stack:** Next.js 14+ App Router, React Context, TypeScript, Jest (root `jest.config.ts` covers `apps/web` specs).

---

## Source-of-truth design doc

`docs/superpowers/specs/2026-04-15-web-runtime-config-design.md` (status: **Approved** as of 2026-04-22).

This plan implements its **Estado desejado** and **Plano de migração** sections one-to-one. Cross-reference task numbers below to design doc steps.

## Open questions answered before plan

| Doc | Status | Source |
|---|---|---|
| **Q1** Where does CI pass `RELEASE_VERSION`? | ✅ Already passed in 4 workflows + bake var | `web-build-push-production.yml:116`, `selfhosted-build-push.yml:163`, `prod-build-push-and-pr-green.yml:152`, `qa-build-push-and-pr-green.yml:127`, `docker-bake.hcl:5,37,66`, `Dockerfile.web:8-9` |
| **Q2** Self-hosted publishes via GHCR or local build? | ✅ GHCR — `ghcr.io/kodustech/kodus-ai-web` | `selfhosted-build-push.yml:158` |
| **Q3** Are internal-hostname helpers imported from client components? | 🔎 Resolved by **Task 0a** below | — |
| **Q4** Full classification of `process.env.*` in `apps/web/src` | 🔎 Resolved by **Task 0b** below | 26 files / 62 occurrences known |

## Constraints inherited from this codebase / user

- **Never auto-create PRs.** Each task ends with `git push origin <branch>`. **Stop before `gh pr create`.** User opens PRs manually via GitHub UI.
- **Show diff before commit.** Every commit gate runs `git diff <files>` and waits for explicit user approval before `git add` + `git commit`.
- **Each task is mergeable independently and reversible.** A revert of any single task does not break the previous task's behavior. The only ordering constraint is documented in each task's "Depends on" line.
- **No new test framework setup.** `apps/web` shares the repo-root `jest.config.ts`. Use it where unit tests make sense (helpers, hooks). For UI migrations rely on `tsc --noEmit`, `next build`, `eslint`, and a manual browser smoke note per wave.

## Branch strategy

Two reasonable groupings — **user picks before execution**:

- **Granular (10 branches, 10 PRs):** one branch per Task. Easiest to revert any single onda.
- **Grouped (5 branches, 5 PRs):** pre-flight (Tasks 0a+0b), foundation (Tasks 1+2), waves (Tasks 3-6), server-only (Task 7), cleanup (Tasks 8+9+10). Fewer PR rounds.

Default in this plan: **Granular**. To group, the user just stays on the same branch across consecutive tasks before pushing.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `apps/web/src/core/config/publicConfig.ts` | Create (Task 1) | `PublicConfig` type definition + `defaultPublicConfig` constant |
| `apps/web/src/core/providers/ConfigProvider.tsx` | Create (Task 1) | Client-side React Context `ConfigProvider` + `useConfig()` hook |
| `apps/web/src/app/layout.tsx` | Modify (Task 1, then per-wave) | Root server component — reads `process.env.X` and passes `publicConfig` to provider |
| `apps/web/next.config.js` | Modify (Tasks 2, 3, 4, 5, 6, 8) | Add `generateBuildId`; remove envs from `env:` block as each wave migrates; finally delete the `env:` block |
| `apps/web/src/core/integrations/gitlabConnection.ts` | Modify (Task 3 — Wave 1) | Read OAuth values from `useConfig()`. Refactor to factory or constructor injection (was reading `process.env.X` at module top-level). |
| `apps/web/src/core/integrations/gitHubConnection.ts` | Modify (Task 5 — Wave 3) | Read install URL from `useConfig()`. Same factory refactor. |
| `apps/web/src/core/integrations/bitbucketConnection.ts` | Modify (Task 5 — Wave 3) | Read install URL from `useConfig()`. Same factory refactor. |
| `apps/web/src/core/components/system/support-sidebar-button.tsx` | Modify (Task 4 — Wave 2) | Replace `process.env.WEB_SUPPORT_*` → `useConfig().support*` |
| `apps/web/src/core/components/system/get-started-sidebar-button.tsx` | Modify (Task 4 — Wave 2) | idem |
| `apps/web/src/core/components/system/get-started-checklist.tsx` | Modify (Task 4 — Wave 2) | idem |
| `apps/web/src/core/components/system/git-token-docs.tsx` | Modify (Task 4 — Wave 2) | Replace `process.env.WEB_TOKEN_DOCS_*` → `useConfig().tokenDocs*` |
| `apps/web/src/app/(setup)/setup/choose-workspace/page.tsx` | Modify (Task 4 — Wave 2) | Replace `process.env.WEB_SUPPORT_DISCORD_INVITE_URL` |
| `apps/web/src/app/(app)/settings/code-review/_components/generate-rules-options/index.tsx` | Modify (Task 6 — Wave 4) | Replace `process.env.WEB_RULE_FILES_DOCS` |
| `apps/web/src/core/utils/helpers.ts` | Modify (Task 7) | Add `import 'server-only'` (currently uses `WEB_HOSTNAME_API`/`WEB_PORT_API`) |
| `apps/web/src/features/ee/subscription/_services/billing/utils.ts` | Modify (Task 7) | Add `import 'server-only'` (currently uses `WEB_HOSTNAME_BILLING`) |
| `apps/web/src/lib/services/mcp-manager/utils.ts` | Modify (Task 7) | Add `import 'server-only'` (currently uses `WEB_HOSTNAME_MCP_MANAGER`) |
| `apps/web/src/app/api/proxy/<service>/route.ts` | Possibly create (Task 7 — only if Task 0a finds client imports) | Next route handler that proxies browser → internal backend hostname |
| `docker/Dockerfile.web.selfhosted` | Delete (Task 9) | No longer needed |
| `docker-bake.hcl` | Modify (Task 9) | Update `target "web"` to point at `Dockerfile.web` (or remove if redundant) |
| `.github/workflows/selfhosted-build-push.yml` | Modify (Task 10) | Remove any reference to `Dockerfile.web.selfhosted`, point to unified image |
| `.github/workflows/web-qa-deploy.yml` | Modify (Task 10) | Drop the trigger path on `Dockerfile.web.selfhosted` |
| `README.md` and/or `README_DEPLOY.md` | Modify (Task 9) | Self-hosted instructions point to `ghcr.io/kodustech/kodus-ai-web:<version>` instead of building local |

---

## Pre-flight audits

These resolve the design doc's open questions (Q3, Q4) before any code changes touch behavior.

### Task 0a: Audit `'use client'` imports of internal-hostname helpers

**Branch:** `chore/audit-internal-hostname-client-usage`

**Files:**
- Read: `apps/web/src/core/utils/helpers.ts`
- Read: `apps/web/src/features/ee/subscription/_services/billing/utils.ts`
- Read: `apps/web/src/lib/services/mcp-manager/utils.ts`
- Create: `docs/superpowers/plans/audits/2026-04-22-internal-hostname-callers.md` (output of this audit)

**Depends on:** none

**Why:** Design doc Q3 — "Existe algum client component que chama backend direto via `WEB_HOSTNAME_API` (não via proxy Next)? Se sim, tem um refactor adicional de roteamento antes do item 4 do plano de migração." Task 7 cannot proceed safely until this is answered.

- [ ] **Step 1: List every importer of each helper**

Run for each helper:

```bash
cd /Users/wellingtonsantana/Documents/kodus-git/kodus-ai

grep -rnE "from ['\"].*core/utils/helpers['\"]" apps/web/src --include="*.ts" --include="*.tsx"
grep -rnE "from ['\"].*features/ee/subscription/_services/billing/utils['\"]" apps/web/src --include="*.ts" --include="*.tsx"
grep -rnE "from ['\"].*lib/services/mcp-manager/utils['\"]" apps/web/src --include="*.ts" --include="*.tsx"
```

Expected: list of importer files. Save the output.

- [ ] **Step 2: For each importer, classify it as client or server**

For each importer file from Step 1:

```bash
head -1 <importer-file>
```

A file is **client** if its first non-blank line is `"use client";`. Otherwise, it's **server** by Next.js App Router default.

- [ ] **Step 3: Write the audit report**

Create `docs/superpowers/plans/audits/2026-04-22-internal-hostname-callers.md` with this table per helper:

```markdown
## helpers.ts (WEB_HOSTNAME_API, WEB_PORT_API)

| Importer | Type | Action needed |
|---|---|---|
| apps/web/src/path/X.tsx | client | Move logic to a route handler proxy, call /api/proxy/api from client |
| apps/web/src/path/Y.ts | server | None — keep direct env read |
```

Decision: if **any** importer is client, Task 7 must include a Next route handler proxy (`apps/web/src/app/api/proxy/<service>/route.ts`) and the client importer migrates to fetch that local path instead. If **all** importers are server, Task 7 just adds `import 'server-only'`.

- [ ] **Step 4: Show diff and commit**

```bash
git status docs/superpowers/plans/audits/
git diff --stat
```

Wait for user approval, then:

```bash
git add docs/superpowers/plans/audits/2026-04-22-internal-hostname-callers.md
git commit -m "chore(web): audit internal-hostname helper client usage (design Q3)"
```

- [ ] **Step 5: Push branch — stop before opening PR**

```bash
git push -u origin chore/audit-internal-hostname-client-usage
```

**Do NOT run `gh pr create`.** Report branch URL to user; user opens the PR via GitHub web UI.

---

### Task 0b: Classify all `process.env.*` occurrences in `apps/web/src`

**Branch:** `chore/audit-process-env-usage` (or same branch as 0a if grouping pre-flight)

**Files:**
- Create: `docs/superpowers/plans/audits/2026-04-22-process-env-classification.md`

**Depends on:** none (parallel with Task 0a)

**Why:** Design doc Q4 — "rodar `grep -rn 'process\.env\.' apps/web/src` e classificar cada ocorrência (server-only, client-needed, misto)." Subsequent waves rely on this map to know which envs go to `publicConfig` vs stay server-only.

- [ ] **Step 1: Generate raw list**

```bash
cd /Users/wellingtonsantana/Documents/kodus-git/kodus-ai
grep -rnE "process\.env\." apps/web/src --include="*.ts" --include="*.tsx" \
  | grep -v ".spec." \
  | sort -u > /tmp/web-process-env.txt
wc -l /tmp/web-process-env.txt
```

Expected: ~62 occurrences.

- [ ] **Step 2: For each occurrence, identify the file and its client/server nature**

For each unique file in `/tmp/web-process-env.txt`:

```bash
head -1 <file>
```

Tag client (starts with `"use client";`) or server (otherwise).

- [ ] **Step 3: Write classification report**

Create `docs/superpowers/plans/audits/2026-04-22-process-env-classification.md` with three tables:

```markdown
## Server-only envs (stay as process.env.X, gain `import 'server-only'`)

| Env | File | Line |
|---|---|---|
| WEB_HOSTNAME_API | apps/web/src/core/utils/helpers.ts | 22 |
...

## Client-needed envs (migrate to publicConfig + useConfig())

| Env | File | Line | Wave |
|---|---|---|---|
| WEB_GITHUB_INSTALL_URL | apps/web/src/core/integrations/gitHubConnection.ts | 3 | 3 |
...

## Mixed envs (used in both — split into PUBLIC_ + internal, or move helper)

| Env | Server use | Client use | Decision |
|---|---|---|---|
...
```

This map governs the four waves below. If anything contradicts the design doc's Wave assignments (4 OAuth + 7 Docs + 2 Install + 3 Release/Terms/Rules), fix the wave assignments here.

- [ ] **Step 4: Show diff and commit**

```bash
git diff --stat
```

Wait for user approval, then:

```bash
git add docs/superpowers/plans/audits/2026-04-22-process-env-classification.md
git commit -m "chore(web): classify process.env usage in apps/web (design Q4)"
```

- [ ] **Step 5: Push branch — stop before opening PR**

```bash
git push -u origin chore/audit-process-env-usage
```

---

## Implementation tasks

### Task 1: ConfigProvider scaffolding (design Step 1)

**Branch:** `feat/web-config-provider-scaffold`

**Files:**
- Create: `apps/web/src/core/config/publicConfig.ts`
- Create: `apps/web/src/core/providers/ConfigProvider.tsx`
- Modify: `apps/web/src/app/layout.tsx`

**Depends on:** Task 0b (need final list of client-needed envs to define `PublicConfig` type completely)

**Acceptance:** `next build` succeeds. Page renders. `useConfig()` returns the hardcoded values from layout (no consumers yet).

> **tsconfig note:** `apps/web/tsconfig.json` does not define a `@/*` alias — it uses prefix aliases per top-level dir (`@components/*` → `src/core/components/*`, etc.). This task adds two new aliases (`@providers/*` and `@config/*`) so the new code matches the existing convention. Subsequent tasks (3-6) use these aliases.

- [ ] **Step 0: Add path aliases for the new directories**

Modify `apps/web/tsconfig.json` `compilerOptions.paths`, adding:

```json
"@providers/*": ["src/core/providers/*"],
"@config/*": ["src/core/config/*"],
```

Place them next to the existing `@components/*` entry to keep the file ordered.

- [ ] **Step 1: Define the PublicConfig type**

Create `apps/web/src/core/config/publicConfig.ts`:

```ts
/**
 * Public runtime config exposed to the browser.
 *
 * Anything in this shape is serialized into the SSR HTML and visible to
 * any user with devtools. Treat it like public data. Server-only secrets
 * (database URLs, OAuth client secrets, internal hostnames) MUST NOT
 * appear here — keep them as direct `process.env.X` reads in server-only
 * modules guarded by `import 'server-only'`.
 */
export type PublicConfig = {
    githubInstallUrl: string;
    bitbucketInstallUrl: string;
    gitlabClientId: string;
    gitlabRedirectUrl: string;
    gitlabScopes: string;
    gitlabOauthUrl: string;
    supportDocsUrl: string;
    supportDiscordInviteUrl: string;
    supportTalkToFounderUrl: string;
    tokenDocsGithub: string;
    tokenDocsGitlab: string;
    tokenDocsBitbucket: string;
    tokenDocsAzureRepos: string;
    ruleFilesDocs: string;
    releaseVersion: string;
};
// Note: termsAndConditions / WEB_TERMS_AND_CONDITIONS removed per Task 0b
// audit — dead env, no consumers in apps/web/src.
```

- [ ] **Step 2: Create the ConfigProvider client component + hook**

Create `apps/web/src/core/providers/ConfigProvider.tsx`:

```tsx
"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { PublicConfig } from "@config/publicConfig";

const ConfigContext = createContext<PublicConfig | null>(null);

export function ConfigProvider({
    value,
    children,
}: {
    value: PublicConfig;
    children: ReactNode;
}) {
    return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): PublicConfig {
    const value = useContext(ConfigContext);
    if (!value) {
        throw new Error("useConfig() called outside of <ConfigProvider>");
    }
    return value;
}
```

- [ ] **Step 3: Mount ConfigProvider in the root server layout**

In `apps/web/src/app/layout.tsx`, add `import { ConfigProvider } from "@providers/ConfigProvider";` and wrap children:

```tsx
import { ConfigProvider } from "@providers/ConfigProvider";
import type { PublicConfig } from "@config/publicConfig";

// inside the default export, before returning JSX:
const publicConfig: PublicConfig = {
    githubInstallUrl: process.env.WEB_GITHUB_INSTALL_URL ?? "",
    bitbucketInstallUrl: process.env.WEB_BITBUCKET_INSTALL_URL ?? "",
    gitlabClientId: process.env.GLOBAL_GITLAB_CLIENT_ID ?? "",
    gitlabRedirectUrl: process.env.GLOBAL_GITLAB_REDIRECT_URL ?? "",
    gitlabScopes: process.env.WEB_GITLAB_SCOPES ?? "",
    gitlabOauthUrl: process.env.WEB_GITLAB_OAUTH_URL ?? "",
    supportDocsUrl: process.env.WEB_SUPPORT_DOCS_URL ?? "",
    supportDiscordInviteUrl: process.env.WEB_SUPPORT_DISCORD_INVITE_URL ?? "",
    supportTalkToFounderUrl: process.env.WEB_SUPPORT_TALK_TO_FOUNDER_URL ?? "",
    tokenDocsGithub: process.env.WEB_TOKEN_DOCS_GITHUB ?? "",
    tokenDocsGitlab: process.env.WEB_TOKEN_DOCS_GITLAB ?? "",
    tokenDocsBitbucket: process.env.WEB_TOKEN_DOCS_BITBUCKET ?? "",
    tokenDocsAzureRepos: process.env.WEB_TOKEN_DOCS_AZUREREPOS ?? "",
    ruleFilesDocs: process.env.WEB_RULE_FILES_DOCS ?? "",
    releaseVersion: process.env.RELEASE_VERSION ?? "",
};

// then in the JSX tree, the body content:
<body>
    <ConfigProvider value={publicConfig}>
        {/* existing children — likely already there */}
        {children}
    </ConfigProvider>
</body>
```

If `layout.tsx` already wraps children in other providers, place `ConfigProvider` as the **outermost** (or just inside `<body>`) so every descendant can call `useConfig()`.

- [ ] **Step 4: Validate**

```bash
cd apps/web
npx tsc --noEmit 2>&1 | grep -E "publicConfig|ConfigProvider|layout\.tsx" || echo "OK no errors in modified files"
yarn build 2>&1 | tail -30
```

Expected: typecheck clean for the three files; `next build` completes without new errors.

- [ ] **Step 5: Browser smoke**

```bash
yarn start &
sleep 10
curl -s http://localhost:3000 -o /dev/null -w "%{http_code}\n"
kill %1
```

Expected: 200 (or 307 redirect to /sign-in). No regression from main.

- [ ] **Step 6: Show diff and commit**

```bash
git diff --stat apps/web
git diff apps/web/src/core/config/publicConfig.ts apps/web/src/core/providers/ConfigProvider.tsx apps/web/src/app/layout.tsx
```

Wait for user approval, then:

```bash
git add apps/web/src/core/config/publicConfig.ts apps/web/src/core/providers/ConfigProvider.tsx apps/web/src/app/layout.tsx
git commit -m "feat(web): add PublicConfig type and ConfigProvider scaffolding

Empty Context wired into the server root layout. publicConfig is read
from process.env at every request and serialized into the SSR HTML. No
consumers yet — subsequent waves migrate process.env.X reads in client
components to useConfig()."
```

- [ ] **Step 7: Push branch — stop before opening PR**

```bash
git push -u origin feat/web-config-provider-scaffold
```

**Reversibility:** delete the three files / revert `layout.tsx` block.

---

### Task 2: Pin `generateBuildId` (design Step 2)

**Branch:** `fix/web-pin-build-id`

**Files:**
- Modify: `apps/web/next.config.js`

**Depends on:** none. **This task alone resolves the multi-replica 404** even before any wave migrates. Highest priority quick win.

**Acceptance:** `BUILD_ID` is the value of `RELEASE_VERSION`, falling back to `GIT_COMMIT_SHA`, falling back to `"dev"`. Two `next build` runs of the same SHA produce the same `BUILD_ID`.

- [ ] **Step 1: Add generateBuildId to next.config.js**

Modify `apps/web/next.config.js` — add the property right after `reactStrictMode: true`:

```js
generateBuildId: async () => {
    return (
        process.env.RELEASE_VERSION ||
        process.env.GIT_COMMIT_SHA ||
        "dev"
    );
},
```

(Use `||` not `??` so empty string falls through. Empty `RELEASE_VERSION` from CI must not become a `""` BUILD_ID.)

- [ ] **Step 2: Validate determinism locally**

```bash
cd apps/web
RELEASE_VERSION=2.1.0 yarn build 2>&1 | grep -E "BUILD_ID|Compiled|info" | head
cat .next/BUILD_ID
RELEASE_VERSION=2.1.0 yarn build 2>&1 | tail -5
diff <(cat .next/BUILD_ID) <(echo -n "2.1.0")
```

Expected: `.next/BUILD_ID` contains exactly `2.1.0`. Second build same SHA = same BUILD_ID.

- [ ] **Step 3: Show diff and commit**

```bash
git diff apps/web/next.config.js
```

Wait for user approval, then:

```bash
git add apps/web/next.config.js
git commit -m "fix(web): pin BUILD_ID to RELEASE_VERSION/GIT_COMMIT_SHA

Resolves 404 on static assets when self-hosted runs multiple replicas.
Without a stable BUILD_ID, each container start generated different
chunk hashes, so the HTML served by replica A referenced chunks that
didn't exist on replica B.

CI already passes RELEASE_VERSION via --build-arg in
web-build-push-production.yml, selfhosted-build-push.yml,
prod-build-push-and-pr-green.yml, and qa-build-push-and-pr-green.yml,
so this works out of the box."
```

- [ ] **Step 4: Push branch — stop before opening PR**

```bash
git push -u origin fix/web-pin-build-id
```

**Reversibility:** revert the single hunk.

---

### Task 3: Wave 1 — Migrate OAuth envs (design Step 3, Wave 1)

**Branch:** `refactor/web-runtime-config-wave1-oauth`

**Files:**
- Modify: `apps/web/src/core/integrations/gitlabConnection.ts`
- Modify: `apps/web/next.config.js` (remove the 4 envs from the `env:` block)
- Possibly modify: every callsite that constructs `new GitlabConnection()` (auditable in Step 1 below)

**Depends on:** Task 1 (`ConfigProvider` exists), Task 0b (confirms env classification)

**Envs migrated (4):** `GLOBAL_GITLAB_CLIENT_ID`, `GLOBAL_GITLAB_REDIRECT_URL`, `WEB_GITLAB_SCOPES`, `WEB_GITLAB_OAUTH_URL`

**Acceptance:** "Connect with GitLab" button on the integrations screen still launches OAuth correctly. `process.env.X` reads for these 4 envs no longer appear in client bundles.

- [ ] **Step 1: Find every consumer of GitlabConnection**

```bash
cd /Users/wellingtonsantana/Documents/kodus-git/kodus-ai
grep -rnE "GitlabConnection|new GitlabConnection" apps/web/src --include="*.ts" --include="*.tsx"
```

Save the list. Each callsite needs to be updated in Step 3.

- [ ] **Step 2: Refactor `gitlabConnection.ts` to take config as constructor arg**

Replace the entire content of `apps/web/src/core/integrations/gitlabConnection.ts`:

```ts
import { IIntegrationConnector } from "./IIntegrationConnector";
import type { PublicConfig } from "@config/publicConfig";

export class GitlabConnection implements IIntegrationConnector {
    constructor(private readonly cfg: PublicConfig) {}

    async connect(
        hasConnection: boolean,
        routerConfig: any,
        routerPath?: string,
    ) {
        if (hasConnection) {
            routerConfig.push(
                routerPath || `${routerConfig.pathname}/gitlab/configuration`,
            );
            return;
        }
        const { gitlabOauthUrl, gitlabClientId, gitlabRedirectUrl, gitlabScopes } = this.cfg;
        const state = Math.random().toString(36).substring(7);
        window.location.href =
            `${gitlabOauthUrl}?client_id=${gitlabClientId}` +
            `&redirect_uri=${gitlabRedirectUrl}` +
            `&response_type=code` +
            `&scope=${encodeURIComponent(gitlabScopes)}` +
            `&state=${state}`;
    }
}
```

- [ ] **Step 3: Update every callsite from Step 1**

For each callsite found in Step 1, change:

```ts
const conn = new GitlabConnection();
```

to:

```ts
const cfg = useConfig();
const conn = new GitlabConnection(cfg);
```

If a callsite is a server component that can't call `useConfig()`, that callsite was already broken (server components can't redirect via `window.location.href`). In that case, file a follow-up issue and skip — keep the migration pure.

- [ ] **Step 4: Remove the 4 envs from `next.config.js` `env:` block**

Modify `apps/web/next.config.js` — delete these lines from the `env:` block (around lines 132-135):

```js
GLOBAL_GITLAB_CLIENT_ID: process.env.GLOBAL_GITLAB_CLIENT_ID,
GLOBAL_GITLAB_REDIRECT_URL: process.env.GLOBAL_GITLAB_REDIRECT_URL,
WEB_GITLAB_SCOPES: process.env.WEB_GITLAB_SCOPES,
WEB_GITLAB_OAUTH_URL: process.env.WEB_GITLAB_OAUTH_URL,
```

- [ ] **Step 5: Validate**

```bash
cd apps/web
npx tsc --noEmit 2>&1 | grep -E "gitlabConnection|integrations" || echo "OK no errors in modified files"
yarn build 2>&1 | tail -20
yarn lint 2>&1 | tail -5
```

Expected: typecheck clean. Build passes.

- [ ] **Step 6: Browser smoke**

Boot the app, navigate to the integrations screen, click "Connect with GitLab" with no existing connection. Expected: redirect to a URL containing `client_id=<expected>&redirect_uri=<expected>&scope=<expected>`. Verify in browser address bar before redirect resolves.

```bash
# Document the test in commit message; no automated test exists for OAuth redirect
```

- [ ] **Step 7: Show diff and commit**

```bash
git diff --stat apps/web
git diff apps/web/src/core/integrations/gitlabConnection.ts apps/web/next.config.js
git diff <each callsite from Step 1>
```

Wait for user approval, then:

```bash
git add apps/web/src/core/integrations/gitlabConnection.ts apps/web/next.config.js <callsites>
git commit -m "refactor(web): wave 1 — read GitLab OAuth config via useConfig()

Removes GLOBAL_GITLAB_CLIENT_ID, GLOBAL_GITLAB_REDIRECT_URL,
WEB_GITLAB_SCOPES, WEB_GITLAB_OAUTH_URL from next.config.js env: block.
GitlabConnection now takes config via constructor; callsites pass the
result of useConfig().

Self-hosted operators can change these envs and restart the container
without rebuilding the image."
```

- [ ] **Step 8: Push branch — stop before opening PR**

```bash
git push -u origin refactor/web-runtime-config-wave1-oauth
```

**Reversibility:** revert the commit; OAuth callsites go back to instantiating `new GitlabConnection()`; envs reappear in `next.config.js`.

---

### Task 4: Wave 2 — Migrate Doc/Support URL envs (design Step 3, Wave 2)

**Branch:** `refactor/web-runtime-config-wave2-docs`

**Files:**
- Modify: `apps/web/src/core/components/system/support-sidebar-button.tsx`
- Modify: `apps/web/src/core/components/system/get-started-sidebar-button.tsx`
- Modify: `apps/web/src/core/components/system/get-started-checklist.tsx`
- Modify: `apps/web/src/core/components/system/git-token-docs.tsx`
- Modify: `apps/web/src/core/layout/navbar/_components/support.tsx` (added per Task 0b — 3 env reads not previously listed)
- Modify: `apps/web/src/features/ee/subscription/@status/_components/_modals/select-new-plan.tsx` (added per Task 0b — uses WEB_SUPPORT_TALK_TO_FOUNDER_URL server-side)
- Modify: `apps/web/src/features/ee/subscription/choose-plan/page.client.tsx` (added per Task 0b — uses WEB_SUPPORT_TALK_TO_FOUNDER_URL client-side)
- Modify: `apps/web/src/app/(setup)/setup/choose-workspace/page.tsx`
- Modify: `apps/web/next.config.js`

**Depends on:** Task 1, Task 0b

**Envs migrated (7):** `WEB_SUPPORT_DOCS_URL`, `WEB_SUPPORT_DISCORD_INVITE_URL`, `WEB_SUPPORT_TALK_TO_FOUNDER_URL`, `WEB_TOKEN_DOCS_GITHUB`, `WEB_TOKEN_DOCS_GITLAB`, `WEB_TOKEN_DOCS_BITBUCKET`, `WEB_TOKEN_DOCS_AZUREREPOS`

**Acceptance:** Sidebar support links, get-started checklist, navbar support menu, billing plan modal, and token docs popovers render with the same URLs as before. `process.env.X` for these 7 envs no longer in client bundles.

> **Heads-up from Task 0b audit** (`docs/superpowers/plans/audits/2026-04-22-process-env-classification.md`):
>
> - **Discrepancy #1** — `git-token-docs.tsx` has no `"use client"` directive but the const map it exports is consumed by client components. Step 4 below converts the map into a hook (`useTokenDocs`); the file then imports `useConfig`, which forces it to become a client module. Add `"use client";` at the top when refactoring.
> - **Discrepancy #3** — `support-sidebar-button.tsx:84-85` has `process.env.NEXT_PUBLIC_WEB_SUPPORT_DOCS_URL ?? process.env.WEB_SUPPORT_DOCS_URL ??`. The `NEXT_PUBLIC_` form is a stale alternate that was never set anywhere in the codebase. Step 1 collapses the chain to a single `cfg.supportDocsUrl ??` read.
> - **Discrepancy #5** — `select-new-plan.tsx` uses client-only hooks but is missing `"use client"`. It works today because a parent layout has the directive. When migrating its `WEB_SUPPORT_TALK_TO_FOUNDER_URL` read, add the directive explicitly so it's self-describing.
> - **Discrepancy #6** — `WEB_SUPPORT_TALK_TO_FOUNDER_URL` is mixed (3 client uses + 1 server use in `select-new-plan.tsx`). Migrate to `publicConfig` for all of them; the server usage in `select-new-plan.tsx` already runs inside a tree that will have `ConfigProvider` mounted, so `useConfig()` works fine.
> - Three additional consumer files were missing from the original Files list and have been added above: `support.tsx`, `select-new-plan.tsx`, `choose-plan/page.client.tsx`.

- [ ] **Step 1: Migrate `support-sidebar-button.tsx`**

In `apps/web/src/core/components/system/support-sidebar-button.tsx`:

- Add `import { useConfig } from "@providers/ConfigProvider";` at the top.
- Inside the component (it's already a client component with `"use client"`), add `const cfg = useConfig();` at the top of the function body.
- Replace each `process.env.WEB_SUPPORT_*` with the corresponding `cfg.support*`. Specifically:
    - Line 84-85 block (`process.env.NEXT_PUBLIC_WEB_SUPPORT_DOCS_URL ?? process.env.WEB_SUPPORT_DOCS_URL ?? ...`) → `cfg.supportDocsUrl ?? ...` (drop both old reads; the `NEXT_PUBLIC_` fallback is dead since we never set it).
    - Line 102: `process.env.WEB_SUPPORT_DISCORD_INVITE_URL ?? ...` → `cfg.supportDiscordInviteUrl ?? ...`
    - Line 119: `process.env.WEB_SUPPORT_TALK_TO_FOUNDER_URL ?? ...` → `cfg.supportTalkToFounderUrl ?? ...`

- [ ] **Step 2: Migrate `get-started-sidebar-button.tsx`**

Line 47:

```tsx
// before
href: process.env.WEB_SUPPORT_DOCS_URL as `https://`,
// after
const cfg = useConfig();  // add at top of component body
// then in the array literal:
href: cfg.supportDocsUrl as `https://`,
```

- [ ] **Step 3: Migrate `get-started-checklist.tsx`**

Same pattern as Step 2 — line 41.

- [ ] **Step 4: Migrate `git-token-docs.tsx`**

Lines 5-8 currently build a const map at module top-level. Move that map inside a hook or component. Replace:

```tsx
const tokenDocs = {
    github: process.env.WEB_TOKEN_DOCS_GITHUB,
    gitlab: process.env.WEB_TOKEN_DOCS_GITLAB,
    bitbucket: process.env.WEB_TOKEN_DOCS_BITBUCKET,
    azure_repos: process.env.WEB_TOKEN_DOCS_AZUREREPOS,
};
```

with a hook (export from this same file):

```tsx
export function useTokenDocs() {
    const cfg = useConfig();
    return {
        github: cfg.tokenDocsGithub,
        gitlab: cfg.tokenDocsGitlab,
        bitbucket: cfg.tokenDocsBitbucket,
        azure_repos: cfg.tokenDocsAzureRepos,
    };
}
```

Then update existing consumers to call `const tokenDocs = useTokenDocs();` instead of importing the const. Find consumers:

```bash
grep -rnE "from ['\"].*git-token-docs['\"]" apps/web/src --include="*.ts" --include="*.tsx"
```

- [ ] **Step 5: Migrate `(setup)/choose-workspace/page.tsx`**

Line 168 — same pattern as Step 2. If the file is a server component (check first line), add `"use client"` at the top is **not** acceptable here (page might be a server component for SEO). In that case: read `process.env.WEB_SUPPORT_DISCORD_INVITE_URL` directly in the server component (it's already a server-rendered constant) and don't migrate to `useConfig()`. Mark this exception in the commit message.

- [ ] **Step 6: Remove the 7 envs from `next.config.js`**

Delete these lines from the `env:` block:

```js
WEB_SUPPORT_DOCS_URL: process.env.WEB_SUPPORT_DOCS_URL,
WEB_SUPPORT_DISCORD_INVITE_URL: process.env.WEB_SUPPORT_DISCORD_INVITE_URL,
WEB_SUPPORT_TALK_TO_FOUNDER_URL: process.env.WEB_SUPPORT_TALK_TO_FOUNDER_URL,
WEB_TOKEN_DOCS_GITHUB: process.env.WEB_TOKEN_DOCS_GITHUB,
WEB_TOKEN_DOCS_GITLAB: process.env.WEB_TOKEN_DOCS_GITLAB,
WEB_TOKEN_DOCS_BITBUCKET: process.env.WEB_TOKEN_DOCS_BITBUCKET,
WEB_TOKEN_DOCS_AZUREREPOS: process.env.WEB_TOKEN_DOCS_AZUREREPOS,
```

- [ ] **Step 7: Validate**

```bash
cd apps/web
npx tsc --noEmit 2>&1 | grep -E "support-sidebar|get-started|git-token-docs|choose-workspace" || echo "OK"
yarn build 2>&1 | tail -20
yarn lint 2>&1 | tail -5
```

- [ ] **Step 8: Browser smoke**

Boot the app, hover on the support sidebar (3 links), open the get-started panel (1 link), open token-docs popover from the integrations connect screen (4 links), and verify each goes to the right URL.

- [ ] **Step 9: Show diff and commit**

```bash
git diff --stat apps/web
git diff apps/web/src/core/components/system apps/web/next.config.js apps/web/src/app/\(setup\)/setup/choose-workspace/page.tsx
```

Wait for user approval, then:

```bash
git add apps/web/src/core/components/system apps/web/next.config.js apps/web/src/app/\(setup\)/setup/choose-workspace/page.tsx
git commit -m "refactor(web): wave 2 — read doc/support URLs via useConfig()

Migrates 7 envs out of next.config.js env: block:
WEB_SUPPORT_DOCS_URL, WEB_SUPPORT_DISCORD_INVITE_URL,
WEB_SUPPORT_TALK_TO_FOUNDER_URL, WEB_TOKEN_DOCS_GITHUB,
WEB_TOKEN_DOCS_GITLAB, WEB_TOKEN_DOCS_BITBUCKET,
WEB_TOKEN_DOCS_AZUREREPOS."
```

- [ ] **Step 10: Push branch — stop before opening PR**

```bash
git push -u origin refactor/web-runtime-config-wave2-docs
```

**Reversibility:** revert the commit; envs reappear in `next.config.js`.

---

### Task 5: Wave 3 — Migrate Install URL envs (design Step 3, Wave 3)

**Branch:** `refactor/web-runtime-config-wave3-install`

**Files:**
- Modify: `apps/web/src/core/integrations/gitHubConnection.ts`
- Modify: `apps/web/src/core/integrations/bitbucketConnection.ts`
- Modify: `apps/web/next.config.js`
- Possibly modify: callsites that construct `new GitHubConnection()` / `new BitbucketConnection()`

**Depends on:** Task 1, Task 0b

**Envs migrated (2):** `WEB_GITHUB_INSTALL_URL`, `WEB_BITBUCKET_INSTALL_URL`

**Acceptance:** "Install GitHub App" / "Install Bitbucket App" buttons on the integrations screen still redirect to the correct app install URL.

- [ ] **Step 1: Find consumers**

```bash
grep -rnE "GitHubConnection|BitbucketConnection|new GitHubConnection|new BitbucketConnection" apps/web/src --include="*.ts" --include="*.tsx"
```

- [ ] **Step 2: Refactor `gitHubConnection.ts`**

Same pattern as Task 3 Step 2 — constructor takes `PublicConfig`:

```ts
import { IIntegrationConnector } from "./IIntegrationConnector";
import type { PublicConfig } from "@config/publicConfig";

export class GitHubConnection implements IIntegrationConnector {
    constructor(private readonly cfg: PublicConfig) {}

    async connect(
        hasConnection: boolean,
        routerConfig: any,
        routerPath?: string,
    ) {
        if (hasConnection) {
            routerConfig.push(
                routerPath || `${routerConfig.pathname}/github/configuration`,
            );
            return;
        }
        window.location.href = this.cfg.githubInstallUrl;
    }
}
```

- [ ] **Step 3: Refactor `bitbucketConnection.ts`**

Same pattern — adapt for `cfg.bitbucketInstallUrl`.

- [ ] **Step 4: Update callsites from Step 1**

Each `new GitHubConnection()` becomes `new GitHubConnection(cfg)`, where `cfg` comes from `useConfig()` in the same client component.

- [ ] **Step 5: Remove the 2 envs from `next.config.js`**

```js
WEB_GITHUB_INSTALL_URL: process.env.WEB_GITHUB_INSTALL_URL,
WEB_BITBUCKET_INSTALL_URL: process.env.WEB_BITBUCKET_INSTALL_URL,
```

- [ ] **Step 6: Validate**

```bash
cd apps/web
npx tsc --noEmit 2>&1 | grep -E "gitHubConnection|bitbucketConnection" || echo "OK"
yarn build 2>&1 | tail -20
```

- [ ] **Step 7: Browser smoke**

Click "Install GitHub App" and "Install Bitbucket App". Verify both redirect to the right URL.

- [ ] **Step 8: Show diff and commit**

```bash
git diff --stat apps/web
git diff apps/web/src/core/integrations apps/web/next.config.js <callsites>
```

Wait for user approval, then:

```bash
git add apps/web/src/core/integrations apps/web/next.config.js <callsites>
git commit -m "refactor(web): wave 3 — read install URLs via useConfig()

Migrates WEB_GITHUB_INSTALL_URL and WEB_BITBUCKET_INSTALL_URL out of
next.config.js env: block. Connectors take PublicConfig via constructor;
callsites pass useConfig()."
```

- [ ] **Step 9: Push branch — stop before opening PR**

```bash
git push -u origin refactor/web-runtime-config-wave3-install
```

**Reversibility:** revert the commit.

---

### Task 6: Wave 4 — Migrate Release/Terms/Rules envs (design Step 3, Wave 4)

**Branch:** `refactor/web-runtime-config-wave4-misc`

**Files:**
- Modify: `apps/web/src/app/(app)/settings/code-review/_components/generate-rules-options/index.tsx`
- Verify (likely no change): `apps/web/src/app/api/version/route.ts` — server-only route handler, keeps `process.env.RELEASE_VERSION`
- Modify: `apps/web/next.config.js`

**Depends on:** Task 1, Task 0b

**Envs migrated (3):** `RELEASE_VERSION`, `WEB_TERMS_AND_CONDITIONS`, `WEB_RULE_FILES_DOCS`

**Acceptance:** Footer/build-version text shows the correct release. Rule files docs link works. `process.env.X` for these envs no longer appear in client bundles **except** in the `/api/version` route.ts (it's server-only and can keep `process.env.RELEASE_VERSION`).

> **Heads-up from Task 0b audit** (`docs/superpowers/plans/audits/2026-04-22-process-env-classification.md`):
>
> - **Discrepancy #2 (revised 2026-04-22)** — `WEB_TERMS_AND_CONDITIONS` has **zero current consumers** in `apps/web/src`, but it is **end-to-end populated infra**: SSM (`/prod/kodus-web/WEB_TERMS_AND_CONDITIONS`, `/qa/kodus-web/WEB_TERMS_AND_CONDITIONS`) → CI workflows (`web-build-push-production.yml:74`, `web-qa-deploy.yml:63`) → `.env`, with a real Notion URL in dev. Treat as **orphan env with real value waiting for a consumer**, not dead env. Task 1 keeps `termsAndConditions` in `publicConfig` and the layout publishes the value. Task 6 still migrates by removing the entry from `next.config.js` `env:` block (along with `RELEASE_VERSION` and `WEB_RULE_FILES_DOCS`). When a future Terms page is built, the consumer reads `useConfig().termsAndConditions` with no infra changes required.

- [ ] **Step 1: Find consumers from Task 0b's audit report**

Open `docs/superpowers/plans/audits/2026-04-22-process-env-classification.md` and list every file under "Wave 4" for these 3 envs.

- [ ] **Step 2: Migrate the rule files docs link**

`apps/web/src/app/(app)/settings/code-review/_components/generate-rules-options/index.tsx` line 250:

```tsx
// before
<Link href={process.env.WEB_RULE_FILES_DOCS ?? ""}>

// after — add `const cfg = useConfig();` at top of component body, then:
<Link href={cfg.ruleFilesDocs ?? ""}>
```

Add `import { useConfig } from "@providers/ConfigProvider";` if not already present.

- [ ] **Step 3: Migrate other consumers per audit report**

For each file in Step 1's list (other than `/api/version/route.ts` which is server-only), apply the same pattern: client component → `useConfig()`, server component → leave `process.env.X` direct (with `import 'server-only'` if it's in a shared helper).

For `RELEASE_VERSION`: `apps/web/src/app/api/version/route.ts` is a server route handler — keep `process.env.RELEASE_VERSION` direct. **Do not** route this through `useConfig()`.

- [ ] **Step 4: Remove the 3 envs from `next.config.js`**

```js
WEB_TERMS_AND_CONDITIONS: process.env.WEB_TERMS_AND_CONDITIONS,
WEB_RULE_FILES_DOCS: process.env.WEB_RULE_FILES_DOCS,
RELEASE_VERSION: process.env.RELEASE_VERSION,
```

- [ ] **Step 5: Validate**

```bash
cd apps/web
npx tsc --noEmit 2>&1 | grep -E "generate-rules-options|api/version" || echo "OK"
yarn build 2>&1 | tail -20
```

- [ ] **Step 6: Browser smoke**

Open the rules-options screen, click the rule-files docs link. Verify URL. Open `/api/version` directly — verify `{ "version": "<release>" }` returns.

- [ ] **Step 7: Show diff and commit**

```bash
git diff --stat apps/web
git diff <files>
```

Wait for user approval, then:

```bash
git add <files>
git commit -m "refactor(web): wave 4 — read release/terms/rules via useConfig()

Migrates RELEASE_VERSION, WEB_TERMS_AND_CONDITIONS, and
WEB_RULE_FILES_DOCS out of next.config.js env: block. Server-only
consumers (/api/version/route.ts) still read process.env directly."
```

- [ ] **Step 8: Push branch — stop before opening PR**

```bash
git push -u origin refactor/web-runtime-config-wave4-misc
```

**Reversibility:** revert the commit.

---

### Task 7: Move internal hostnames to server-only (design Step 4)

**Branch:** `refactor/web-internal-hostnames-server-only`

**Files:**
- Modify: `apps/web/src/core/utils/helpers.ts` (add `import 'server-only'`)
- Modify: `apps/web/src/features/ee/subscription/_services/billing/utils.ts` (add `import 'server-only'`)
- Modify: `apps/web/src/lib/services/mcp-manager/utils.ts` (add `import 'server-only'`)
- Create: `apps/web/src/app/api/proxy/api/[...path]/route.ts` (forwards client calls to internal API)
- Modify: 7 client components (refactor `pathToApiUrl()` calls to use the new proxy route — list below)

**Depends on:** Task 0a (already done — confirmed 7 client importers of `pathToApiUrl`), Tasks 3-6 (run after waves so the `env:` block is mostly empty)

**Envs migrated (7 hostnames + ports):** `WEB_HOSTNAME_API`, `WEB_PORT_API`, `WEB_HOSTNAME_BILLING`, `WEB_PORT_BILLING`, `WEB_HOSTNAME_MCP_MANAGER`, `WEB_PORT_MCP_MANAGER`, `WEB_NODE_ENV`. These never enter `publicConfig`.

**Acceptance:** Build fails loud (TypeScript or Next bundler error) if any client component tries to import the three helpers. Internal hostnames no longer appear in any client bundle. The 7 client components that previously called `pathToApiUrl()` now hit `/api/proxy/api/<path>` and get the same upstream response.

> **Audit results from Task 0a** (`docs/superpowers/plans/audits/2026-04-22-internal-hostname-callers.md`):
>
> - **`helpers.ts`** — 7 client importers of `pathToApiUrl()` need refactoring. ~38 server importers stay as-is.
> - **`billing/utils.ts`** — only server importers (`billingFetch` is server-only). Just needs `import 'server-only'`.
> - **`mcp-manager/utils.ts`** — one client importer (`use-mcp-mentions.ts`) but it imports only the `MCPServiceUnavailableError` class, not the env-reading function. Adding `import 'server-only'` to `mcp-manager/utils.ts` will break that import — see Step 2 below for the resolution.
>
> **Heads-up from Task 0b audit** (`docs/superpowers/plans/audits/2026-04-22-process-env-classification.md`):
>
> - **Discrepancy #4** — `apps/web/src/app/(auth)/sso-callback/page.tsx` is a client component (`"use client";`) that reads `process.env.WEB_NODE_ENV` (line 13) to gate redirect logic. Today it works because the env: block inlines `WEB_NODE_ENV` into the client bundle. After this migration that read returns `undefined` in the browser. **Add Step 5b below** that extracts the env check into a server action / route handler / middleware (whichever fits the redirect flow), and have the client component call it. The env value never leaves the server.

- [ ] **Step 1: Confirm audit findings still hold**

Re-run the grep in case anything changed since Task 0a:

```bash
cd /Users/wellingtonsantana/Documents/kodus-git/kodus-ai
grep -rnE "from ['\"][^'\"]*core/utils/helpers['\"]" apps/web/src --include="*.tsx" | xargs -I{} sh -c 'F=$(echo {} | cut -d: -f1); echo "$(head -1 \"$F\") | $F"'
```

Confirm the 7 client files listed in the audit are still client and still import `pathToApiUrl`. If anything diverges, revisit before continuing.

- [ ] **Step 2: Resolve the `MCPServiceUnavailableError` cross-boundary import**

`apps/web/src/core/hooks/use-mcp-mentions.ts` (client) imports `MCPServiceUnavailableError` from `mcp-manager/utils.ts`. Once `utils.ts` gets `import 'server-only'`, that import fails the build.

Fix: extract the error class into its own pure module and re-export it from `utils.ts` for backward compat (server callers stay the same).

Create `apps/web/src/lib/services/mcp-manager/errors.ts`:

```ts
export class MCPServiceUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MCPServiceUnavailableError";
    }
}
```

(Use the existing class signature from `mcp-manager/utils.ts` — copy verbatim if it has more fields/methods.)

In `apps/web/src/lib/services/mcp-manager/utils.ts`, replace the local class definition with:

```ts
export { MCPServiceUnavailableError } from "./errors";
```

In `apps/web/src/core/hooks/use-mcp-mentions.ts`, change the import path:

```ts
// before
import { MCPServiceUnavailableError } from "@services/mcp-manager/utils";
// after
import { MCPServiceUnavailableError } from "@services/mcp-manager/errors";
```

(Verify the actual import path used; adjust to match.)

- [ ] **Step 3: Create the route handler proxy**

Create `apps/web/src/app/api/proxy/api/[...path]/route.ts`:

```ts
import "server-only";
import { NextRequest, NextResponse } from "next/server";

import { pathToApiUrl } from "@/core/utils/helpers";
// ^ adjust import path/alias to whatever helpers.ts exposes for resolving
//   the upstream URL. If pathToApiUrl returns a full URL given a path
//   suffix, use it directly. Otherwise compose from WEB_HOSTNAME_API/PORT
//   here.

async function forward(req: NextRequest, params: { path: string[] }) {
    const upstreamPath = "/" + params.path.join("/");
    const search = req.nextUrl.search;
    const url = pathToApiUrl(upstreamPath + search);

    // Strip Host header so upstream sees the right vhost; preserve the rest
    // (auth cookies, content-type, X-Forwarded-*).
    const headers = new Headers(req.headers);
    headers.delete("host");

    const init: RequestInit = {
        method: req.method,
        headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = req.body;
        // Required when streaming a body in App Router fetch
        (init as RequestInit & { duplex?: string }).duplex = "half";
    }

    const upstream = await fetch(url, init);

    // Pass through status, headers, body unchanged
    return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
    });
}

export async function GET(req: NextRequest, ctx: { params: { path: string[] } }) {
    return forward(req, ctx.params);
}
export async function POST(req: NextRequest, ctx: { params: { path: string[] } }) {
    return forward(req, ctx.params);
}
export async function PUT(req: NextRequest, ctx: { params: { path: string[] } }) {
    return forward(req, ctx.params);
}
export async function PATCH(req: NextRequest, ctx: { params: { path: string[] } }) {
    return forward(req, ctx.params);
}
export async function DELETE(req: NextRequest, ctx: { params: { path: string[] } }) {
    return forward(req, ctx.params);
}
```

This single proxy handles all HTTP methods. The `pathToApiUrl` import keeps the URL composition logic in one place (in `helpers.ts`); the client never sees the upstream host.

- [ ] **Step 4: Refactor the 7 client components**

For each of the 7 files below, replace `pathToApiUrl(<path>)` with the literal string `\`/api/proxy/api${<path>}\``. Drop the `import { pathToApiUrl } from "..."` line.

Files (from Task 0a audit):

1. `apps/web/src/app/(app)/issues/_components/issue-details-right-sheet.tsx`
2. `apps/web/src/app/(app)/issues/_components/severity-level-select.tsx`
3. `apps/web/src/app/(app)/issues/_components/status-select.tsx`
4. `apps/web/src/app/(app)/settings/_components/route-button-with-override-count.tsx`
5. `apps/web/src/app/(app)/settings/code-review/[repositoryId]/custom-messages/page.tsx`
6. `apps/web/src/features/ee/sso/_page-component.tsx`
7. `apps/web/src/features/ee/subscription/_components/license-key-settings.tsx`

For each: locate the `pathToApiUrl(...)` calls, look at the path argument, and rewrite the fetch call. Example pattern:

```ts
// before
fetch(pathToApiUrl(`/issues/${id}`), { method: "PATCH", body: JSON.stringify(payload) })

// after
fetch(`/api/proxy/api/issues/${id}`, { method: "PATCH", body: JSON.stringify(payload) })
```

Cookies/auth headers ride along automatically because the proxy is same-origin.

- [ ] **Step 5: Add `import 'server-only'` to the three helpers**

Top of each file (after existing imports if any pure-type imports come first):

```ts
import "server-only";
```

Files:
- `apps/web/src/core/utils/helpers.ts`
- `apps/web/src/features/ee/subscription/_services/billing/utils.ts`
- `apps/web/src/lib/services/mcp-manager/utils.ts`

(`mcp-manager/utils.ts` only has the re-export from Step 2 visible to client; the underlying `mcpManagerFetch` and any env reads are protected.)

- [ ] **Step 5b: Move `WEB_NODE_ENV` read out of `sso-callback/page.tsx`** (per Task 0b discrepancy #4)

`apps/web/src/app/(auth)/sso-callback/page.tsx:13` reads `process.env.WEB_NODE_ENV` from a `"use client"` component. After the migration that read returns `undefined` in the browser. Move the env-dependent decision to the server side.

Read the file to determine what the check gates:

```bash
sed -n '1,40p' apps/web/src/app/\(auth\)/sso-callback/page.tsx
```

Two acceptable refactors — pick whichever fits the existing flow:

**Option A — Middleware redirect (preferred when the gating happens before render).** Add a check in `apps/web/src/middleware.ts` (create if missing) that reads `process.env.WEB_NODE_ENV` server-side and redirects under the same condition. The client component drops the check entirely.

**Option B — Server-side wrapper component.** Convert `apps/web/src/app/(auth)/sso-callback/page.tsx` from a client to a server component, do the env-based decision server-side (NextResponse.redirect or conditional render), and delegate the interactive parts to a child client component that no longer needs the env.

Whichever route is taken, the final `sso-callback/page.tsx` (or its replacement) must NOT contain `process.env.WEB_NODE_ENV` in any client-marked module. Verify with:

```bash
grep -nE "process\\.env\\.WEB_NODE_ENV" apps/web/src/app/\(auth\)/sso-callback/
```

Expected: empty after the refactor.

- [ ] **Step 6: Validate**

```bash
cd apps/web
yarn build 2>&1 | tail -30
```

If build fails with `"server-only" cannot be imported from a Client Component`, an importer is still client-side. Find and fix per Task 0a's plan, or escalate to user.

- [ ] **Step 7: Verify hostnames out of client bundle**

```bash
cd apps/web
yarn build
grep -r "WEB_HOSTNAME_API\|WEB_HOSTNAME_BILLING\|WEB_HOSTNAME_MCP_MANAGER" .next/static 2>&1 | head
```

Expected: no matches in `.next/static` (the client bundle dir). The values may appear in `.next/server/` — that's fine, server-side.

- [ ] **Step 8: Show diff and commit**

```bash
git diff --stat apps/web
git diff <modified files>
```

Wait for user approval, then:

```bash
git add <files>
git commit -m "refactor(web): mark internal hostname helpers as server-only

Adds import 'server-only' to helpers that read WEB_HOSTNAME_API,
WEB_HOSTNAME_BILLING, and WEB_HOSTNAME_MCP_MANAGER. Bundler now refuses
to include these files in any client bundle. Internal infra hostnames
no longer ship to the browser."
```

- [ ] **Step 9: Push branch — stop before opening PR**

```bash
git push -u origin refactor/web-internal-hostnames-server-only
```

**Reversibility:** revert the commit; helpers go back to being importable from client. Hostnames re-leak. No functional regression.

---

### Task 8: Remove the entire `env:` block from `next.config.js` (design Step 5)

**Branch:** `chore/web-remove-env-block`

**Files:**
- Modify: `apps/web/next.config.js`

**Depends on:** Tasks 3, 4, 5, 6, 7 — the `env:` block must already be empty (or contain only entries we're explicitly choosing to leave).

**Acceptance:** No `env:` block in `next.config.js`. `next build` produces a working app. No client bundle still references `process.env.X` for any of the migrated envs.

- [ ] **Step 1: Verify the env: block is empty**

```bash
grep -A 30 "^    env:" apps/web/next.config.js
```

Expected: only `}` and entries we explicitly decided to keep. If any of the 16 client-needed envs from waves 1-4 still appears here, the corresponding wave wasn't completed — go fix it.

- [ ] **Step 2: Delete the env: block**

In `apps/web/next.config.js`, remove the lines from `env: {` through the matching `},`.

- [ ] **Step 3: Validate**

```bash
cd apps/web
yarn build 2>&1 | tail -20
yarn lint 2>&1 | tail -5
```

- [ ] **Step 4: Verify no lingering client-side env reads**

```bash
cd apps/web
yarn build
grep -roE "process\\.env\\.WEB_[A-Z_]+" .next/static 2>&1 | sort -u | head
```

Expected: empty. Any remaining match means a client component still does `process.env.X` directly. Either migrate it (open follow-up task) or revert this task.

- [ ] **Step 5: Browser smoke**

Full app smoke: sign-in, integrations screen, support links, get-started, rules options. Spot-check that nothing is broken.

- [ ] **Step 6: Show diff and commit**

```bash
git diff apps/web/next.config.js
```

Wait for user approval, then:

```bash
git add apps/web/next.config.js
git commit -m "chore(web): remove env: block from next.config.js

All client-needed envs are now read at runtime via ConfigProvider.
Server-only envs are accessed via process.env directly in modules
guarded by import 'server-only'. The env: block is no longer needed."
```

- [ ] **Step 7: Push branch — stop before opening PR**

```bash
git push -u origin chore/web-remove-env-block
```

**Reversibility:** revert the commit; the `env:` block returns. Anything that still reads `process.env.X` in a client component will silently get `undefined` until reverted, so this task should be merged AFTER all waves.

---

### Task 9: Delete `Dockerfile.web.selfhosted` + update docs (design Step 6)

**Branch:** `chore/web-retire-selfhosted-dockerfile`

**Files:**
- Delete: `docker/Dockerfile.web.selfhosted`
- Modify: `docker-bake.hcl` (target `web` should point at `Dockerfile.web` or the bake target should be removed if redundant)
- Modify: `README.md` and/or `README_DEPLOY.md` (self-hosted instructions)
- Modify: `.github/workflows/web-qa-deploy.yml` (remove the trigger path on the deleted file)

**Depends on:** Task 8 (env: block gone — no functional reason for the divergent Dockerfile)

**Acceptance:** No file `docker/Dockerfile.web.selfhosted`. `docker buildx bake web` succeeds and produces a tagged image. Docs point self-hosted users to GHCR.

- [ ] **Step 1: Delete the file**

```bash
git rm docker/Dockerfile.web.selfhosted
```

- [ ] **Step 2: Update `docker-bake.hcl`**

Open `docker-bake.hcl`. Locate `target "web"`:

```hcl
target "web" {
  context = "./apps/web"
  dockerfile = "../../docker/Dockerfile.web.selfhosted"
  ...
}
```

Change `dockerfile` to `../../docker/Dockerfile.web`. Verify the context is still appropriate (cloud Dockerfile may expect repo root context — adjust if needed by changing `context = "."` and updating COPY paths in `Dockerfile.web` accordingly, OR copy the relevant pieces of `Dockerfile.web.selfhosted` into `Dockerfile.web` first as Task 9 prep).

If the bake target ends up identical to running `docker build -f docker/Dockerfile.web .` directly, consider removing the bake target entirely and updating `selfhosted-build-push.yml` accordingly (handled in Task 10).

- [ ] **Step 3: Update `web-qa-deploy.yml` trigger paths**

Open `.github/workflows/web-qa-deploy.yml`. Find:

```yaml
paths:
    - "apps/web/**"
    - "docker/Dockerfile.web"
    - "docker/Dockerfile.web.dev"
    - "docker/Dockerfile.web.selfhosted"
```

Remove the last line.

- [ ] **Step 4: Update self-hosted docs**

In `README.md` and/or `README_DEPLOY.md`, find any mention of building `Dockerfile.web.selfhosted` locally. Replace with instructions to pull `ghcr.io/kodustech/kodus-ai-web:<version>`. Confirm the tag scheme matches what `selfhosted-build-push.yml` actually publishes.

- [ ] **Step 5: Validate the new bake target**

```bash
cd /Users/wellingtonsantana/Documents/kodus-git/kodus-ai
RELEASE_VERSION=test docker buildx bake web 2>&1 | tail -10
```

Expected: image builds successfully. (This builds locally — may take 5-10 min.)

- [ ] **Step 6: Show diff and commit**

```bash
git status
git diff docker-bake.hcl .github/workflows/web-qa-deploy.yml README.md README_DEPLOY.md
```

Wait for user approval, then:

```bash
git add -u docker-bake.hcl .github/workflows/web-qa-deploy.yml README.md README_DEPLOY.md
git rm docker/Dockerfile.web.selfhosted
git commit -m "chore(web): retire Dockerfile.web.selfhosted

The runtime config refactor removes the only reason this Dockerfile
existed (build at startup so per-customer envs could be inlined). All
deployments now use Dockerfile.web. Self-hosted operators pull
ghcr.io/kodustech/kodus-ai-web:<version> from GHCR; no local build
required."
```

- [ ] **Step 7: Push branch — stop before opening PR**

```bash
git push -u origin chore/web-retire-selfhosted-dockerfile
```

**Reversibility:** revert the commit; file returns. But unless Task 8 is also reverted, the runtime config still works — the Dockerfile would just be unused dead code.

---

### Task 10: Update CI/CD for unified self-hosted image (design Step 7)

**Branch:** `chore/web-ci-unify-selfhosted-image`

**Files:**
- Modify: `.github/workflows/selfhosted-build-push.yml`
- Modify: `docker-bake.hcl` (if not already cleaned in Task 9)

**Depends on:** Task 9

**Acceptance:** The next tagged self-hosted release builds and publishes a single `kodus-ai-web` image to GHCR using `Dockerfile.web` (no longer the deleted `Dockerfile.web.selfhosted`). All four containers (api, worker, webhook, web) come out of one workflow run.

- [ ] **Step 1: Audit `selfhosted-build-push.yml`**

```bash
grep -n "Dockerfile\|web\|bake\|target" .github/workflows/selfhosted-build-push.yml
```

Confirm whether the workflow:

a) Calls `docker buildx bake -f docker-bake.hcl <targets>` (most likely — Task 9 already updated the bake file)
b) Calls `docker build -f docker/Dockerfile.web.selfhosted` directly (in which case this task replaces it with `docker build -f docker/Dockerfile.web`)

- [ ] **Step 2: Adjust the workflow**

If (a), the bake file change in Task 9 is sufficient — verify the targets list still includes `web`.

If (b), replace the `docker build -f` call with the bake invocation, or change the file path to `Dockerfile.web` and update the build context per `Dockerfile.web`'s expectations.

- [ ] **Step 3: Validate locally where possible**

```bash
# Lint the YAML
yamllint .github/workflows/selfhosted-build-push.yml || true

# Dry-run the bake (no push)
RELEASE_VERSION=test docker buildx bake web --print
```

Expected: `--print` shows the resolved build config pointing at `Dockerfile.web`.

- [ ] **Step 4: Show diff and commit**

```bash
git diff .github/workflows/selfhosted-build-push.yml docker-bake.hcl
```

Wait for user approval, then:

```bash
git add -u .github/workflows/selfhosted-build-push.yml docker-bake.hcl
git commit -m "chore(ci): publish self-hosted web from unified Dockerfile.web

Removes the divergent build target — selfhosted-build-push.yml now
produces ghcr.io/kodustech/kodus-ai-web:<version> from Dockerfile.web,
the same artifact pipeline cloud uses. End of the runtime-config
migration started in 2026-04-15-web-runtime-config-design.md."
```

- [ ] **Step 5: Push branch — stop before opening PR**

```bash
git push -u origin chore/web-ci-unify-selfhosted-image
```

**Reversibility:** revert; CI goes back to the previous bake config. No production impact until the next tagged release.

---

## Acceptance criteria for the full migration

After all 10 tasks merge:

| Criterion | Verification |
|---|---|
| Multi-replica self-hosted serves static assets without 404 | Deploy 3 replicas of `ghcr.io/kodustech/kodus-ai-web:<version>` behind round-robin LB, request `/_next/static/chunks/<any>.js` 50× — all 200 |
| `BUILD_ID` stable across replicas | All replicas serve the same `<script src="/_next/static/<BUILD_ID>/...">` in their HTML |
| Self-hosted operators can change envs without rebuild | Set new `WEB_GITHUB_INSTALL_URL` in container env, restart container (~2 s), refresh integrations page → see new URL |
| Internal hostnames not in client bundle | `grep -r "WEB_HOSTNAME_" .next/static` returns nothing |
| Single web Dockerfile | `ls docker/Dockerfile.web*` returns only `Dockerfile.web` and `Dockerfile.web.dev` |
| `next.config.js` has no `env:` block | `grep -c "^    env:" apps/web/next.config.js` returns 0 |

## Risks and mitigations

(Carried from design doc, with execution notes.)

| Risk | Mitigation |
|---|---|
| Importer of internal-hostname helper is a client component → Task 7 build fails | Task 0a catches this *before* Task 7 starts. If it shows up at execution time anyway, escalate to user — design doc Step 4 anticipates this and the route-handler proxy in Task 7 Step 2 is the fallback. |
| Someone adds a secret to `publicConfig` by mistake | Code review of the `publicConfig.ts` file in Task 1, plus a follow-up lint rule (out of scope here — file as separate issue). |
| `useConfig()` called outside provider → runtime error | Hook throws explicitly. Detected on first dev render. |
| Self-hosted deploy with no envs set after upgrade → undefined values | `?? ""` fallback in layout.tsx (Task 1 Step 3) means values become empty strings, not crashes. Document the new env requirements in release notes for the version that ships Task 8 (the env: block removal) — until then, both old and new wiring coexist. |
| `RELEASE_VERSION` unset in CI → `BUILD_ID` falls to `"dev"` and replicas collide | All four CI workflows already pass `RELEASE_VERSION` (verified in Q1 above). Add a CI-time check in Task 2 follow-up (out of scope here) if paranoia warrants. |
| Rolling deploy with N-1 and N versions live → mixed `BUILD_ID`s | Each version's HTML references its own `BUILD_ID`'s assets. As long as the registry / CDN keeps `.next/static/<BUILD_ID>/` for at least one prior deploy, no 404s. Document for ops. |
| Refactor of `GitlabConnection`/`GitHubConnection`/`BitbucketConnection` to take config in constructor breaks unknown callsites | Each wave's Step 1 lists callsites via grep; if a callsite is missed and ends up at `new GitlabConnection()` with no arg, TypeScript will fail the build. Build is the safety net. |

## Out of scope

(Carried from design doc, restated for clarity at execution time.)

- Redesigning OAuth flow, NextAuth, or auth in general.
- Migrating route handlers to Server Actions.
- Bundle-size optimization beyond the env removals.
- Other services (api, worker, webhook) — separate plans.
- Postgres / pgBouncer (Issue #2 in client report) — handled by `fix/postgres-ssl-respect-url` already pushed.
- Duplicate PR comments (Issue #3) — resolved separately by the user.

## Open follow-ups (do not block this plan)

- Add an ESLint rule that forbids `process.env.X` reads from any file with `"use client";`.
- Add a TypeScript test that asserts `PublicConfig` keys all start with the agreed convention (e.g., that no key matches `/secret|password|token(?!Docs)/i`).
- Wire a CI step that fails the web build if `RELEASE_VERSION` is unset, to make Task 2's `BUILD_ID` collision impossible in practice.
