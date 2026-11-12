jest.mock('./security-scan-engine', () => ({
    SecurityScanEngine: jest.fn(),
}));
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/model-factory',
    () => ({
        resolveReviewAgentModel: jest.fn(async () => ({
            byokConfig: { provider: 'openai_compatible', model: 'deepseek-v4-flash' },
            main: { role: 'main', modelName: 'openai_compatible:deepseek-v4-flash' },
        })),
    }),
);

import { SecurityScanEngine } from './security-scan-engine';
import {
    ScanFailure,
    SecurityScanJobProcessor,
    buildIssueDescription,
    scanErrorMessage,
} from './security-scan-job.processor';
import { SecurityScanStatus } from '../domain/security-scan.types';
import { resolveReviewAgentModel } from '@libs/code-review/infrastructure/agents/collaborators/model-factory';
import { SCAN_NEEDS_BYOK_MESSAGE } from './scan-model';
import { SCAN_NO_AREA_EXAMINED_MESSAGE } from '../domain/scan-failure';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

const scanRecord = (overrides = {}) => ({
    uuid: 'scan-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repository: {
        id: 'repo-1',
        name: 'shop',
        fullName: 'acme/shop',
        platform: 'GITHUB',
        defaultBranch: 'main',
    },
    status: SecurityScanStatus.QUEUED,
    budget: { maxUsd: 10 },
    spend: { usd: 0, inputTokens: 0, outputTokens: 0, requests: 0 },
    units: [],
    progress: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
});

const finding = {
    unitId: 'u1',
    vulnerabilityClass: 'authz',
    cwe: 'CWE-639',
    title: 'Any user reads any order',
    description: 'The id from the path loads any order.',
    severity: 'high',
    filePath: 'src/orders.controller.ts',
    startLine: 7,
    endLine: 7,
    language: 'typescript',
    symbol: 'OrdersController.findOne',
    attackPath: [{ file: 'src/orders.controller.ts', line: 5, note: 'id from path' }],
};

function setup(engineResult: any, scan = scanRecord()) {
    const scans = {
        findById: jest.fn(async () => scan),
        update: jest.fn(async (..._args: unknown[]) => scan),
        recordUnit: jest.fn(async (..._args: unknown[]) => undefined),
    };
    const jobRepository = {
        findOne: jest.fn(async () => ({
            payload: {
                scanId: 'scan-1',
                organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
            },
        })),
        update: jest.fn(),
    };
    const jobQueue = { enqueue: jest.fn() };
    const sandbox = {
        type: 'e2b',
        repoDir: '/repo',
        run: jest.fn(async () => ({ stdout: 'abc123\n', exitCode: 0 })),
        remoteCommands: { read: jest.fn(async () => { throw new Error('none'); }) },
        cleanup: jest.fn(),
    };
    const leaseManager = { acquire: jest.fn(async () => ({ sandbox })) };
    const codeManagementService = {
        getCloneParams: jest.fn(async () => ({
            url: 'https://github.com/acme/shop.git',
            auth: { token: 't' },
        })),
    };
    const pricingResolver = {
        resolve: jest.fn(async () => ({
            priced: true,
            rates: {
                input: { default: 1e-6 },
                output: { default: 1e-6 },
                cacheRead: { default: 0 },
                cacheWrite: { default: 0 },
            },
        })),
    };
    const spendLimitConfig = { getConfig: jest.fn(async () => null) };
    const issuesService = {
        upsertScanFinding: jest.fn(async () => ({ outcome: 'created' })),
        resolveUnseenScanFindings: jest.fn(async () => 2),
        markScanFindingsSeen: jest.fn(async (..._args: unknown[]) => ({ sighted: 0, reopened: 0 })),
        findOpenScanFindingAreas: jest.fn(async () => [
            { filePath: 'src/orders.ts', vulnerabilityClass: 'authz' },
        ]),
    };
    const kodyIssuesManagement = { clearIssuesCache: jest.fn(async () => undefined) };

    (SecurityScanEngine as unknown as jest.Mock).mockImplementation(() => ({
        run: jest.fn(async (params: any) => {
            await params.onPlanned?.([], ['typescript']);
            for (const [progress, findings, sighted] of engineResult.unitEvents ?? []) {
                await params.onUnitDone(progress, findings, sighted);
            }
            return engineResult.result;
        }),
    }));

    const processor = new SecurityScanJobProcessor(
        jobRepository as any,
        jobQueue as any,
        scans as any,
        leaseManager as any,
        codeManagementService as any,
        {} as any,
        pricingResolver as any,
        spendLimitConfig as any,
        issuesService as any,
        kodyIssuesManagement as any,
    );

    return { processor, scans, jobQueue, issuesService, sandbox, kodyIssuesManagement, leaseManager, pricingResolver };
}

