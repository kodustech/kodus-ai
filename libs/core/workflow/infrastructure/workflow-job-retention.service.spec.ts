import {
    WORKFLOW_JOB_RETENTION_BATCH_SIZE as FULL,
    WorkflowJobRetentionService,
} from './workflow-job-retention.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('WorkflowJobRetentionService.run', () => {
    const serviceDeleting = (batches: number[]) => {
        let batch = 0;
        const deleteFinishedOlderThan = jest.fn(async () => {
            batch += 1;
            return {
                deleted: batches.shift() ?? 0,
                lastUpdatedAt: `2026-01-01 00:00:0${batch}`,
            };
        });
        const service = new WorkflowJobRetentionService(
            { deleteFinishedOlderThan } as any,
            {} as any,
        );
        return Object.assign(service, { deleteFinishedOlderThan });
    };

    it('keeps deleting until a batch comes back short, because nothing older is left', async () => {
        const service = serviceDeleting([FULL, FULL, 12]);

        await expect(
            service.run({
                olderThan: new Date(),
                budgetMs: 60_000,
                pauseMs: 0,
                sleep: async () => undefined,
            }),
        ).resolves.toEqual({
            deleted: FULL * 2 + 12,
            batches: 3,
            finished: true,
        });
    });

    it('stops at its time budget and leaves the backlog for the next run', async () => {
        const service = serviceDeleting([FULL, FULL, FULL, FULL]);
        let clock = 0;

        await expect(
            service.run({
                olderThan: new Date(),
                budgetMs: 1_000,
                pauseMs: 600,
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                },
            }),
        ).resolves.toEqual({ deleted: FULL * 2, batches: 2, finished: false });
    });

    it('starts each batch where the previous one stopped, not from the oldest row again', async () => {
        const service = serviceDeleting([FULL, FULL, 0]);

        await service.run({
            olderThan: new Date(),
            budgetMs: 60_000,
            pauseMs: 0,
            sleep: async () => undefined,
        });

        const resumedFrom = service.deleteFinishedOlderThan.mock.calls.map(
            ([params]: any) => params.after,
        );
        expect(resumedFrom).toEqual([
            undefined,
            '2026-01-01 00:00:01',
            '2026-01-01 00:00:02',
        ]);
    });
});
