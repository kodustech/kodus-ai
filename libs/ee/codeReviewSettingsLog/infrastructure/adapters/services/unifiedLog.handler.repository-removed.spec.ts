import { ContextResolutionService } from '@libs/core/context-resolution/infrastructure/adapters/services/context-resolution.service';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

import { UnifiedLogHandler } from './unifiedLog.handler';

/**
 * Issue #2581: removing the synced Kody Rules of a repository that left the
 * integration wrote one audit entry per rule, and every entry logged
 * "Error getting repository additional info" (26 per repository in prod).
 */
describe('UnifiedLogHandler – repository no longer in the integration', () => {
    const organizationId = 'org-1';

    function build(integrationConfigs: unknown[]) {
        const created: any[] = [];
        const resolver = new ContextResolutionService(
            {
                findByKey: async () => ({
                    configValue: {
                        repositories: [{ id: 'repo-kept', name: 'kept' }],
                    },
                }),
            } as any,
            {
                findByOrganizationAndConfigKey: async () => integrationConfigs,
            } as any,
        );
        const handler = new UnifiedLogHandler(
            { create: async (entry: unknown) => created.push(entry) } as any,
            resolver,
        );
        const errorLog = jest
            .spyOn((handler as any).logger, 'error')
            .mockImplementation(() => undefined);
        return { handler, created, errorLog };
    }

    const deleteRuleOf = (repositoryId: string) => ({
        organizationAndTeamData: { organizationId },
        userInfo: { userId: 'u', userEmail: 'u@example.com' },
        actionType: ActionType.DELETE,
        configLevel: ConfigLevel.REPOSITORY,
        repository: { id: repositoryId },
        entityType: 'kodyRule',
        entityName: 'Some rule',
    });

    it('writes the entry with "Unknown" and logs no error when the repository left the integration', async () => {
        const { handler, created, errorLog } = build([
            {
                configValue: [{ id: 'repo-kept' }],
                team: { uuid: 'team-1' },
            },
        ]);

        await handler.logAction(deleteRuleOf('repo-removed'));

        expect(created).toHaveLength(1);
        expect(created[0].repository).toEqual({
            id: 'repo-removed',
            name: 'Unknown',
        });
        expect(errorLog).not.toHaveBeenCalled();
    });

    it('treats an organization with no active integration the same way', async () => {
        const { handler, created, errorLog } = build([]);

        await handler.logAction(deleteRuleOf('repo-removed'));

        expect(created[0].repository.name).toBe('Unknown');
        expect(errorLog).not.toHaveBeenCalled();
    });

    it('still logs an error when the lookup fails for any other reason', async () => {
        const { handler, created, errorLog } = build([
            {
                configValue: [{ id: 'repo-orphan' }],
                team: { uuid: 'team-1' },
            },
        ]);

        // In the integration, but missing from the code review config.
        await handler.logAction(deleteRuleOf('repo-orphan'));

        expect(created[0].repository.name).toBe('Unknown');
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId,
                    repositoryId: 'repo-orphan',
                }),
            }),
        );
    });

    it('resolves the name of a repository that is still integrated', async () => {
        const { handler, created } = build([
            {
                configValue: [{ id: 'repo-kept' }],
                team: { uuid: 'team-1' },
            },
        ]);

        await handler.logAction(deleteRuleOf('repo-kept'));

        expect(created[0].repository.name).toBe('kept');
    });
});
