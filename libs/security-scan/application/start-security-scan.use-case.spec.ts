jest.mock('./scan-model', () => ({
    ...jest.requireActual('./scan-model'),
    resolveScanModel: jest.fn(async () => ({
        model: {
            modelName: 'fireworks:deepseek',
            slot: { provider: 'openai_compatible', model: 'deepseek' },
        },
        rates: { input: { default: 1e-6 }, output: { default: 2e-6 } },
    })),
}));

import { SecurityScanStatus } from '../domain/security-scan.types';
import { StartSecurityScanUseCase } from './start-security-scan.use-case';
import { resolveScanModel, SCAN_NEEDS_BYOK_MESSAGE } from './scan-model';

const unit = (id: string) => ({
    id,
    file: `src/${id}.ts`,
    relatedFiles: [],
    classes: ['authz'],
    priority: 50,
    reasons: [],
    language: 'typescript',
});

function useCaseWith(
    last: Record<string, unknown> | null,
    platform: string | null | Error = 'GITHUB',
    defaultBranch: string | Error = 'trunk',
) {
    const scans = {
        failStale: jest.fn(async () => 0),
        findActive: jest.fn(async () => null),
        findLatest: jest.fn(async () => last),
        create: jest.fn(async (scan: any) => ({ uuid: 'scan-2', ...scan })),
        update: jest.fn(async () => null),
    };
    const jobQueue = { enqueue: jest.fn() };
    const useCase = new StartSecurityScanUseCase(
        scans as any,
        jobQueue as any,
        {
            findIntegrationConfigFormatted: jest.fn(async () => [
                {
                    id: 'repo-1',
                    name: 'shop',
                    full_name: 'acme/shop',
                    // Stored when the repository was connected.
                    default_branch: 'main',
                    http_url: 'https://GitHub.com/acme/shop',
                },
            ]),
        } as any,
        {} as any,
        {
            findTypeIntegration: jest.fn(async () => {
                if (platform instanceof Error) throw platform;
                return platform;
            }),
            getDefaultBranch: jest.fn(async () => {
                if (defaultBranch instanceof Error) throw defaultBranch;
                return defaultBranch;
            }),
        } as any,
        {} as any,
        { getConfig: jest.fn(async () => null) } as any,
    );
    const start = () =>
        useCase.execute({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repositoryId: 'repo-1',
            budget: { maxUsd: 5 },
        } as any);
    return { scans, start, jobQueue };
}

