import { subject as caslSubject } from '@casl/ability';
import {
    Action,
    ResourceType,
    Role,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { PermissionsAbilityFactory } from './permissionsAbility.factory';

/**
 * Behavioral guard for the data-driven ability factory. These assertions pin
 * the role/permission cells that the spreadsheet defines (and the cells we
 * deliberately changed). If ROLE_POLICIES drifts, this fails loudly.
 */
describe('PermissionsAbilityFactory', () => {
    const permissionsService = { findOne: jest.fn() } as any;
    const factory = new PermissionsAbilityFactory(permissionsService);

    const buildFor = (role: Role) => {
        const user = {
            uuid: 'user-1',
            role,
            organization: { uuid: 'org-1' },
        } as unknown as IUser;
        // Pass repositoryIds explicitly so the service is never hit.
        return factory.createForUser(user, ['repo-1']);
    };

    it('OWNER manages everything', async () => {
        const ability = await buildFor(Role.OWNER);
        expect(ability.can(Action.Manage, ResourceType.All)).toBe(true);
        expect(ability.can(Action.Update, ResourceType.Cockpit)).toBe(true);
        expect(ability.can(Action.Delete, ResourceType.Billing)).toBe(true);
    });

    it('REPO_ADMIN: read PRs/cockpit/cli-review/token-usage, edit code-review, but NOT edit cockpit and NOT manage billing', async () => {
        const ability = await buildFor(Role.REPO_ADMIN);
        expect(ability.can(Action.Read, ResourceType.PullRequests)).toBe(true);
        expect(ability.can(Action.Read, ResourceType.Cockpit)).toBe(true);
        expect(ability.can(Action.Read, ResourceType.CliReview)).toBe(true);
        expect(ability.can(Action.Read, ResourceType.TokenUsage)).toBe(true);
        expect(ability.can(Action.Update, ResourceType.CodeReviewSettings)).toBe(
            true,
        );
        // Fase 0 fix: cockpit settings are owner-only.
        expect(ability.can(Action.Update, ResourceType.Cockpit)).toBe(false);
        expect(ability.can(Action.Manage, ResourceType.Billing)).toBe(false);
    });

    it('BILLING_MANAGER: manage billing + read token usage/users, but NOT cli-review or cockpit', async () => {
        const ability = await buildFor(Role.BILLING_MANAGER);
        expect(ability.can(Action.Manage, ResourceType.Billing)).toBe(true);
        expect(ability.can(Action.Read, ResourceType.TokenUsage)).toBe(true);
        expect(ability.can(Action.Read, ResourceType.UserSettings)).toBe(true);
        expect(ability.can(Action.Read, ResourceType.CliReview)).toBe(false);
        expect(ability.can(Action.Read, ResourceType.Cockpit)).toBe(false);
    });

    it('CONTRIBUTOR: read cli-review/issues/code-review/PRs, but NOT cockpit, token usage, or edit', async () => {
        const ability = await buildFor(Role.CONTRIBUTOR);
        expect(ability.can(Action.Read, ResourceType.CliReview)).toBe(true);
        expect(ability.can(Action.Read, ResourceType.Issues)).toBe(true);
        expect(ability.can(Action.Read, ResourceType.CodeReviewSettings)).toBe(
            true,
        );
        expect(ability.can(Action.Read, ResourceType.PullRequests)).toBe(true);
        expect(ability.can(Action.Read, ResourceType.Cockpit)).toBe(false);
        expect(ability.can(Action.Read, ResourceType.TokenUsage)).toBe(false);
        expect(ability.can(Action.Update, ResourceType.CodeReviewSettings)).toBe(
            false,
        );
    });

    it('REPO_ADMIN reads are org-wide, but writes stay gated by repo assignment', async () => {
        const ability = await buildFor(Role.REPO_ADMIN);
        const unassigned = (resource: ResourceType) =>
            caslSubject(resource, {
                organizationId: 'org-1',
                repoId: 'repo-unassigned',
            });
        // Sees everything (read) regardless of assignment.
        expect(
            ability.can(
                Action.Read,
                unassigned(ResourceType.CodeReviewSettings) as any,
            ),
        ).toBe(true);
        expect(
            ability.can(Action.Read, unassigned(ResourceType.Cockpit) as any),
        ).toBe(true);
        expect(
            ability.can(
                Action.Read,
                unassigned(ResourceType.PullRequests) as any,
            ),
        ).toBe(true);
        // Edits only on assigned repos.
        expect(
            ability.can(
                Action.Update,
                unassigned(ResourceType.CodeReviewSettings) as any,
            ),
        ).toBe(false);
        expect(
            ability.can(
                Action.Update,
                caslSubject(ResourceType.CodeReviewSettings, {
                    organizationId: 'org-1',
                    repoId: 'repo-1',
                }) as any,
            ),
        ).toBe(true);
    });

    it('CONTRIBUTOR reads are org-wide: not gated by repo assignment', async () => {
        const ability = await buildFor(Role.CONTRIBUTOR);
        // 'repo-unassigned' is NOT in the assigned list (['repo-1']); a
        // contributor must still see its settings/rules/PRs (read-only).
        const inUnassignedRepo = (resource: ResourceType) =>
            caslSubject(resource, {
                organizationId: 'org-1',
                repoId: 'repo-unassigned',
            });
        expect(
            ability.can(
                Action.Read,
                inUnassignedRepo(ResourceType.CodeReviewSettings) as any,
            ),
        ).toBe(true);
        expect(
            ability.can(
                Action.Read,
                inUnassignedRepo(ResourceType.KodyRules) as any,
            ),
        ).toBe(true);
        expect(
            ability.can(
                Action.Read,
                inUnassignedRepo(ResourceType.PullRequests) as any,
            ),
        ).toBe(true);
        // Writes stay forbidden even on assigned repos.
        expect(
            ability.can(
                Action.Update,
                caslSubject(ResourceType.CodeReviewSettings, {
                    organizationId: 'org-1',
                    repoId: 'repo-1',
                }) as any,
            ),
        ).toBe(false);
    });

    it('a user without a role can do nothing', async () => {
        const user = {
            uuid: 'user-x',
            role: undefined,
            organization: { uuid: 'org-1' },
        } as unknown as IUser;
        const ability = await factory.createForUser(user, []);
        expect(ability.can(Action.Manage, ResourceType.All)).toBe(false);
        expect(ability.can(Action.Read, ResourceType.Issues)).toBe(false);
    });
});