const lastUpdate = (scans: { update: jest.Mock }) =>
    (scans.update.mock.calls.at(-1) as unknown[])[1] as any;

const finishedResult = (overrides = {}) => ({
    units: [{ id: 'u1' }],
    progress: [{ unitId: 'u1', state: 'done', findings: 1 }],
    findings: [finding],
    languages: ['typescript'],
    finished: true,
    stoppedByBudget: false,
    examinedFiles: ['src/orders.controller.ts'],
    examinedByClass: [{ vulnerabilityClass: 'authz', filePaths: ['src/orders.controller.ts'] }],
    ...overrides,
});

describe('SecurityScanJobProcessor', () => {
    it('stores each finding as an issue, resolves what was not seen again and completes', async () => {
        const { processor, scans, issuesService, sandbox, kodyIssuesManagement, leaseManager } =
            setup({
                unitEvents: [[{ unitId: 'u1', state: 'done', findings: 1 }, [finding]]],
                result: finishedResult(),
            });

        await processor.process('job-1');

        expect(issuesService.upsertScanFinding).toHaveBeenCalledWith(
            expect.objectContaining({
                fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
                label: 'security',
                cwe: 'CWE-639',
                lastSeenScanId: 'scan-1',
                // What the sandbox checked out: the issue links there.
                lastSeenCommitSha: 'abc123',
                symbol: 'OrdersController.findOne',
            }),
        );
        // A new plan reads the repository's open findings again.
        const engine = (SecurityScanEngine as unknown as jest.Mock).mock.results.at(-1)!.value;
        expect(engine.run.mock.calls[0][0].revisit).toEqual([
            { filePath: 'src/orders.ts', vulnerabilityClass: 'authz' },
        ]);
        expect(issuesService.findOpenScanFindingAreas).toHaveBeenCalledWith({
            organizationId: 'org-1',
            repositoryPlatform: 'GITHUB',
            repositoryId: 'repo-1',
        });
        expect(issuesService.resolveUnseenScanFindings).toHaveBeenCalledWith({
            organizationId: 'org-1',
            repositoryPlatform: 'GITHUB',
            repositoryId: 'repo-1',
            scanId: 'scan-1',
            examined: [{ vulnerabilityClass: 'authz', filePaths: ['src/orders.controller.ts'] }],
            trackedFiles: undefined,
            scanStartedAt: expect.any(String),
        });
        const last = lastUpdate(scans);
        expect(last).toEqual(
            expect.objectContaining({
                status: SecurityScanStatus.COMPLETED,
                outcome: expect.objectContaining({ created: 1, resolved: 2 }),
            }),
        );
        expect(kodyIssuesManagement.clearIssuesCache).toHaveBeenCalledWith('org-1');
        // The lease manager only takes org:repo:<slot> keys.
        const [key] = leaseManager.acquire.mock.calls[0] as unknown as [string];
        expect(key.split(':')).toHaveLength(3);
        expect(sandbox.cleanup).toHaveBeenCalled();
    });

    it('marks a scan stopped by its budget, still resolving only what it examined', async () => {
        const { processor, scans, issuesService } = setup({
            result: finishedResult({
                finished: false,
                stoppedByBudget: true,
                examinedFiles: [],
                examinedByClass: [],
                trackedFiles: ['src/orders.controller.ts'],
                progress: [{ unitId: 'u1', state: 'skipped_budget', findings: 0 }],
            }),
        });

        await processor.process('job-1');

        // Nothing examined, but a file gone from the branch is gone.
        expect(issuesService.resolveUnseenScanFindings).toHaveBeenCalledWith(
            expect.objectContaining({
                examined: [],
                trackedFiles: ['src/orders.controller.ts'],
            }),
        );
        expect(lastUpdate(scans).status).toBe(
            SecurityScanStatus.STOPPED_BY_BUDGET,
        );
    });

    it('hands the rest to a new job when the sandbox time runs out', async () => {
        const earlier = {
            vulnerabilityClass: 'ssrf',
            title: 'Server fetches any URL',
            description: 'd',
            severity: 'high',
            filePath: 'src/research.ts',
            startLine: 15,
            endLine: 16,
        };
        const { processor, scans, jobQueue, issuesService } = setup(
            {
                unitEvents: [[{ unitId: 'u1', state: 'done', findings: 1 }, [finding]]],
                result: finishedResult({
                finished: false,
                    progress: [
                        { unitId: 'u1', state: 'done', findings: 0 },
                        { unitId: 'u2', state: 'pending', findings: 0 },
                    ],
                }),
            },
            scanRecord({ reported: [earlier] }),
        );

        await processor.process('job-1');

        // The next job dedups against what this one and the ones before it reported.
        const engine = (SecurityScanEngine as unknown as jest.Mock).mock.results.at(-1)!.value;
        expect(engine.run.mock.calls[0][0].reported).toEqual([earlier]);
        // Each unit appends what it reported, in the same write as its progress.
        const unitUpdate = scans.recordUnit.mock.calls[0] as any;
        expect(unitUpdate[1]).toEqual({ unitId: 'u1', state: 'done', findings: 1 });
        expect(unitUpdate[3]).toEqual([
            expect.objectContaining({
                // The issue it was stored as, for a scan that carries it on.
                fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
                filePath: finding.filePath,
                startLine: finding.startLine,
                vulnerabilityClass: finding.vulnerabilityClass,
            }),
        ]);

        expect(jobQueue.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                workflowType: WorkflowType.SECURITY_SCAN,
                payload: expect.objectContaining({ scanId: 'scan-1' }),
            }),
        );
        // Nothing is resolved until the whole scan has run.
        expect(issuesService.resolveUnseenScanFindings).not.toHaveBeenCalled();
        // Waiting for the next worker: queued, so the wait is not read as a
        // stopped worker.
        expect(lastUpdate(scans).status).toBe(SecurityScanStatus.QUEUED);
    });

    it('does nothing for a scan that already finished', async () => {
        const { processor, scans } = setup(
            { result: finishedResult() },
            scanRecord({ status: SecurityScanStatus.COMPLETED }),
        );

        await processor.process('job-1');

        expect(scans.update).not.toHaveBeenCalled();
    });

    it('reads the commit the first slice read when it continues a scan', async () => {
        const { processor, leaseManager } = setup(
            { result: finishedResult() },
            scanRecord({ commitSha: 'first-sha' }),
        );

        await processor.process('job-1');

        const [, , , cloneParams] = leaseManager.acquire.mock.calls[0] as unknown as any[];
        expect(cloneParams.checkoutSha).toBe('first-sha');
    });

    it('maps the repository again when the branch moved past an inherited plan', async () => {
        const { processor, scans } = setup(
            { result: finishedResult() },
            scanRecord({
                planCommitSha: 'old-sha',
                units: [{ id: 'u1' }],
                progress: [{ unitId: 'u1', state: 'done', findings: 0 }],
            }),
        );

        await processor.process('job-1');

        const engine = (SecurityScanEngine as unknown as jest.Mock).mock.results.at(-1)!.value;
        expect(engine.run.mock.calls[0][0]).toEqual(
            expect.objectContaining({ units: [], progress: [] }),
        );
        expect(scans.update).toHaveBeenCalledWith('scan-1', {
            commitSha: 'abc123',
            units: [],
            progress: [],
            reported: [],
        });
    });

    it('keeps an inherited plan, and what it reported, when HEAD cannot be read', async () => {
        const reported = [{ vulnerabilityClass: 'authz', filePath: 'src/a.ts', fingerprint: 'fp-a' }];
        const { processor, scans, sandbox } = setup(
            { result: finishedResult() },
            scanRecord({ planCommitSha: 'plan-sha', units: [{ id: 'u1' }] as any, reported: reported as any }),
        );
        const run = sandbox.run.getMockImplementation() as any;
        (sandbox.run as jest.Mock).mockImplementation(async (command: string) =>
            command.includes('rev-parse HEAD') ? { stdout: '', exitCode: 128 } : run(command),
        );

        await processor.process('job-1');

        const engine = (SecurityScanEngine as unknown as jest.Mock).mock.results.at(-1)!.value;
        expect(engine.run.mock.calls[0][0]).toEqual(
            expect.objectContaining({ units: [{ id: 'u1' }], reported }),
        );
        // The wipe a moved branch writes never happens.
        expect(scans.update).not.toHaveBeenCalledWith(
            'scan-1',
            expect.objectContaining({ reported: [] }),
        );
    });

    it('keeps an inherited plan made at the commit it reads', async () => {
        const { processor } = setup(
            { result: finishedResult() },
            scanRecord({
                planCommitSha: 'abc123',
                units: [{ id: 'u1' }],
                progress: [{ unitId: 'u1', state: 'done', findings: 0 }],
            }),
        );

        await processor.process('job-1');

        const engine = (SecurityScanEngine as unknown as jest.Mock).mock.results.at(-1)!.value;
        expect(engine.run.mock.calls[0][0].units).toEqual([{ id: 'u1' }]);
    });

    it('starts a new scan at the branch tip', async () => {
        const { processor, leaseManager } = setup({ result: finishedResult() });

        await processor.process('job-1');

        const [, , , cloneParams] = leaseManager.acquire.mock.calls[0] as unknown as any[];
        expect(cloneParams.checkoutSha).toBeUndefined();
    });

    it("reads open findings on a scan's first job, carried-on plan or not, and not on its continuations", async () => {
        const unit = { id: 'u1', file: 'src/a.ts', relatedFiles: [], language: 'typescript', classes: ['authz'], priority: 50, reasons: [] };
        const carried = setup({ result: finishedResult() }, scanRecord({ units: [unit] as any }));
        await carried.processor.process('job-1');
        expect(carried.issuesService.findOpenScanFindingAreas).toHaveBeenCalledTimes(1);

        const continued = setup(
            { result: finishedResult() },
            scanRecord({ units: [unit] as any, commitSha: 'abc123' }),
        );
        await continued.processor.process('job-1');
        expect(continued.issuesService.findOpenScanFindingAreas).not.toHaveBeenCalled();
    });

    it('reads open findings on a later job that still has no plan stored', async () => {
        // The first job stored its commit, then stopped before planning.
        const { processor, issuesService } = setup(
            { result: finishedResult() },
            scanRecord({ commitSha: 'abc123' }),
        );

        await processor.process('job-1');

        expect(issuesService.findOpenScanFindingAreas).toHaveBeenCalledTimes(1);
    });

    it("stores what the plan could not hold, and keeps it on the plan's continuations", async () => {
        const planned = setup({
            result: finishedResult({ mapFailedLanguages: ['python'], filesBeyondPlan: 1 }),
        });
        await planned.processor.process('job-1');
        expect(lastUpdate(planned.scans).coverage).toEqual(
            expect.objectContaining({ mapFailedLanguages: ['python'], filesBeyondPlan: 1 }),
        );

        // A continuation does not map again: the plan's gaps carry over.
        const continued = setup(
            { result: finishedResult() },
            scanRecord({
                commitSha: 'abc123',
                units: [{ id: 'u1' }] as any,
                coverage: {
                    examinedFiles: [],
                    unitsTotal: 1,
                    unitsDone: 0,
                    unitsFailed: 0,
                    unitsSkippedByBudget: 0,
                    languages: ['python'],
                    mapFailedLanguages: ['python'],
                    filesBeyondPlan: 1,
                },
            }),
        );
        await continued.processor.process('job-1');
        expect(lastUpdate(continued.scans).coverage).toEqual(
            expect.objectContaining({ mapFailedLanguages: ['python'], filesBeyondPlan: 1 }),
        );
    });

    it("sights a carried-on finding in an area this scan did not read again, and leaves a reread one to the resolver", async () => {
        const { processor, issuesService } = setup(
            { result: finishedResult() },
            scanRecord({
                reported: [
                    // Its area was not read again: held as found.
                    { vulnerabilityClass: 'authz', title: 'IDOR', filePath: 'src/a.ts', fingerprint: 'fp-held' },
                    // Read again (authz on the controller) and not found: gone.
                    { vulnerabilityClass: 'authz', title: 'IDOR', filePath: './src/orders.controller.ts', fingerprint: 'fp-reread' },
                    // Reported before fingerprints were kept: nothing to sight.
                    { vulnerabilityClass: 'injection', title: 'SQLi', filePath: 'src/b.ts' },
                ] as any,
            }),
        );

        await processor.process('job-1');

        expect(issuesService.markScanFindingsSeen).toHaveBeenLastCalledWith({
            organizationId: 'org-1',
            repositoryPlatform: 'GITHUB',
            repositoryId: 'repo-1',
            fingerprints: ['fp-held'],
            scanId: 'scan-1',
        });
        expect(
            issuesService.markScanFindingsSeen.mock.invocationCallOrder.at(-1),
        ).toBeLessThan(issuesService.resolveUnseenScanFindings.mock.invocationCallOrder[0]);
    });

    it('sights at once an earlier finding a unit found again, reopening it if resolved since', async () => {
        const { processor, scans, issuesService } = setup({
            unitEvents: [[{ unitId: 'u1', state: 'done', findings: 0 }, [], ['fp-again']]],
            result: finishedResult({ findings: [] }),
        });
        issuesService.markScanFindingsSeen.mockResolvedValueOnce({ sighted: 0, reopened: 1 });

        await processor.process('job-1');

        expect(issuesService.markScanFindingsSeen).toHaveBeenCalledWith(
            expect.objectContaining({ fingerprints: ['fp-again'], scanId: 'scan-1', foundAgain: true }),
        );
        expect(lastUpdate(scans).outcome).toEqual(expect.objectContaining({ reopened: 1 }));
    });

    it("drops a stale plan's reports with it: of another commit, neither compared against nor sighted", async () => {
        const { processor, scans, issuesService } = setup(
            { result: finishedResult({ findings: [] }) },
            scanRecord({
                planCommitSha: 'old-sha',
                units: [{ id: 'u1' }] as any,
                reported: [
                    { vulnerabilityClass: 'authz', filePath: 'src/removed.ts', fingerprint: 'fp-old' },
                ] as any,
            }),
        );

        await processor.process('job-1');

        expect(scans.update).toHaveBeenCalledWith(
            'scan-1',
            expect.objectContaining({ units: [], progress: [], reported: [] }),
        );
        const engine = (SecurityScanEngine as unknown as jest.Mock).mock.results.at(-1)!.value;
        expect(engine.run.mock.calls[0][0].reported).toEqual([]);
        expect(
            (issuesService.markScanFindingsSeen.mock.calls as any[]).flatMap((c) => c[0].fingerprints),
        ).not.toContain('fp-old');
    });

    it("resolves with what a carried-on plan's finished areas read, and keeps it through the plan", async () => {
        const inherited = [{ vulnerabilityClass: 'injection', filePaths: ['src/done.ts'] }];
        const { processor, scans, issuesService } = setup(
            { result: finishedResult() },
            scanRecord({
                planCommitSha: 'abc123',
                units: [{ id: 'u1' }] as any,
                coverage: {
                    examinedFiles: [],
                    examinedByClass: [],
                    inheritedExaminedByClass: inherited,
                    unitsTotal: 2,
                    unitsDone: 1,
                    unitsFailed: 0,
                    unitsSkippedByBudget: 0,
                    languages: ['typescript'],
                },
            }),
        );

        await processor.process('job-1');

        expect(issuesService.resolveUnseenScanFindings).toHaveBeenCalledWith(
            expect.objectContaining({
                examined: expect.arrayContaining([
                    { vulnerabilityClass: 'injection', filePaths: ['src/done.ts'] },
                    { vulnerabilityClass: 'authz', filePaths: ['src/orders.controller.ts'] },
                ]),
            }),
        );
        expect(lastUpdate(scans).coverage.inheritedExaminedByClass).toEqual(inherited);
        // The plan's own fake onPlanned write keeps it too.
        expect(
            (scans.update.mock.calls as any[]).filter((c) => c[1]?.units && c[1]?.coverage),
        ).toEqual(
            expect.arrayContaining([
                expect.arrayContaining([
                    expect.objectContaining({
                        coverage: expect.objectContaining({ inheritedExaminedByClass: inherited }),
                    }),
                ]),
            ]),
        );
    });

    it("drops a stale plan's inherited coverage with its areas", async () => {
        const { processor, scans } = setup(
            { result: finishedResult() },
            scanRecord({
                planCommitSha: 'old-sha',
                units: [{ id: 'u1' }] as any,
                coverage: {
                    examinedFiles: [],
                    examinedByClass: [],
                    inheritedExaminedByClass: [{ vulnerabilityClass: 'authz', filePaths: ['src/a.ts'] }],
                    unitsTotal: 1,
                    unitsDone: 0,
                    unitsFailed: 0,
                    unitsSkippedByBudget: 0,
                    languages: [],
                },
            }),
        );

        await processor.process('job-1');

        expect(lastUpdate(scans).coverage.inheritedExaminedByClass).toEqual([]);
    });

    it('records each area alone, with live counts, without reading the scan back', async () => {
        const { processor, scans } = setup({
            unitEvents: [
                [{ unitId: 'u1', state: 'done', findings: 0 }, []],
                [{ unitId: 'u2', state: 'failed', findings: 0 }, []],
                [{ unitId: 'u3', state: 'done', findings: 0 }, []],
                // An area recorded again counts once, in its last state.
                [{ unitId: 'u2', state: 'done', findings: 0 }, []],
            ],
            result: finishedResult(),
        });

        await processor.process('job-1');

        // Read once to start the job; never once per area.
        expect(scans.findById).toHaveBeenCalledTimes(1);
        const writes = scans.recordUnit.mock.calls as any[];
        expect(writes.map((call) => call[1].unitId)).toEqual(['u1', 'u2', 'u3', 'u2']);
        expect(writes[2][2].coverage).toEqual(
            expect.objectContaining({ unitsDone: 2, unitsFailed: 1 }),
        );
        expect(writes[3][2].coverage).toEqual(
            expect.objectContaining({ unitsDone: 3, unitsFailed: 0 }),
        );
        expect(writes[2][2]).not.toHaveProperty('progress');
    });

    it('fails the scan, resolving nothing, when a finding cannot be stored', async () => {
        const { processor, scans, issuesService } = setup({
            unitEvents: [[{ unitId: 'u1', state: 'done', findings: 1 }, [finding]]],
            result: finishedResult(),
        });
        issuesService.upsertScanFinding.mockRejectedValue(new Error('mongo down'));

        await processor.process('job-1');

        expect(issuesService.resolveUnseenScanFindings).not.toHaveBeenCalled();
        // The unit is not recorded as done, so running the scan again retries it.
        expect(scans.recordUnit).not.toHaveBeenCalled();
        expect(lastUpdate(scans).status).toBe(SecurityScanStatus.FAILED);
    });

    it('fails, without running, a scan whose organization no longer has a model of its own', async () => {
        const { processor, scans } = setup({ result: finishedResult() });
        (resolveReviewAgentModel as jest.Mock).mockResolvedValueOnce({
            byokConfig: undefined,
            main: { role: 'main', modelName: 'managed:default' },
        });
        (SecurityScanEngine as unknown as jest.Mock).mockClear();

        await processor.process('job-1');

        expect(SecurityScanEngine).not.toHaveBeenCalled();
        expect(lastUpdate(scans)).toEqual(
            expect.objectContaining({
                status: SecurityScanStatus.FAILED,
                error: SCAN_NEEDS_BYOK_MESSAGE,
            }),
        );
    });

    it('fails, instead of completing, a scan whose every area failed', async () => {
        const { processor, scans, issuesService } = setup({
            result: finishedResult({
                progress: [
                    { unitId: 'u1', state: 'failed', findings: 0, error: 'every lens failed' },
                ],
                findings: [],
                examinedFiles: [],
                examinedByClass: [],
            }),
        });

        await processor.process('job-1');

        expect(issuesService.resolveUnseenScanFindings).not.toHaveBeenCalled();
        expect(lastUpdate(scans)).toEqual(
            expect.objectContaining({
                status: SecurityScanStatus.FAILED,
                error: SCAN_NO_AREA_EXAMINED_MESSAGE,
            }),
        );
    });

    it('records a failure on the scan, without the internal error', async () => {
        const { processor, scans } = setup({ result: finishedResult() });
        (SecurityScanEngine as unknown as jest.Mock).mockImplementation(() => ({
            run: jest.fn(async () => {
                throw new Error('clone of https://x-access-token:ghs_abc@github.com/acme/shop failed');
            }),
        }));

        await processor.process('job-1');

        expect(lastUpdate(scans)).toEqual(
            expect.objectContaining({
                status: SecurityScanStatus.FAILED,
                error: expect.stringMatching(/internal error/),
            }),
        );
        expect(lastUpdate(scans).error).not.toMatch(/github|ghs_/);
    });

    it('fails a USD-capped scan whose model has lost its price, instead of running it uncapped', async () => {
        const { processor, scans, pricingResolver } = setup({ result: finishedResult() });
        pricingResolver.resolve.mockResolvedValue({ priced: false } as any);
        (SecurityScanEngine as unknown as jest.Mock).mockClear();

        await processor.process('job-1');

        expect(SecurityScanEngine).not.toHaveBeenCalled();
        expect(lastUpdate(scans)).toEqual(
            expect.objectContaining({
                status: SecurityScanStatus.FAILED,
                error: expect.stringMatching(/no known price/),
            }),
        );
    });
});

