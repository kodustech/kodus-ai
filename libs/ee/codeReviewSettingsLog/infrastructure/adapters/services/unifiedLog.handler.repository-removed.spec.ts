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
describe('UnifiedLogHandler – repository whose name cannot be resolved', () => {
    const organizationId = 'org-1';

    const codeReviewConfig = {
        configValue: {
            repositories: [{ id: 'repo-kept', name: 'kept' }],
        },
    };

    function build(
        integrationConfigs: unknown[],
        findByKey: () => Promise<unknown> = async () => codeReviewConfig,
    ) {
        const created: any[] = [];
        const integrationLookup = jest.fn(async () => integrationConfigs);
        const resolver = new ContextResolutionService(
            { findByKey } as any,
            {
                findByOrganizationAndConfigKey: integrationLookup,
            } as any,
        );
        const handler = new UnifiedLogHandler(
            { create: async (entry: unknown) => created.push(entry) } as any,
            resolver,
        );
        const errorLog = jest
            .spyOn((handler as any).logger, 'error')
            .mockImplementation(() => undefined);
        return { handler, created, errorLog, integrationLookup };
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

    it('writes "Unknown" and logs no error for a repository in the integration but not in the code review config', async () => {
        const { handler, created, errorLog } = build([
            {
                configValue: [{ id: 'repo-orphan' }],
                team: { uuid: 'team-1' },
            },
        ]);

        await handler.logAction(deleteRuleOf('repo-orphan'));

        expect(created[0].repository).toEqual({
            id: 'repo-orphan',
            name: 'Unknown',
        });
        expect(errorLog).not.toHaveBeenCalled();
    });

    it('still logs an error when the lookup fails for any other reason', async () => {
        const { handler, created, errorLog } = build(
            [{ configValue: [{ id: 'repo-kept' }], team: { uuid: 'team-1' } }],
            async () => {
                throw new Error('connection reset');
            },
        );

        await handler.logAction(deleteRuleOf('repo-kept'));

        expect(created[0].repository.name).toBe('Unknown');
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId,
                    repositoryId: 'repo-kept',
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

    it('looks the repository up once for a burst of entries about it, fired at once as the events are', async () => {
        const { handler, created, errorLog, integrationLookup } = build([
            {
                configValue: [{ id: 'repo-kept' }],
                team: { uuid: 'team-1' },
            },
        ]);

        // kodyRules.service emits the audit events without awaiting them,
        // so the 26 entries of one removal run concurrently.
        await Promise.all(
            Array.from({ length: 26 }, () =>
                handler.logAction(deleteRuleOf('repo-removed')),
            ),
        );

        expect(created).toHaveLength(26);
        expect(created.every((e) => e.repository.name === 'Unknown')).toBe(
            true,
        );
        expect(integrationLookup).toHaveBeenCalledTimes(1);
        expect(errorLog).not.toHaveBeenCalled();
    });

    it('looks a repository missing from the code review config up once for a burst of entries', async () => {
        const { handler, created, errorLog, integrationLookup } = build([
            {
                configValue: [{ id: 'repo-orphan' }],
                team: { uuid: 'team-1' },
            },
        ]);

        await Promise.all(
            Array.from({ length: 26 }, () =>
                handler.logAction(deleteRuleOf('repo-orphan')),
            ),
        );

        expect(created).toHaveLength(26);
        expect(integrationLookup).toHaveBeenCalledTimes(1);
        expect(errorLog).not.toHaveBeenCalled();
    });

    it('asks again after a failure that is not an unresolvable repository', async () => {
        const { handler, integrationLookup } = build(
            [{ configValue: [{ id: 'repo-kept' }], team: { uuid: 'team-1' } }],
            async () => {
                throw new Error('connection reset');
            },
        );

        await handler.logAction(deleteRuleOf('repo-kept'));
        await handler.logAction(deleteRuleOf('repo-kept'));

        expect(integrationLookup).toHaveBeenCalledTimes(2);
    });
});
