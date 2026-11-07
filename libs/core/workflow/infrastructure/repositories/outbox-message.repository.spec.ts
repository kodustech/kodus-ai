import { OutboxMessage } from '../../domain/interfaces/outbox-message.interface';
import { OutboxMessageRepository } from './outbox-message.repository';
import {
    OutboxMessageModel,
    OutboxStatus,
} from './schemas/outbox-message.model';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: jest.fn().mockReturnValue({
        log: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

describe('OutboxMessageRepository.createMany', () => {
    let repository: {
        create: jest.Mock;
        save: jest.Mock;
        update: jest.Mock;
    };
    let transactionRepository: {
        create: jest.Mock;
        save: jest.Mock;
        update: jest.Mock;
    };
    let transactionManager: { getRepository: jest.Mock };
    let repo: OutboxMessageRepository;

    const at = new Date('2026-10-31T00:00:00Z');

    const message = (uuid: string, workflowType: string): OutboxMessage => ({
        jobId: uuid,
        exchange: 'workflow.exchange',
        routingKey: `workflow.jobs.resumed.${workflowType}`,
        payload: {
            event_name: 'workflow.jobs.resumed',
            event_version: 1,
            occurred_on: at,
            payload: { jobId: uuid, workflowType },
        },
        nextAttemptAt: at,
    });

    beforeEach(() => {
        const make = () => ({
            // `create` only maps the plain object; `save` is what writes.
            create: jest.fn((value: unknown) => value),
            save: jest.fn(async (rows: unknown) => rows),
            update: jest.fn(),
        });

        repository = make();
        transactionRepository = make();
        transactionManager = {
            getRepository: jest.fn().mockReturnValue(transactionRepository),
        };
        repo = new OutboxMessageRepository(repository as any);
    });

    it('writes the whole batch with one save and no per-row follow-up update', async () => {
        const rows = (await repo.createMany([
            message('job-a', 'CODE_REVIEW'),
            message('job-b', 'CHECK_IMPLEMENTATION'),
        ])) as unknown as OutboxMessageModel[];

        // One write for the batch: `create` used to save and then update each
        // row to stamp the envelope with the uuid it had just been given.
        expect(repository.save).toHaveBeenCalledTimes(1);
        expect(repository.save.mock.calls[0][0]).toHaveLength(2);
        expect(repository.update).not.toHaveBeenCalled();

        // The message id is the row uuid, which is what the single-row path
        // ends up storing, and it is known before the insert here.
        const uuids = rows.map((row) => row.uuid);
        expect(uuids[0]).toBeTruthy();
        expect(uuids[0]).not.toEqual(uuids[1]);
        for (const [index, row] of rows.entries()) {
            expect(row.payload.messageId).toBe(row.uuid);
            expect(row.status).toBe(OutboxStatus.READY);
            expect(row.exchange).toBe('workflow.exchange');
            expect(row.nextAttemptAt).toBe(at);
            expect(row.job).toEqual({
                uuid: index === 0 ? 'job-a' : 'job-b',
            });
        }

        // The job-specific envelope is kept as the reaper built it.
        expect(rows[0].routingKey).toBe('workflow.jobs.resumed.CODE_REVIEW');
        expect((rows[0].payload as any).payload.workflowType).toBe(
            'CODE_REVIEW',
        );
    });

    it('keeps an explicit uuid when the message carries one', async () => {
        const rows = (await repo.createMany([
            { ...message('job-a', 'CODE_REVIEW'), uuid: 'sticky-uuid' },
        ])) as unknown as OutboxMessageModel[];

        expect(rows[0].uuid).toBe('sticky-uuid');
        expect(rows[0].payload.messageId).toBe('sticky-uuid');
    });

    it('writes on the requeue transaction when one is passed', async () => {
        await repo.createMany(
            [message('job-a', 'CODE_REVIEW')],
            transactionManager as any,
        );

        // The rows have to commit with the requeue, not on their own
        // connection.
        expect(transactionManager.getRepository).toHaveBeenCalledTimes(1);
        expect(transactionRepository.save).toHaveBeenCalledTimes(1);
        expect(repository.save).not.toHaveBeenCalled();
        expect(transactionRepository.update).not.toHaveBeenCalled();
    });

    it('writes nothing for an empty batch', async () => {
        await expect(repo.createMany([])).resolves.toEqual([]);

        expect(repository.create).not.toHaveBeenCalled();
        expect(repository.save).not.toHaveBeenCalled();
    });

    it('propagates a rejection so the caller can roll the requeue back', async () => {
        repository.save.mockRejectedValueOnce(new Error('outbox is down'));

        await expect(
            repo.createMany([message('job-a', 'CODE_REVIEW')]),
        ).rejects.toThrow('outbox is down');
    });
});