describe('buildIssueDescription', () => {
    it('keeps the explanation, the fix and where it was found, not the evidence', () => {
        const text = buildIssueDescription(
            {
                ...(finding as any),
                suggestedFix: 'Scope the query by the caller.',
                reproduction: { path: 'a.spec.ts', content: 'test()', command: 'x', executed: false },
            },
            'abcdef1234567890',
        );
        expect(text).toContain('The id from the path loads any order.');
        expect(text).toContain('**Fix**\nScope the query by the caller.');
        expect(text).toContain('CWE-639 · found at abcdef123456');
        expect(text).not.toContain('Attack path');
        expect(text).not.toContain('test()');
    });
});

describe('scanErrorMessage', () => {
    it('keeps a message written for the user', () => {
        expect(scanErrorMessage(new ScanFailure('Set a spend limit.'))).toBe(
            'Set a spend limit.',
        );
    });

    it("quotes the model provider's answer, redacted", () => {
        const error = Object.assign(new Error('Bad request'), {
            responseBody: JSON.stringify({
                error: { message: 'Invalid key sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
            }),
        });
        const message = scanErrorMessage(error);
        expect(message).toMatch(/^The model provider refused a request: Invalid key/);
        expect(message).not.toMatch(/abcdefghijklmnop/);
    });

    it('hides any other error', () => {
        expect(scanErrorMessage(new Error('E11000 duplicate key one_active_scan'))).toMatch(
            /^The scan stopped on an internal error/,
        );
    });
});
