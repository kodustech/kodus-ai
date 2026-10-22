import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { RefreshCodeAreaRiskMapService } from './refresh-code-area-risk-map.service';

it('scans by update time, saves merged PR evidence, and advances a resumable cursor', async () => {
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let state: Record<string, any> | null = null;
    const records: Record<string, any>[] = [];
    const sync = {
        findOne: jest.fn(() => ({
            lean: () => ({ exec: async () => state }),
        })),
        updateOne: jest.fn(async (_key, update) => {
            state = {
                ...(state ?? {}),
                ...(update.$setOnInsert ?? update.$set),
            };
        }),
    };
    const history = {
        deleteMany: jest.fn().mockResolvedValue(undefined),
        updateOne: jest.fn(async (_key, update) => {
            records.push(update.$set);
        }),
        find: jest.fn(() => ({
            lean: () => ({ exec: async () => records }),
        })),
    };
    const codeManagement = {
        getTypeIntegration: jest.fn().mockResolvedValue(PlatformType.GITHUB),
        getPullRequestsByRepository: jest.fn().mockResolvedValue([
            {
                number: 10,
                title: 'Fix retry bug',
                created_at: '2020-01-01T00:00:00Z',
                updated_at: recent,
                merged_at: recent,
                prURL: 'https://github.com/acme/api/pull/10',
                body: '',
                head: { sha: 'abc' },
            },
        ]),
        isIssuesSupported: jest.fn().mockResolvedValue(false),
        getFilesByPullRequestId: jest
            .fn()
            .mockResolvedValue([{ filename: 'src/retry.ts' }]),
        getDefaultBranch: jest.fn().mockResolvedValue(null),
    };
    const maps = { read: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const service = new RefreshCodeAreaRiskMapService(
        codeManagement as any,
        maps as any,
        history as any,
        sync as any,
    );

    const result = await service.refreshOneBatch({
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repository: { id: 'repo', name: 'api' },
    });

    expect(codeManagement.getPullRequestsByRepository).toHaveBeenCalledWith(
        expect.objectContaining({
            filters: expect.objectContaining({
                dateField: 'updated',
                maxResults: 100,
            }),
        }),
    );
    expect(Date.now() - Date.parse(state!.windowStart)).toBeGreaterThan(
        29 * 24 * 60 * 60 * 1000,
    );
    expect(Date.now() - Date.parse(state!.windowStart)).toBeLessThan(
        31 * 24 * 60 * 60 * 1000,
    );
    expect(state!.version).toBe(2);
    expect(records[0]).toMatchObject({
        number: 10,
        files: ['src/retry.ts'],
        linkedBugIssues: null,
    });
    expect(result.complete).toBe(false);
    expect(Date.parse(result.cursorEnd)).toBeLessThan(
        Date.parse(state!.windowEnd),
    );
    expect(maps.save).toHaveBeenCalledWith(
        'org',
        'repo',
        expect.objectContaining({
            coverage: expect.objectContaining({
                scanComplete: false,
                scannedPrs: 1,
            }),
        }),
    );
});

it('resets an older year-long scan to a bounded recent bootstrap', async () => {
    const legacy = {
        source: PlatformType.GITHUB,
        windowStart: new Date(
            Date.now() - 365 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        windowEnd: new Date().toISOString(),
        cursorEnd: new Date().toISOString(),
        scanFloor: new Date(
            Date.now() - 365 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        offset: 0,
        discoveredMergedPrs: 10,
        complete: false,
    };
    const sync = {
        findOne: jest.fn(() => ({
            lean: () => ({ exec: async () => legacy }),
        })),
        updateOne: jest.fn(),
    };
    const history = {
        deleteMany: jest.fn(),
        updateOne: jest.fn(),
        find: jest.fn(() => ({ lean: () => ({ exec: async () => [] }) })),
    };
    const codeManagement = {
        getTypeIntegration: jest.fn().mockResolvedValue(PlatformType.GITHUB),
        getPullRequestsByRepository: jest.fn().mockResolvedValue([]),
        isIssuesSupported: jest.fn().mockResolvedValue(false),
        getDefaultBranch: jest.fn().mockResolvedValue(null),
    };
    const maps = { read: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const service = new RefreshCodeAreaRiskMapService(
        codeManagement as any,
        maps as any,
        history as any,
        sync as any,
    );

    await service.refreshOneBatch({
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repository: { id: 'repo', name: 'api' },
    });

    expect(history.deleteMany).toHaveBeenCalledWith({
        organizationId: 'org',
        repositoryId: 'repo',
    });
    const reset = sync.updateOne.mock.calls[0][1].$set;
    expect(reset.version).toBe(2);
    expect(reset.discoveredMergedPrs).toBe(0);
    expect(Date.now() - Date.parse(reset.windowStart)).toBeGreaterThan(
        29 * 24 * 60 * 60 * 1000,
    );
    expect(Date.now() - Date.parse(reset.windowStart)).toBeLessThan(
        31 * 24 * 60 * 60 * 1000,
    );
});

it('marks a capped weekly listing as sampled', async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const state = {
        version: 2,
        source: PlatformType.GITHUB,
        windowStart: start.toISOString(),
        windowEnd: now.toISOString(),
        cursorEnd: now.toISOString(),
        scanFloor: start.toISOString(),
        offset: 0,
        discoveredMergedPrs: 0,
        sampled: false,
        complete: false,
    };
    const sync = {
        findOne: jest.fn(() => ({ lean: () => ({ exec: async () => state }) })),
        updateOne: jest.fn(),
    };
    const history = {
        deleteMany: jest.fn(),
        updateOne: jest.fn(),
        find: jest.fn(() => ({ lean: () => ({ exec: async () => [] }) })),
    };
    const codeManagement = {
        getPullRequestsByRepository: jest.fn().mockResolvedValue(
            Array.from({ length: 100 }, (_, index) => ({
                number: index + 1,
                updated_at: now.toISOString(),
            })),
        ),
        getPullRequest: jest.fn().mockResolvedValue(null),
        isIssuesSupported: jest.fn().mockResolvedValue(false),
        getDefaultBranch: jest.fn().mockResolvedValue(null),
    };
    const maps = { read: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const service = new RefreshCodeAreaRiskMapService(
        codeManagement as any,
        maps as any,
        history as any,
        sync as any,
    );

    await service.refreshOneBatch({
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repository: { id: 'repo', name: 'api' },
    });

    expect(sync.updateOne.mock.calls[0][1].$set.sampled).toBe(true);
    expect(maps.save).toHaveBeenCalledWith(
        'org',
        'repo',
        expect.objectContaining({
            coverage: expect.objectContaining({ sampled: true }),
        }),
    );
});

it('retains accumulated history for at most one year as new PRs arrive', async () => {
    const daysAgo = (days: number) =>
        new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const state = {
        version: 2,
        source: PlatformType.GITHUB,
        windowStart: daysAgo(400),
        windowEnd: daysAgo(2),
        cursorEnd: daysAgo(400),
        scanFloor: daysAgo(400),
        offset: 0,
        discoveredMergedPrs: 0,
        complete: true,
    };
    const sync = {
        findOne: jest.fn(() => ({ lean: () => ({ exec: async () => state }) })),
        updateOne: jest.fn(),
    };
    const history = {
        deleteMany: jest.fn(),
        updateOne: jest.fn(),
        find: jest.fn(() => ({ lean: () => ({ exec: async () => [] }) })),
    };
    const codeManagement = {
        getPullRequestsByRepository: jest.fn().mockResolvedValue([]),
        isIssuesSupported: jest.fn().mockResolvedValue(false),
    };
    const maps = { read: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const service = new RefreshCodeAreaRiskMapService(
        codeManagement as any,
        maps as any,
        history as any,
        sync as any,
    );

    await service.refreshOneBatch({
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repository: { id: 'repo', name: 'api' },
    });

    const renewal = sync.updateOne.mock.calls[0][1].$set;
    expect(Date.now() - Date.parse(renewal.windowStart)).toBeLessThan(
        366 * 24 * 60 * 60 * 1000,
    );
    expect(history.deleteMany).toHaveBeenCalledWith({
        organizationId: 'org',
        repositoryId: 'repo',
        mergedAt: { $lt: renewal.windowStart },
    });
});

it('adds a bounded structural sample when a history scan completes', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const mergedAt = new Date(end.getTime() - 60 * 60 * 1000).toISOString();
    const state = {
        version: 2,
        source: PlatformType.GITHUB,
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        cursorEnd: end.toISOString(),
        scanFloor: start.toISOString(),
        offset: 0,
        discoveredMergedPrs: 0,
        complete: false,
    };
    const sync = {
        findOne: jest.fn(() => ({ lean: () => ({ exec: async () => state }) })),
        updateOne: jest.fn(),
    };
    const record = {
        number: 1,
        url: 'https://example.com/pull/1',
        title: 'Fix session bug',
        mergedAt,
        linkedBugIssues: ['https://example.com/issues/1'],
        files: ['src/auth/session.ts'],
        filesComplete: true,
    };
    const history = {
        deleteMany: jest.fn().mockResolvedValue(undefined),
        updateOne: jest.fn(),
        find: jest.fn(() => ({
            lean: () => ({ exec: async () => [record] }),
        })),
    };
    const codeManagement = {
        getPullRequestsByRepository: jest.fn().mockResolvedValue([]),
        isIssuesSupported: jest.fn().mockResolvedValue(true),
        getDefaultBranch: jest.fn().mockResolvedValue('main'),
        getRepositoryContentFile: jest.fn().mockResolvedValue({
            data: {
                encoding: 'utf-8',
                content: 'export function session() { return true; }',
            },
        }),
    };
    const maps = { read: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const service = new RefreshCodeAreaRiskMapService(
        codeManagement as any,
        maps as any,
        history as any,
        sync as any,
    );

    const result = await service.refreshOneBatch({
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repository: { id: 'repo', name: 'api' },
    });

    expect(result.complete).toBe(true);
    expect(codeManagement.getRepositoryContentFile).toHaveBeenCalledWith(
        expect.objectContaining({
            file: { filename: 'src/auth/session.ts' },
        }),
    );
    expect(maps.save).toHaveBeenCalledWith(
        'org',
        'repo',
        expect.objectContaining({
            structureCoverage: {
                eligibleFiles: 1,
                analyzedFiles: 1,
                sampled: false,
            },
            directDirectories: expect.arrayContaining([
                expect.objectContaining({
                    path: 'src/auth',
                    structure: expect.objectContaining({
                        analyzedFiles: 1,
                        functions: 1,
                        functionsNeedingAttention: 0,
                    }),
                }),
            ]),
        }),
    );
});
