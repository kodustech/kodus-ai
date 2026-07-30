import { Action, ResourceType, Role } from '../enums/permissions.enum';

/**
 * Single source of truth for what each role is allowed to do.
 *
 * This file is **framework-free** (only imports the permission enums) so it can
 * be consumed by both the NestJS backend — `PermissionsAbilityFactory` turns
 * these rules into a CASL ability — and the Next.js frontend, which derives its
 * middleware route guard from the same data. Do NOT import anything from
 * `@nestjs/*`, `@casl/*`, or any service/DB here, or the frontend bundle breaks.
 *
 * `scope`:
 *   - `'org'`  → the grant applies across the user's whole organization.
 *   - `'repo'` → the grant is limited to the repositories assigned to the user.
 * `global` (repo scope only): also allow the org-wide / "global" config record
 *   (e.g. global code-review settings) in addition to assigned repositories.
 */
export type PolicyScope = 'org' | 'repo';

export type PolicyRule = {
    action: Action;
    resource: ResourceType;
    scope: PolicyScope;
    global?: boolean;
};

const owner: PolicyRule[] = [
    { action: Action.Manage, resource: ResourceType.All, scope: 'org' },
];

// Repo Admin sees the whole org by default (reads are org-wide); only WRITES
// are gated by repo assignment — editing settings/rules/issues of a repo
// requires that repo to be assigned to the user.
const repoAdmin: PolicyRule[] = [
    // Code review settings — read org-wide, edit assigned repos.
    { action: Action.Read, resource: ResourceType.CodeReviewSettings, scope: 'org' },
    { action: Action.Update, resource: ResourceType.CodeReviewSettings, scope: 'repo' },
    { action: Action.Create, resource: ResourceType.CodeReviewSettings, scope: 'repo' },

    // Kody rules — read org-wide (library is open to everyone), edit assigned
    // repos (editing a repo's kody rules is part of its code-review config).
    { action: Action.Read, resource: ResourceType.KodyRules, scope: 'org' },
    { action: Action.Update, resource: ResourceType.KodyRules, scope: 'repo' },
    { action: Action.Create, resource: ResourceType.KodyRules, scope: 'repo' },
    { action: Action.Delete, resource: ResourceType.KodyRules, scope: 'repo' },

    // Cockpit — read only (no org-wide Update: cockpit *settings* are owner-only).
    { action: Action.Read, resource: ResourceType.Cockpit, scope: 'org' },

    // Issues — read across the org, create/update on assigned repos.
    { action: Action.Read, resource: ResourceType.Issues, scope: 'org' },
    { action: Action.Update, resource: ResourceType.Issues, scope: 'repo' },
    { action: Action.Create, resource: ResourceType.Issues, scope: 'repo' },

    // Issues settings — org-wide configuration.
    { action: Action.Read, resource: ResourceType.IssuesSettings, scope: 'org' },
    { action: Action.Update, resource: ResourceType.IssuesSettings, scope: 'org' },
    { action: Action.Create, resource: ResourceType.IssuesSettings, scope: 'org' },

    { action: Action.Read, resource: ResourceType.Logs, scope: 'org' },

    { action: Action.Read, resource: ResourceType.PullRequests, scope: 'org' },

    { action: Action.Read, resource: ResourceType.GitSettings, scope: 'org' },
    { action: Action.Read, resource: ResourceType.PluginSettings, scope: 'org' },
    { action: Action.Read, resource: ResourceType.TokenUsage, scope: 'org' },

    { action: Action.Read, resource: ResourceType.CliReview, scope: 'org' },
];

const billingManager: PolicyRule[] = [
    { action: Action.Read, resource: ResourceType.CodeReviewSettings, scope: 'org' },
    { action: Action.Read, resource: ResourceType.KodyRules, scope: 'org' },

    { action: Action.Manage, resource: ResourceType.Billing, scope: 'org' },

    { action: Action.Read, resource: ResourceType.GitSettings, scope: 'org' },
    { action: Action.Read, resource: ResourceType.PluginSettings, scope: 'org' },
    // Read users for the license / seat-management screen.
    { action: Action.Read, resource: ResourceType.UserSettings, scope: 'org' },
    { action: Action.Read, resource: ResourceType.IssuesSettings, scope: 'org' },
    { action: Action.Read, resource: ResourceType.Logs, scope: 'org' },
    { action: Action.Read, resource: ResourceType.TokenUsage, scope: 'org' },
];

// Contributor is a read-only role that is NOT gated by repo assignment: it
// sees the whole org (settings, kody rules, issues, PRs, logs) by default.
// Cockpit and Token Usage stay admin-only.
const contributor: PolicyRule[] = [
    { action: Action.Read, resource: ResourceType.CodeReviewSettings, scope: 'org' },
    { action: Action.Read, resource: ResourceType.KodyRules, scope: 'org' },
    { action: Action.Read, resource: ResourceType.Issues, scope: 'org' },
    { action: Action.Read, resource: ResourceType.IssuesSettings, scope: 'org' },
    { action: Action.Read, resource: ResourceType.CliReview, scope: 'org' },
    { action: Action.Read, resource: ResourceType.PullRequests, scope: 'org' },
    { action: Action.Read, resource: ResourceType.Logs, scope: 'org' },
    { action: Action.Read, resource: ResourceType.GitSettings, scope: 'org' },
    { action: Action.Read, resource: ResourceType.PluginSettings, scope: 'org' },
];

export const ROLE_POLICIES: Record<Role, PolicyRule[]> = {
    [Role.OWNER]: owner,
    [Role.REPO_ADMIN]: repoAdmin,
    [Role.BILLING_MANAGER]: billingManager,
    [Role.CONTRIBUTOR]: contributor,
};

/**
 * Whether repository assignment has any effect for the role — i.e. at least
 * one of its grants is repo-scoped. Drives UI such as the repo-assignment
 * chip in user management; derived from ROLE_POLICIES so it cannot drift
 * when a role's scoping changes.
 */
export const roleUsesRepoAssignment = (role: Role | string): boolean =>
    (ROLE_POLICIES[role as Role] ?? []).some((rule) => rule.scope === 'repo');