describe('StartSecurityScanUseCase — running again continues', () => {
    const stopped = {
        status: SecurityScanStatus.STOPPED_BY_BUDGET,
        units: [unit('a'), unit('b'), unit('c')],
        progress: [
            { unitId: 'a', state: 'done', findings: 1 },
            { unitId: 'b', state: 'skipped_budget', findings: 0 },
            { unitId: 'c', state: 'skipped_budget', findings: 0 },
        ],
        reported: [
            { title: 'IDOR', filePath: 'src/a.ts', fingerprint: 'fp-a' },
            // Reported before fingerprints were kept: no way to sight it.
            { title: 'SQLi', filePath: 'src/b.ts' },
        ],
        coverage: { languages: ['typescript'], examinedFiles: ['src/a.ts'] },
        commitSha: 'plan-sha',
    };

    it('carries on with the areas the scan stopped at its limit had not reached', async () => {
        const { scans, start } = useCaseWith(stopped);

        await start();

        const created = scans.create.mock.calls[0][0];
        expect(created.units.map((u: any) => u.id)).toEqual(['a', 'b', 'c']);
        expect(created.progress).toEqual([
            { unitId: 'a', state: 'done', findings: 1 },
        ]);
        // What the plan's finished areas found: the dedup compares against
        // it, and the job sights those issues as this scan's. Only what can
        // be sighted is carried.
        expect(created.reported).toEqual([
            { title: 'IDOR', filePath: 'src/a.ts', fingerprint: 'fp-a' },
        ]);
        // The job drops the plan if the branch moved past this commit.
        expect(created.planCommitSha).toBe('plan-sha');
        // Files the earlier scan examined are not this scan's: none of their
        // findings is resolved for not being seen again.
        expect(created.coverage).toEqual(
            expect.objectContaining({
                examinedFiles: [],
                unitsTotal: 3,
                unitsDone: 1,
            }),
        );
    });

    it("looks for the repository's active and last scan by its platform and id", async () => {
        const { scans, start } = useCaseWith(null);

        await start();

        // A GitLab project with the same id is another repository, and so
        // is a project on another server of the same platform.
        const key = { platform: 'GITHUB', host: 'github.com', id: 'repo-1' };
        expect(scans.findActive).toHaveBeenCalledWith('org-1', key);
        expect(scans.findLatest).toHaveBeenCalledWith('org-1', key);
    });

    it('scans the branch the provider serves as default now, not the one stored when the repository was connected', async () => {
        const { scans, start } = useCaseWith(null);

        await start();

        expect(scans.create.mock.calls[0][0].repository).toEqual(
            expect.objectContaining({ defaultBranch: 'trunk', host: 'github.com' }),
        );
    });

    it('starts nothing when the provider cannot say which branch is the default', async () => {
        const { scans, start, jobQueue } = useCaseWith(null, 'GITHUB', new Error('502'));

        await expect(start()).rejects.toThrow(/Try again/);
        expect(scans.create).not.toHaveBeenCalled();
        expect(jobQueue.enqueue).not.toHaveBeenCalled();
    });

    it('names both causes when the provider gives no default branch: an empty repository, or an error it answered empty', async () => {
        const { scans, start } = useCaseWith(null, 'GITHUB', '');

        await expect(start()).rejects.toThrow(/gave no default branch.*empty.*try again/);
        expect(scans.create).not.toHaveBeenCalled();
    });

    it('refuses to start without an active code integration, writing nothing', async () => {
        const { scans, start, jobQueue } = useCaseWith(null, null);

        await expect(start()).rejects.toThrow(/no active code management integration/);
        expect(scans.findActive).not.toHaveBeenCalled();
        expect(scans.create).not.toHaveBeenCalled();
        expect(jobQueue.enqueue).not.toHaveBeenCalled();
    });

    it('lets a failed integration lookup through as the error it is, not as a missing integration', async () => {
        const { scans, start } = useCaseWith(null, new Error('postgres down'));

        await expect(start()).rejects.toThrow('postgres down');
        expect(scans.create).not.toHaveBeenCalled();
    });

    it("carries on the plan's coverage gaps, so the scan does not read as full coverage", async () => {
        const { scans, start } = useCaseWith({
            ...stopped,
            coverage: {
                ...stopped.coverage,
                mapFailedLanguages: ['python'],
                filesBeyondPlan: 1,
            },
        });

        await start();

        expect(scans.create.mock.calls[0][0].coverage).toEqual(
            expect.objectContaining({ mapFailedLanguages: ['python'], filesBeyondPlan: 1 }),
        );
    });

    it('keeps the commit a plan was made at through a scan that failed before reading HEAD', async () => {
        // B carried A's plan on and failed before cloning: no commit of its own.
        const { scans, start } = useCaseWith({
            ...stopped,
            status: SecurityScanStatus.FAILED,
            commitSha: undefined,
            planCommitSha: 'plan-sha',
        });

        await start();

        expect(scans.create.mock.calls[0][0].planCommitSha).toBe('plan-sha');
    });

    it('never carries on a plan nothing ties to a commit', async () => {
        const { scans, start } = useCaseWith({
            ...stopped,
            commitSha: undefined,
            planCommitSha: undefined,
        });

        await start();

        const created = scans.create.mock.calls[0][0];
        expect(created.units).toEqual([]);
        expect(created.progress).toEqual([]);
    });

    it("carries what the finished areas read, so this scan resolves what they no longer hold", async () => {
        const { scans, start } = useCaseWith({
            ...stopped,
            units: [unit('a'), unit('b'), { ...unit('d'), classes: ['injection'] }],
            progress: [
                { unitId: 'a', state: 'done', findings: 1 },
                { unitId: 'b', state: 'skipped_budget', findings: 0 },
                { unitId: 'd', state: 'done', findings: 0 },
            ],
            reported: [
                { vulnerabilityClass: 'authz', title: 'IDOR', filePath: 'src/a.ts', fingerprint: 'fp-a' },
                // Unsightable: its area is left out, so it is not resolved as unseen.
                { vulnerabilityClass: 'injection', title: 'SQLi', filePath: 'src/d.ts' },
            ],
        });

        await start();

        expect(scans.create.mock.calls[0][0].coverage.inheritedExaminedByClass).toEqual([
            { vulnerabilityClass: 'authz', filePaths: ['src/a.ts'] },
        ]);
    });

    it('runs again the areas a provider outage failed', async () => {
        const { scans, start } = useCaseWith({
            ...stopped,
            status: SecurityScanStatus.FAILED,
            progress: [
                { unitId: 'a', state: 'done', findings: 1 },
                { unitId: 'b', state: 'failed', findings: 0 },
                { unitId: 'c', state: 'failed', findings: 0 },
            ],
        });

        await start();

        const created = scans.create.mock.calls[0][0];
        expect(created.progress).toEqual([
            { unitId: 'a', state: 'done', findings: 1 },
        ]);
        expect(created.coverage).toEqual(
            expect.objectContaining({ unitsDone: 1, unitsFailed: 0 }),
        );
    });

    it('runs again the areas of a completed scan whose lenses failed', async () => {
        const { scans, start } = useCaseWith({
            ...stopped,
            status: SecurityScanStatus.COMPLETED,
            progress: [
                { unitId: 'a', state: 'done', findings: 1 },
                { unitId: 'b', state: 'done', findings: 0 },
                { unitId: 'c', state: 'failed', findings: 0 },
            ],
        });

        await start();

        const created = scans.create.mock.calls[0][0];
        expect(created.units.map((u: any) => u.id)).toEqual(['a', 'b', 'c']);
        expect(created.progress.map((p: any) => p.unitId)).toEqual(['a', 'b']);
    });

    it('starts from scratch after a scan that completed', async () => {
        const { scans, start } = useCaseWith({
            ...stopped,
            status: SecurityScanStatus.COMPLETED,
        });

        await start();

        const created = scans.create.mock.calls[0][0];
        expect(created.units).toEqual([]);
        expect(created.progress).toEqual([]);
    });

    it('starts from scratch when there is no earlier scan', async () => {
        const { scans, start } = useCaseWith(null);

        await start();

        expect(scans.create.mock.calls[0][0].units).toEqual([]);
    });
});

