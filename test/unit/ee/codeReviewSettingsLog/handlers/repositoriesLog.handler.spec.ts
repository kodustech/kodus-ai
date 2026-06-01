import { RepositoriesLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/repositoriesLog.handler';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    createMockUnifiedLogHandler,
    createBaseParams,
    extractChangedData,
} from './helpers/shared-mocks';

describe('RepositoriesLogHandler', () => {
    let handler: RepositoriesLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new RepositoriesLogHandler(mockUnified as any);
    });

    // ─── Add / Remove ───

    describe('add/remove repositories', () => {
        it('creates one entry per added repository', async () => {
            await handler.logRepositoriesAction({
                ...createBaseParams({ actionType: ActionType.ADD }),
                addedRepositories: [
                    { id: 'r1', name: 'repo-a' },
                    { id: 'r2', name: 'repo-b' },
                ],
                removedRepositories: [],
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(2);
            expect(data[0].actionDescription).toBe('Repository Added');
            expect(data[1].actionDescription).toBe('Repository Added');
            expect(data[0].description).toContain('repo-a');
            expect(data[1].description).toContain('repo-b');
        });

        it('creates one entry per removed repository', async () => {
            await handler.logRepositoriesAction({
                ...createBaseParams({ actionType: ActionType.DELETE }),
                addedRepositories: [],
                removedRepositories: [{ id: 'r1', name: 'repo-a' }],
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe('Repository Removed');
            expect(data[0].previousValue).toEqual({
                id: 'r1',
                name: 'repo-a',
            });
        });

        it('handles mixed add + remove', async () => {
            await handler.logRepositoriesAction({
                ...createBaseParams({ actionType: ActionType.EDIT }),
                addedRepositories: [{ id: 'r1', name: 'added' }],
                removedRepositories: [{ id: 'r2', name: 'removed' }],
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(2);
            expect(data[0].actionDescription).toBe('Repository Added');
            expect(data[1].actionDescription).toBe('Repository Removed');
        });

        it('does not call saveLogEntry with empty lists', async () => {
            await handler.logRepositoriesAction({
                ...createBaseParams(),
                addedRepositories: [],
                removedRepositories: [],
            } as any);

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });
    });

    // ─── Copy operations ───

    describe('copy operations', () => {
        it('logs copy repo→repo config', async () => {
            await handler.logRepositoriesAction({
                ...createBaseParams({ actionType: ActionType.ADD }),
                sourceRepository: { id: 'src-repo', name: 'Source Repo' },
                targetRepository: { id: 'tgt-repo', name: 'Target Repo' },
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'Repository Configuration Copied',
            );
            expect(data[0].description).toContain('Source Repo');
            expect(data[0].description).toContain('Target Repo');
        });

        it('logs copy global→repo config with Global Settings label', async () => {
            await handler.logRepositoriesAction({
                ...createBaseParams({ actionType: ActionType.ADD }),
                sourceRepository: { id: 'global', name: 'global' },
                targetRepository: { id: 'tgt-repo', name: 'Target Repo' },
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data[0].description).toContain('Global Settings');
            expect(data[0].currentValue.sourceRepository.isGlobal).toBe(true);
        });

        it('logs copy repo→directory config', async () => {
            await handler.logRepositoriesAction({
                ...createBaseParams({ actionType: ActionType.ADD }),
                sourceRepository: { id: 'src-repo', name: 'Source Repo' },
                targetDirectory: { id: 'dir-1', path: '/src/components' },
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'Directory Configuration Copied',
            );
            expect(data[0].description).toContain('/src/components');
        });
    });

    // ─── Config removal ───

    describe('config removal', () => {
        it('logRepositoryConfigurationRemoval → configType specific→global', async () => {
            await handler.logRepositoryConfigurationRemoval({
                ...createBaseParams({ actionType: ActionType.DELETE }),
                repository: { id: 'r1', name: 'my-repo' },
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'Repository Configuration Removed',
            );
            expect(data[0].previousValue.configType).toBe('specific');
            expect(data[0].currentValue.configType).toBe('global');
        });

        it('logDirectoryConfigurationRemoval → configType specific→repository', async () => {
            await handler.logDirectoryConfigurationRemoval({
                ...createBaseParams({ actionType: ActionType.DELETE }),
                repository: { id: 'r1', name: 'my-repo' },
                directory: { id: 'dir-1', path: '/src' },
            } as any);

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe(
                'Directory Configuration Removed',
            );
            expect(data[0].previousValue.configType).toBe('specific');
            expect(data[0].currentValue.configType).toBe('repository');
        });
    });
});
