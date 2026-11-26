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
import {
    MAX_ACTIVE_SCANS_PER_ORGANIZATION,
    SCAN_MODEL_NOT_FOUND_MESSAGE,
    SCAN_QUEUE_UNAVAILABLE_MESSAGE,
    StartSecurityScanUseCase,
    TOO_MANY_ACTIVE_SCANS_MESSAGE,
} from './start-security-scan.use-case';
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
    repositoryOverrides: Record<string, unknown> = {},
) {
    const scans = {
        failStale: jest.fn(async () => 0),
        findActive: jest.fn(async () => null),
        countActive: jest.fn(async () => 0),
        findOldestActiveIds: jest.fn(async () => ['scan-2']),
        findLatest: jest.fn(async () => last),
        create: jest.fn(async (scan: any) => ({ uuid: 'scan-2', ...scan })),
        update: jest.fn(async () => null),
    };
    const jobQueue = { enqueue: jest.fn() };
    const queueProbe = { consumerCount: jest.fn(async () => 1) };
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
                    ...repositoryOverrides,
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
        queueProbe as any,
    );
    const start = (extra: Record<string, unknown> = {}) =>
        useCase.execute({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repositoryId: 'repo-1',
            budget: { maxUsd: 5 },
            ...extra,
        } as any);
    return {
        scans,
        start,
        jobQueue,
        queueProbe,
        codeManagement: (useCase as any).codeManagementService,
    };
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
        modelName: 'fireworks:deepseek',
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

    it('starts its own plan when asked to read everything again, or on another model', async () => {
        const full = useCaseWith(stopped);
        await full.start({ mode: 'full' });
        expect(full.scans.create.mock.calls[0][0].units).toEqual([]);
        expect(full.scans.create.mock.calls[0][0].progress).toEqual([]);

        // The last scan ran on another model: its conclusions are not this model's.
        const other = useCaseWith({
            ...stopped,
            modelName: 'anthropic:claude-opus',
        });
        await other.start();
        expect(other.scans.create.mock.calls[0][0].units).toEqual([]);

        // No model on record: nothing says it is this one.
        const unknown = useCaseWith({ ...stopped, modelName: undefined });
        await unknown.start();
        expect(unknown.scans.create.mock.calls[0][0].units).toEqual([]);

        const same = useCaseWith({
            ...stopped,
            modelName: 'fireworks:deepseek',
        });
        await same.start();
        expect(
            same.scans.create.mock.calls[0][0].units.map((u: any) => u.id),
        ).toEqual(['a', 'b', 'c']);
    });

    it('carries a finished unit without what it examined, so it never supplies a miss of the new scan', async () => {
        const examined = [
            { vulnerabilityClass: 'injection', filePaths: ['src/a.ts'] },
        ];
        const { scans, start } = useCaseWith({
            ...stopped,
            progress: [
                {
                    unitId: 'a',
                    state: 'done',
                    findings: 0,
                    examinedByClass: examined,
                },
                { unitId: 'b', state: 'failed', findings: 0 },
            ],
        });

        await start();

        const created = scans.create.mock.calls[0][0];
        expect(created.progress).toEqual([
            { unitId: 'a', state: 'done', findings: 0 },
        ]);
        expect(created.coverage.examinedByClass).toEqual([]);
        expect(created.coverage.inheritedExaminedByClass).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ filePaths: ['src/a.ts'] }),
            ]),
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
        const { scans, start, codeManagement } = useCaseWith(null);

        await start();

        // Strict: an adapter's fallback name ("main") is never the answer.
        expect(codeManagement.getDefaultBranch).toHaveBeenCalledWith(
            expect.objectContaining({ strict: true }),
            'GITHUB',
        );

        expect(scans.create.mock.calls[0][0].repository).toEqual(
            expect.objectContaining({
                defaultBranch: 'trunk',
                host: 'github.com',
            }),
        );
    });

    it('starts nothing when the provider cannot say which branch is the default', async () => {
        const { scans, start, jobQueue } = useCaseWith(
            null,
            'GITHUB',
            new Error('502'),
        );

        const error = await start().catch((e) => e);
        expect(error.message).toMatch(/Try again/);
        expect(error.getStatus()).toBe(503);
        expect(scans.create).not.toHaveBeenCalled();
        expect(jobQueue.enqueue).not.toHaveBeenCalled();
    });

    it('names both causes when the provider gives no default branch: an empty repository, or an error it answered empty', async () => {
        const { scans, start } = useCaseWith(null, 'GITHUB', '');

        const error = await start().catch((e) => e);
        expect(error.message).toMatch(
            /gave no default branch.*empty.*try again/,
        );
        // Retryable: Bitbucket Cloud answers empty on its own errors too.
        expect(error.getStatus()).toBe(503);
        expect(scans.create).not.toHaveBeenCalled();
    });

    it('refuses to start without an active code integration, writing nothing', async () => {
        const { scans, start, jobQueue, queueProbe } = useCaseWith(null, null);

        await expect(start()).rejects.toThrow(
            /no active code management integration/,
        );
        expect(scans.findActive).not.toHaveBeenCalled();
        expect(scans.create).not.toHaveBeenCalled();
        expect(jobQueue.enqueue).not.toHaveBeenCalled();
        expect(queueProbe.consumerCount).not.toHaveBeenCalled();
    });

    it.each([undefined, '', 'not a URL'])(
        'refuses a repository without a confirmed host (%s) before writing or queuing a scan',
        async (http_url) => {
            const { scans, start, jobQueue, queueProbe } = useCaseWith(
                null,
                'GITHUB',
                'trunk',
                { http_url },
            );
            await expect(start()).rejects.toThrow(/Git host.*reconnect/i);
            expect(scans.failStale).not.toHaveBeenCalled();
            expect(scans.findActive).not.toHaveBeenCalled();
            expect(scans.create).not.toHaveBeenCalled();
            expect(jobQueue.enqueue).not.toHaveBeenCalled();
            expect(queueProbe.consumerCount).not.toHaveBeenCalled();
        },
    );

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
            expect.objectContaining({
                mapFailedLanguages: ['python'],
                filesBeyondPlan: 1,
            }),
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

    it('carries what the finished areas read, so this scan resolves what they no longer hold', async () => {
        const { scans, start } = useCaseWith({
            ...stopped,
            units: [
                unit('a'),
                unit('b'),
                { ...unit('d'), classes: ['injection'] },
            ],
            progress: [
                { unitId: 'a', state: 'done', findings: 1 },
                { unitId: 'b', state: 'skipped_budget', findings: 0 },
                { unitId: 'd', state: 'done', findings: 0 },
            ],
            reported: [
                {
                    vulnerabilityClass: 'authz',
                    title: 'IDOR',
                    filePath: 'src/a.ts',
                    fingerprint: 'fp-a',
                },
                // Unsightable: its area is left out, so it is not resolved as unseen.
                {
                    vulnerabilityClass: 'injection',
                    title: 'SQLi',
                    filePath: 'src/d.ts',
                },
            ],
        });

        await start();

        expect(
            scans.create.mock.calls[0][0].coverage.inheritedExaminedByClass,
        ).toEqual([{ vulnerabilityClass: 'authz', filePaths: ['src/a.ts'] }]);
    });

    it('carries on a cancelled scan that had started', async () => {
        const { scans, start } = useCaseWith({
            ...stopped,
            status: SecurityScanStatus.CANCELLED,
        });

        await start();

        expect(
            scans.create.mock.calls[0][0].units.map((u: any) => u.id),
        ).toEqual(['a', 'b', 'c']);
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
    it('refuses to scan on the managed model when the organization has none of its own', async () => {
        (resolveScanModel as jest.Mock).mockResolvedValueOnce({
            model: { modelName: 'managed:default', slot: undefined },
            rates: null,
        });
        const { scans, start } = useCaseWith(null);

        await expect(start()).rejects.toThrow(SCAN_NEEDS_BYOK_MESSAGE);
        expect(scans.create).not.toHaveBeenCalled();
    });
});