describe('StartSecurityScanUseCase — own model only', () => {
    it("refuses to scan on the managed model when the organization has none of its own", async () => {
        (resolveScanModel as jest.Mock).mockResolvedValueOnce({
            model: { modelName: 'managed:default', slot: undefined },
            rates: null,
        });
        const { scans, start } = useCaseWith(null);

        await expect(start()).rejects.toThrow(SCAN_NEEDS_BYOK_MESSAGE);
        expect(scans.create).not.toHaveBeenCalled();
    });
});

describe('StartSecurityScanUseCase — a scan that cannot be queued', () => {
    it('fails the record, so the repository is free for the next start', async () => {
        const { scans, start, jobQueue } = useCaseWith(null);
        jobQueue.enqueue.mockRejectedValue(new Error('postgres down'));

        await expect(start()).rejects.toThrow('postgres down');
        expect(scans.update).toHaveBeenCalledWith(
            'scan-2',
            expect.objectContaining({ status: SecurityScanStatus.FAILED }),
        );
    });
});

describe('StartSecurityScanUseCase — a duplicate key on create', () => {
    const duplicateKey = () =>
        Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

    it('reports a scan already running when one is now active', async () => {
        const { scans, start } = useCaseWith(null);
        scans.create.mockRejectedValueOnce(duplicateKey());
        scans.findActive
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ uuid: 'other-scan' } as any);

        await expect(start()).rejects.toThrow(/already running/);
    });

    it('fails with the real error when no scan is active', async () => {
        const { scans, start } = useCaseWith(null);
        const error = duplicateKey();
        scans.create.mockRejectedValueOnce(error);

        await expect(start()).rejects.toBe(error);
    });
});
