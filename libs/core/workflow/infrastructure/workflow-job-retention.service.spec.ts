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
            const deleted = batches.shift() ?? 0;
            return {
                deleted,
                candidates: deleted,
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

    it('keeps scanning past a full batch whose rows were partly kept', async () => {
        // Rows updated while the DELETE waited are kept; that must not read
        // as "nothing older is left".
        const deleteFinishedOlderThan = jest
            .fn()
            .mockResolvedValueOnce({
                deleted: FULL - 3,
                candidates: FULL,
                lastUpdatedAt: 't1',
            })
            .mockResolvedValueOnce({
                deleted: 5,
                candidates: 5,
                lastUpdatedAt: 't2',
            });
        const service = new WorkflowJobRetentionService(
            { deleteFinishedOlderThan } as any,
            {} as any,
        );

        await expect(
            service.run({
                olderThan: new Date(),
                budgetMs: 60_000,
                pauseMs: 0,
                sleep: async () => undefined,
            }),
        ).resolves.toEqual({
            deleted: FULL - 3 + 5,
            batches: 2,
            finished: true,
        });
    });

    describe('when a message lands on a doomed job mid-batch', () => {
        const fkViolation = () =>
            Object.assign(new Error('violates foreign key constraint'), {
                driverError: { code: '23503' },
            });

        it('runs the same batch again instead of ending the run', async () => {
            const deleteFinishedOlderThan = jest
                .fn()
                .mockRejectedValueOnce(fkViolation())
                .mockResolvedValueOnce({
                    deleted: 7,
                    candidates: 7,
                    lastUpdatedAt: 't1',
                });
            const service = new WorkflowJobRetentionService(
                { deleteFinishedOlderThan } as any,
                {} as any,
            );

            await expect(
                service.run({
                    olderThan: new Date(),
                    budgetMs: 60_000,
                    pauseMs: 0,
                    sleep: async () => undefined,
                }),
            ).resolves.toEqual({ deleted: 7, batches: 1, finished: true });
            expect(
                deleteFinishedOlderThan.mock.calls.map(([p]: any) => p.after),
            ).toEqual([undefined, undefined]);
        });

        it('gives up on a race that keeps coming back, and on any other error', async () => {
            const racing = jest.fn().mockRejectedValue(fkViolation());
            const broken = jest.fn().mockRejectedValue(new Error('boom'));
            const run = (deleteFinishedOlderThan: jest.Mock) =>
                new WorkflowJobRetentionService(
                    { deleteFinishedOlderThan } as any,
                    {} as any,
                ).run({
                    olderThan: new Date(),
                    budgetMs: 60_000,
                    pauseMs: 0,
                    sleep: async () => undefined,
                });

            await expect(run(racing)).rejects.toThrow('foreign key');
            expect(racing).toHaveBeenCalledTimes(4);
            await expect(run(broken)).rejects.toThrow('boom');
            expect(broken).toHaveBeenCalledTimes(1);
        });
    });
});
