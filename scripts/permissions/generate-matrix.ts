/**
 * Generates the human-readable RBAC matrix consumed by the docs from the
 * single source of truth: ROLE_POLICIES
 * (libs/identity/domain/permissions/policies/role-policies.ts).
 *
 * The same ROLE_POLICIES drives the backend ability factory and the frontend
 * route guard, so this doc table can never disagree with what's enforced — as
 * long as it's regenerated. CI enforces that via `--check`.
 *
 * Usage:
 *   pnpm run permissions:matrix          Regenerate the docs snippet.
 *   pnpm run permissions:matrix:check    Fail if the snippet is out of date.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

import {
    Action,
    ResourceType,
    Role,
} from '../../libs/identity/domain/permissions/enums/permissions.enum';
import {
    ROLE_POLICIES,
    PolicyRule,
} from '../../libs/identity/domain/permissions/policies/role-policies';

const OUTPUT_PATH = resolve(
    __dirname,
    '../../docs/_snippets/rbac-matrix-generated.mdx',
);

// Display order + friendly labels for the table.
const ROLE_LABELS: Record<Role, string> = {
    [Role.OWNER]: 'Owner',
    [Role.BILLING_MANAGER]: 'Billing Manager',
    [Role.REPO_ADMIN]: 'Repo Admin',
    [Role.CONTRIBUTOR]: 'Contributor',
};
const ROLE_ORDER: Role[] = [
    Role.OWNER,
    Role.BILLING_MANAGER,
    Role.REPO_ADMIN,
    Role.CONTRIBUTOR,
];

const RESOURCE_LABELS: Partial<Record<ResourceType, string>> = {
    [ResourceType.CodeReviewSettings]: 'Code Review Settings',
    [ResourceType.KodyRules]: 'Kody Rules (Library)',
    [ResourceType.PullRequests]: 'Pull Requests',
    [ResourceType.CliReview]: 'CLI Review',
    [ResourceType.Issues]: 'Issues',
    [ResourceType.IssuesSettings]: 'Issues Settings',
    [ResourceType.Cockpit]: 'Cockpit',
    [ResourceType.Billing]: 'Billing / Subscription',
    [ResourceType.GitSettings]: 'Git Settings',
    [ResourceType.PluginSettings]: 'Plugins',
    [ResourceType.Logs]: 'Activity Log',
    [ResourceType.TokenUsage]: 'Token Usage',
    [ResourceType.OrganizationSettings]: 'Organization Settings',
    [ResourceType.UserSettings]: 'User / Seats',
};

function scopeLabel(rule: PolicyRule): string {
    if (rule.scope === 'org') return 'all';
    return rule.global ? 'own+global' : 'own';
}

// V/E/D vocabulary (View/Edit/Delete), matching the roles spreadsheet:
//   View   ← Read (or Manage)
//   Edit   ← Create / Update (or Manage)
//   Delete ← Delete (or Manage)
const VERB_ACTIONS: Record<'V' | 'E' | 'D', Action[]> = {
    V: [Action.Read, Action.Manage],
    E: [Action.Create, Action.Update, Action.Manage],
    D: [Action.Delete, Action.Manage],
};

// Scope shown for a verb = the scope of the matching rule(s) for that verb.
function verbScope(rules: PolicyRule[], actions: Action[]): string | null {
    const matches = rules.filter((r) => actions.includes(r.action));
    if (matches.length === 0) return null;
    const scopes = new Set(matches.map(scopeLabel));
    // Within a role+resource the create/update scopes agree in practice; if
    // they ever diverge, surface both rather than hide it.
    return [...scopes].join('+');
}

// Renders one role's grant on one resource, e.g. "V (own+global) / E (own)".
function cell(role: Role, resource: ResourceType): string {
    const rules = ROLE_POLICIES[role];

    // Owner holds Manage on the `all` resource → full access to everything.
    if (rules.some((r) => r.resource === ResourceType.All)) {
        return 'V (all) / E (all) / D (all)';
    }

    const forResource = rules.filter((r) => r.resource === resource);
    if (forResource.length === 0) return '—';

    const parts: string[] = [];
    for (const verb of ['V', 'E', 'D'] as const) {
        const scope = verbScope(forResource, VERB_ACTIONS[verb]);
        if (scope) parts.push(`${verb} (${scope})`);
    }
    return parts.length > 0 ? parts.join(' / ') : '—';
}

// Every labeled resource, in label order. We include owner-only resources
// (e.g. OrganizationSettings, which the Owner reaches via the `All` wildcard
// and no other role references) so the matrix surfaces them with "Owner: full
// / others: —" instead of silently dropping the row.
function resourcesInUse(): ResourceType[] {
    return Object.keys(RESOURCE_LABELS) as ResourceType[];
}

function render(): string {
    const resources = resourcesInUse();

    const header = `| Feature | ${ROLE_ORDER.map((r) => ROLE_LABELS[r]).join(' | ')} |`;
    const sep = `| --- | ${ROLE_ORDER.map(() => '---').join(' | ')} |`;
    const rows = resources.map((resource) => {
        const label = RESOURCE_LABELS[resource] ?? resource;
        const cells = ROLE_ORDER.map((role) => cell(role, resource));
        return `| ${label} | ${cells.join(' | ')} |`;
    });

    return [
        '{/* AUTO-GENERATED — do not edit by hand.',
        '   Source of truth: libs/identity/domain/permissions/policies/role-policies.ts',
        '   Regenerate with: pnpm run permissions:matrix */}',
        '',
        '<sub>',
        '**Legend** — `V` view · `E` edit (create/update) · `D` delete · `—` no access.',
        'Scope: `all` = whole organization · `own` = repositories assigned to the user ·',
        '`own+global` = assigned repos plus the org-wide/global config.',
        '</sub>',
        '',
        header,
        sep,
        ...rows,
        '',
    ].join('\n');
}

function main() {
    const content = render();
    const check = process.argv.includes('--check');

    if (check) {
        const current = existsSync(OUTPUT_PATH)
            ? readFileSync(OUTPUT_PATH, 'utf8')
            : '';
        if (current !== content) {
            console.error(
                '✖ docs RBAC matrix is out of date with ROLE_POLICIES.\n' +
                    '  Run `pnpm run permissions:matrix` and commit the result.',
            );
            process.exit(1);
        }
        console.log('✓ docs RBAC matrix is in sync with ROLE_POLICIES.');
        return;
    }

    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, content);
    console.log(`✓ wrote ${OUTPUT_PATH}`);
}

main();
