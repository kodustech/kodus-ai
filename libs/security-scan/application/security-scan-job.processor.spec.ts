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
    SecurityScanJobProcessor,
    buildIssueDescription,
} from './security-scan-job.processor';
import { SecurityScanStatus } from '../domain/security-scan.types';
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
    };
    const kodyIssuesManagement = { clearIssuesCache: jest.fn(async () => undefined) };

    (SecurityScanEngine as unknown as jest.Mock).mockImplementation(() => ({
        run: jest.fn(async (params: any) => {
            await params.onPlanned?.([], ['typescript']);
            for (const [progress, findings] of engineResult.unitEvents ?? []) {
                await params.onUnitDone(progress, findings);
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

    return { processor, scans, jobQueue, issuesService, sandbox, kodyIssuesManagement, leaseManager };
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
                symbol: 'OrdersController.findOne',
            }),
        );
        expect(issuesService.resolveUnseenScanFindings).toHaveBeenCalledWith({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            scanId: 'scan-1',
            filePaths: ['src/orders.controller.ts'],
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
                progress: [{ unitId: 'u1', state: 'skipped_budget', findings: 0 }],
            }),
        });

        await processor.process('job-1');

        expect(issuesService.resolveUnseenScanFindings).toHaveBeenCalledWith(
            expect.objectContaining({ filePaths: [] }),
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
        const unitUpdate = scans.update.mock.calls.find(
            ([, changes]: any) => changes.reported,
        ) as any;
        expect(unitUpdate[1].reported).toEqual([
            earlier,
            expect.objectContaining({
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
        expect(lastUpdate(scans).status).toBeUndefined();
    });

    it('does nothing for a scan that already finished', async () => {
        const { processor, scans } = setup(
            { result: finishedResult() },
            scanRecord({ status: SecurityScanStatus.COMPLETED }),
        );

        await processor.process('job-1');

        expect(scans.update).not.toHaveBeenCalled();
    });

    it('records a failure on the scan', async () => {
        const { processor, scans } = setup({ result: finishedResult() });
        (SecurityScanEngine as unknown as jest.Mock).mockImplementation(() => ({
            run: jest.fn(async () => {
                throw new Error('sandbox died');
            }),
        }));

        await processor.process('job-1');

        expect(lastUpdate(scans)).toEqual(
            expect.objectContaining({
                status: SecurityScanStatus.FAILED,
                error: 'sandbox died',
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
