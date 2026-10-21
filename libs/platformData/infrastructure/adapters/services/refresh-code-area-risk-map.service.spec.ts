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
            filters: expect.objectContaining({ dateField: 'updated' }),
        }),
    );
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

it('adds a bounded structural sample when a history scan completes', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const mergedAt = new Date(end.getTime() - 60 * 60 * 1000).toISOString();
    const state = {
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
