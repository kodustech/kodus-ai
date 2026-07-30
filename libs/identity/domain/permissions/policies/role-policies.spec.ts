import * as fs from 'fs';
import * as path from 'path';

import { Action, ResourceType, Role } from '../enums/permissions.enum';
import { ROLE_POLICIES, PolicyRule } from './role-policies';

describe('ROLE_POLICIES', () => {
    it('defines a policy for every role', () => {
        for (const role of Object.values(Role)) {
            expect(ROLE_POLICIES[role]).toBeDefined();
        }
    });

    it('grants the OWNER full access via a single Manage-all rule', () => {
        expect(ROLE_POLICIES[Role.OWNER]).toEqual([
            { action: Action.Manage, resource: ResourceType.All, scope: 'org' },
        ]);
    });

    // Pins the cells we deliberately set/changed, so an accidental edit to the
    // policy fails loudly with a meaningful message (drift detection without
    // jest snapshots, which this repo does not use).
    it('pins the key corrected cells', () => {
        const has = (role: Role, rule: Partial<PolicyRule>) =>
            ROLE_POLICIES[role].some((r) =>
                Object.entries(rule).every(([k, v]) => (r as any)[k] === v),
            );

        // Repo Admin: reads are org-wide (sees everything); only writes are
        // gated by repo assignment.
        expect(
            has(Role.REPO_ADMIN, {
                action: Action.Read,
                resource: ResourceType.PullRequests,
                scope: 'org',
            }),
        ).toBe(true);
        expect(
            has(Role.REPO_ADMIN, {
                action: Action.Update,
                resource: ResourceType.CodeReviewSettings,
                scope: 'repo',
            }),
        ).toBe(true);
        // Repo Admin must NOT be able to update Cockpit (settings are owner-only).
        expect(
            has(Role.REPO_ADMIN, {
                action: Action.Update,
                resource: ResourceType.Cockpit,
            }),
        ).toBe(false);
        // Token usage: granted to Billing & Repo Admin, never Contributor.
        expect(
            has(Role.BILLING_MANAGER, {
                action: Action.Read,
                resource: ResourceType.TokenUsage,
            }),
        ).toBe(true);
        expect(
            has(Role.CONTRIBUTOR, { resource: ResourceType.TokenUsage }),
        ).toBe(false);
        // CLI review: Repo Admin & Contributor (own); never Billing.
        expect(
            has(Role.CONTRIBUTOR, { resource: ResourceType.CliReview }),
        ).toBe(true);
        expect(
            has(Role.BILLING_MANAGER, { resource: ResourceType.CliReview }),
        ).toBe(false);
    });

    // The policy is shared with the Next.js frontend, so it (and the enum file
    // it imports) must stay free of backend-only dependencies.
    it('stays framework-free (no NestJS / CASL / service imports)', () => {
        const files = [
            path.join(__dirname, 'role-policies.ts'),
            path.join(__dirname, '..', 'enums', 'permissions.enum.ts'),
        ];
        const forbidden = /from\s+['"](@nestjs\/|@casl\/|.*\.service|.*\.contract)/;
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            const offending = src
                .split('\n')
                .filter((line) => forbidden.test(line));
            expect(offending).toEqual([]);
        }
    });
});