describe('StartSecurityScanUseCase — queue must be taking jobs', () => {
    it.each([0, null])(
        'starts nothing when the security-scan queue has no consumer (%s)',
        async (consumers) => {
            const { scans, start, jobQueue, queueProbe } = useCaseWith(null);
            queueProbe.consumerCount.mockResolvedValue(consumers);

            const error = await start().catch((e) => e);
            expect(error.message).toBe(SCAN_QUEUE_UNAVAILABLE_MESSAGE);
            expect(error.getStatus()).toBe(503);
            expect(scans.create).not.toHaveBeenCalled();
            expect(scans.failStale).not.toHaveBeenCalled();
            expect(jobQueue.enqueue).not.toHaveBeenCalled();
        },
    );

    it('starts nothing when the broker cannot be reached', async () => {
        const { scans, start, jobQueue, queueProbe } = useCaseWith(null);
        queueProbe.consumerCount.mockRejectedValue(new Error('ECONNREFUSED'));

        const error = await start().catch((e) => e);
        expect(error.message).toBe(SCAN_QUEUE_UNAVAILABLE_MESSAGE);
        expect(error.getStatus()).toBe(503);
        expect(scans.create).not.toHaveBeenCalled();
        expect(jobQueue.enqueue).not.toHaveBeenCalled();
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

describe('StartSecurityScanUseCase — how the scan runs', () => {
    it('is incremental unless asked to read everything again', async () => {
        const { scans, start } = useCaseWith(null);

        await start();
        await start({ mode: 'full' });

        expect(scans.create.mock.calls[0][0].mode).toBe('incremental');
        expect(scans.create.mock.calls[1][0].mode).toBe('full');
    });

    it('runs on the model picked for it, and records it for the job slices that run it', async () => {
        (resolveScanModel as jest.Mock).mockResolvedValueOnce({
            model: {
                modelName: 'anthropic:claude-opus',
                slot: {
                    provider: 'anthropic',
                    model: 'claude-opus',
                    byokModelId: 'm-opus',
                },
            },
            rates: { input: { default: 1e-6 }, output: { default: 2e-6 } },
        });
        const { scans, start } = useCaseWith(null);

        await start({ modelId: 'm-opus' });

        expect(resolveScanModel).toHaveBeenLastCalledWith(
            expect.objectContaining({ modelId: 'm-opus' }),
        );
        expect(scans.create.mock.calls[0][0]).toMatchObject({
            modelId: 'm-opus',
            modelName: 'anthropic:claude-opus',
        });
    });

    it('refuses a picked model that is no longer configured, instead of running on another', async () => {
        // The pick resolves to the routing's model when its id is gone.
        const { scans, start } = useCaseWith(null);

        await expect(start({ modelId: 'm-deleted' })).rejects.toThrow(
            SCAN_MODEL_NOT_FOUND_MESSAGE,
        );
        expect(scans.create).not.toHaveBeenCalled();
    });
});

describe('StartSecurityScanUseCase — a share of the workers per organization', () => {
    it("starts nothing past the organization's limit of running scans", async () => {
        const { scans, start, jobQueue } = useCaseWith(null);
        scans.countActive.mockResolvedValue(MAX_ACTIVE_SCANS_PER_ORGANIZATION);

        const error = await start().catch((e) => e);

        expect(error.message).toBe(TOO_MANY_ACTIVE_SCANS_MESSAGE);
        expect(error.getStatus()).toBe(429);
        expect(scans.create).not.toHaveBeenCalled();
        expect(jobQueue.enqueue).not.toHaveBeenCalled();
    });

    it('gives the place back when another start of the organization took it first', async () => {
        const { scans, start, jobQueue } = useCaseWith(null);
        scans.findOldestActiveIds.mockResolvedValue([
            'scan-a',
            'scan-b',
            'scan-c',
        ]);

        const error = await start().catch((e) => e);

        expect(error.getStatus()).toBe(429);
        expect(scans.update).toHaveBeenCalledWith(
            'scan-2',
            expect.objectContaining({
                status: SecurityScanStatus.FAILED,
                error: TOO_MANY_ACTIVE_SCANS_MESSAGE,
            }),
        );
        expect(jobQueue.enqueue).not.toHaveBeenCalled();
    });
});

describe('StartSecurityScanUseCase — a unit the limit stopped halfway', () => {
    it('carries the lenses it read to the end as inherited, and runs again one cut short', async () => {
        const { scans, start } = useCaseWith({
            status: SecurityScanStatus.STOPPED_BY_BUDGET,
            modelName: 'fireworks:deepseek',
            units: [
                unit('a'),
                { ...unit('b'), classes: ['authz', 'injection', 'ssrf'] },
            ],
            progress: [
                { unitId: 'a', state: 'done', findings: 0 },
                {
                    unitId: 'b',
                    state: 'skipped_budget',
                    findings: 1,
                    // ssrf ran but was cut short.
                    lensesRun: ['authz', 'ssrf'],
                    lensesExamined: ['authz'],
                },
            ],
            reported: [],
            coverage: { languages: ['typescript'] },
            commitSha: 'plan-sha',
        });

        await start();

        const created = scans.create.mock.calls[0][0];
        expect(created.progress).toEqual([
            { unitId: 'a', state: 'done', findings: 0 },
            {
                unitId: 'b',
                state: 'pending',
                findings: 0,
                lensesRun: ['authz'],
                lensesExamined: [],
                lensesInherited: ['authz'],
            },
        ]);
        expect(created.coverage.unitsDone).toBe(1);
    });
});
