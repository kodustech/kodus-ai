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

function useCaseWith(last: Record<string, unknown> | null) {
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
                { id: 'repo-1', name: 'shop', full_name: 'acme/shop' },
            ]),
        } as any,
        {} as any,
        { getTypeIntegration: jest.fn(async () => 'GITHUB') } as any,
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
        reported: [{ title: 'IDOR', filePath: 'src/a.ts' }],
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
        // What the earlier scan reported was its sighting, not this one's: a
        // unit that finds it again stores it, which keeps the issue open.
        expect(created.reported).toBeUndefined();
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
