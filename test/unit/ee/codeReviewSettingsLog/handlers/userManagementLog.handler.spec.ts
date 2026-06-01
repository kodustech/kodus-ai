import { UserManagementLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/userManagementLog.handler';

import {
    createMockUnifiedLogHandler,
    createBaseParams,
    extractChangedData,
} from './helpers/shared-mocks';

describe('UserManagementLogHandler', () => {
    let handler: UserManagementLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new UserManagementLogHandler(mockUnified as any);
    });

    describe('logUserRoleChange', () => {
        it('logs role change contributor→owner with formatted labels', async () => {
            await handler.logUserRoleChange({
                ...createBaseParams(),
                targetUserEmail: 'target@test.com',
                previousRole: 'contributor',
                newRole: 'owner',
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe('User Role Changed');
            expect(data[0].description).toContain('Contributor');
            expect(data[0].description).toContain('Owner');
            expect(data[0].description).toContain('target@test.com');
        });

        it('does not log when same role', async () => {
            await handler.logUserRoleChange({
                ...createBaseParams(),
                targetUserEmail: 'target@test.com',
                previousRole: 'owner',
                newRole: 'owner',
            } as any);

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });

    describe('logUserRepoAccessChange', () => {
        it('logs added repos as "Repository Access Granted"', async () => {
            await handler.logUserRepoAccessChange({
                ...createBaseParams(),
                targetUserEmail: 'target@test.com',
                addedRepositories: [{ id: 'r1', name: 'repo-a' }],
                removedRepositories: [],
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe('Repository Access Granted');
            expect(data[0].description).toContain('repo-a');
        });

        it('logs removed repos as "Repository Access Revoked"', async () => {
            await handler.logUserRepoAccessChange({
                ...createBaseParams(),
                targetUserEmail: 'target@test.com',
                addedRepositories: [],
                removedRepositories: [{ id: 'r1', name: 'repo-a' }],
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe('Repository Access Revoked');
        });

        it('handles both added + removed', async () => {
            await handler.logUserRepoAccessChange({
                ...createBaseParams(),
                targetUserEmail: 'target@test.com',
                addedRepositories: [{ id: 'r1', name: 'added' }],
                removedRepositories: [{ id: 'r2', name: 'removed' }],
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(2);
        });

        it('does not log with empty lists', async () => {
            await handler.logUserRepoAccessChange({
                ...createBaseParams(),
                targetUserEmail: 'target@test.com',
                addedRepositories: [],
                removedRepositories: [],
            } as any);

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });
});
