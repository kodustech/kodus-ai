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
        getPullRequest: jest.fn().mockResolvedValue({
            number: 10,
            title: 'Fix retry bug',
            merged_at: recent,
            prURL: 'https://github.com/acme/api/pull/10',
            body: '',
            head: { sha: 'abc' },
        }),
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
    expect(state!.version).toBe(3);
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
    expect(reset.version).toBe(3);
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
        version: 3,
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

it('keeps a stable weekly PR list and advances past an unreadable PR', async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    let state: Record<string, any> = {
        version: 3,
        source: PlatformType.GITHUB,
        windowStart: start.toISOString(),
        windowEnd: now.toISOString(),
        cursorEnd: now.toISOString(),
        scanFloor: start.toISOString(),
        offset: 0,
        windowPrNumbers: null,
        discoveredMergedPrs: 0,
        sampled: false,
        complete: false,
    };
    const sync = {
        findOne: jest.fn(() => ({ lean: () => ({ exec: async () => state }) })),
        updateOne: jest.fn(async (_key, update) => {
            state = { ...state, ...update.$set };
        }),
    };
    const history = {
        deleteMany: jest.fn(),
        updateOne: jest.fn(),
        find: jest.fn(() => ({ lean: () => ({ exec: async () => [] }) })),
    };
    const codeManagement = {
        getPullRequestsByRepository: jest.fn().mockResolvedValue(
            Array.from({ length: 12 }, (_, index) => ({
                number: index + 1,
                updated_at: new Date(
                    now.getTime() - index * 1000,
                ).toISOString(),
            })),
        ),
        getPullRequest: jest.fn(async ({ prNumber }) => {
            if (prNumber === 1) throw new Error('unreadable diff');
            return { merged_at: null };
        }),
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
    const params = {
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        repository: { id: 'repo', name: 'api' },
    };

    await service.refreshOneBatch(params);
    expect(state.offset).toBe(10);
    expect(state.sampled).toBe(true);
    expect(state.windowPrNumbers).toHaveLength(12);

    await service.refreshOneBatch(params);
    expect(codeManagement.getPullRequestsByRepository).toHaveBeenCalledTimes(1);
    expect(codeManagement.getPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 11 }),
    );
    expect(codeManagement.getPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 12 }),
    );
    expect(state.windowPrNumbers).toBeNull();
});

it('recognizes closing references and resolves GitLab issues by project ID', async () => {
    const codeManagement = {
        getIssue: jest.fn().mockResolvedValue({
            labels: ['bug'],
            url: 'https://host/gitlab/g/p/-/issues/12',
        }),
    };
    const service = new RefreshCodeAreaRiskMapService(
        codeManagement as any,
        {} as any,
        {} as any,
        {} as any,
    );

    const urls = await (service as any).findLinkedBugIssues(
        { organizationId: 'org', teamId: 'team' },
        { id: '42', name: 'p' },
        'Fixed: https://host/gitlab/g/p/-/issues/12',
        'https://host/gitlab/g/p/-/merge_requests/1',
    );

    expect(urls).toEqual(['https://host/gitlab/g/p/-/issues/12']);
    expect(codeManagement.getIssue).toHaveBeenCalledWith(
        expect.objectContaining({
            repository: expect.objectContaining({ id: '42' }),
            issueNumber: 12,
        }),
    );
});

it('bounds a large area snapshot before MongoDB storage', () => {
    const service = new RefreshCodeAreaRiskMapService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
    );
    const area = (number: number) => ({
        path: `src/area-${number}.ts`,
        changedPrs: 1,
        linkedBugFixPrs: 0,
        titleBugFixPrs: 0,
        recentEvidence: [
            {
                prNumber: number,
                prUrl: 'x'.repeat(10_000),
                mergedAt: '2026-01-01',
            },
        ],
    });
    const snapshot: any = {
        version: 'old',
        source: 'github',
        windowStart: '2026-01-01',
        windowEnd: '2026-02-01',
        refreshedAt: '2026-02-01',
        coverage: {
            discoveredMergedPrs: 1000,
            scannedPrs: 1000,
            prsWithCompleteFiles: 1000,
            prsWithIssueSupport: 0,
            scanComplete: true,
        },
        files: Array.from({ length: 1000 }, (_, index) => area(index)),
        directories: [],
        directDirectories: [],
    };

    (service as any).boundSnapshot(snapshot);

    expect(snapshot.coverage.sampled).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
        8 * 1024 * 1024,
    );
});

it('retains accumulated history for at most one year as new PRs arrive', async () => {
    const daysAgo = (days: number) =>
        new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const state = {
        version: 3,
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
        version: 3,
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
