import {
    buildCodeAreaRiskMap,
    HistoricalAreaPullRequest,
    rankCodeAreas,
} from './build-area-risk-map';

const pr = (
    number: number,
    overrides: Partial<HistoricalAreaPullRequest>,
): HistoricalAreaPullRequest => ({
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    title: `Change ${number}`,
    mergedAt: '2025-01-15T00:00:00Z',
    linkedBugIssues: [],
    files: ['src/auth/login.ts'],
    filesComplete: true,
    ...overrides,
});

it('keeps linked bug evidence separate from title signals and counts one PR per directory', () => {
    const result = buildCodeAreaRiskMap({
        source: 'github',
        windowStart: '2025-01-01T00:00:00Z',
        windowEnd: '2025-02-01T00:00:00Z',
        refreshedAt: '2025-02-02T00:00:00Z',
        discoveredMergedPrs: 4,
        pullRequests: [
            pr(1, {
                title: 'Fix auth bug',
                linkedBugIssues: ['https://github.com/example/repo/issues/10'],
                files: ['src/auth/login.ts', 'src/auth/logout.ts'],
            }),
            pr(2, {
                title: 'Fix typo',
                linkedBugIssues: null,
                files: ['src/auth/login.ts'],
            }),
            pr(3, {
                files: ['src/auth/login.ts'],
                filesComplete: false,
            }),
            pr(4, {
                mergedAt: '2025-03-01T00:00:00Z',
                files: ['src/auth/login.ts'],
            }),
        ],
    });

    expect(result.coverage).toEqual({
        discoveredMergedPrs: 4,
        scannedPrs: 3,
        prsWithCompleteFiles: 2,
        prsWithIssueSupport: 2,
        scanComplete: false,
    });
    expect(
        result.directories.find((area) => area.path === 'src/auth'),
    ).toMatchObject({
        changedPrs: 3,
        linkedBugFixPrs: 1,
        titleBugFixPrs: 1,
    });
    expect(
        result.files.find((area) => area.path === 'src/auth/login.ts'),
    ).toMatchObject({
        changedPrs: 3,
        linkedBugFixPrs: 1,
        titleBugFixPrs: 1,
    });
    expect(result.files[0].recentEvidence[0]).toMatchObject({
        prNumber: 1,
        bugFixEvidence: 'linked-bug-issue',
        bugIssueUrls: ['https://github.com/example/repo/issues/10'],
    });
    expect(result.version).toMatch(/^[0-9a-f]{64}$/);
});

it('does not turn missing history into a zero-risk assertion', () => {
    const result = buildCodeAreaRiskMap({
        source: 'gitlab',
        windowStart: '2025-01-01T00:00:00Z',
        windowEnd: '2025-02-01T00:00:00Z',
        refreshedAt: '2025-02-02T00:00:00Z',
        discoveredMergedPrs: 0,
        pullRequests: [],
    });

    expect(result.files).toEqual([]);
    expect(result.coverage.scannedPrs).toBe(0);
    expect(result.coverage.prsWithIssueSupport).toBe(0);
});

it('ranks bug evidence separately from the churn control', () => {
    const areas = [
        {
            path: 'busy',
            changedPrs: 3,
            linkedBugFixPrs: 0,
            titleBugFixPrs: 0,
            recentEvidence: [],
        },
        {
            path: 'buggy',
            changedPrs: 2,
            linkedBugFixPrs: 2,
            titleBugFixPrs: 0,
            recentEvidence: [],
        },
    ];
    expect(rankCodeAreas(areas)[0].path).toBe('buggy');
    expect(rankCodeAreas(areas, 'churn')[0].path).toBe('busy');
});
