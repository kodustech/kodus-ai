import type { Repository } from 'typeorm';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

import { WorkflowJobRepository } from './workflow-job.repository';
import { WorkflowJobModel } from './schemas/workflow-job.model';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: jest.fn().mockReturnValue({
        log: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

describe('WorkflowJobRepository.failStaleProcessing', () => {
    let qb: {
        update: jest.Mock;
        set: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        returning: jest.Mock;
        execute: jest.Mock;
    };
    let repository: { createQueryBuilder: jest.Mock };
    let repo: WorkflowJobRepository;

    const olderThan = new Date('2026-07-01T00:00:00Z');
    const lastError = 'Orphaned: worker crashed while PROCESSING';

    beforeEach(() => {
        qb = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            returning: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ raw: [], affected: 0 }),
        };
        repository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        repo = new WorkflowJobRepository(repository as any);
    });

    it('flips only PROCESSING rows older than the cutoff to FAILED/PERMANENT', async () => {
        await repo.failStaleProcessing({
            olderThan,
            lastError,
            errorClassification: ErrorClassification.PERMANENT,
        });

        expect(qb.update).toHaveBeenCalledWith(WorkflowJobModel);
        expect(qb.set).toHaveBeenCalledWith(
            expect.objectContaining({
                status: JobStatus.FAILED,
                errorClassification: ErrorClassification.PERMANENT,
                lastError,
            }),
        );
        // Only PROCESSING jobs are eligible — never PENDING / WAITING_FOR_EVENT.
        expect(qb.where).toHaveBeenCalledWith('status = :status', {
            status: JobStatus.PROCESSING,
        });
        // Actively-progressing jobs bump updatedAt and must be excluded.
        expect(qb.andWhere).toHaveBeenCalledWith(
            expect.stringContaining('updatedAt'),
            { olderThan },
        );
    });

    it('returns the reaped rows for logging', async () => {
        const reaped = [
            {
                lastError: 'Submit again',
                errorClassification: ErrorClassification.PERMANENT,
            },
        ];
        qb.execute.mockResolvedValue({ raw: reaped, affected: 1 });

        const result = await repo.failStaleProcessing({
            olderThan,
            lastError,
            errorClassification: ErrorClassification.PERMANENT,
        });

        expect(result).toEqual(reaped);
    });

    it('returns an empty array when nothing is stale', async () => {
        const result = await repo.failStaleProcessing({
            olderThan,
            lastError,
            errorClassification: ErrorClassification.PERMANENT,
        });

        expect(result).toEqual([]);
    });
});

describe('WorkflowJobRepository ephemeral terminal transitions', () => {
    function createHarness(): {
        repo: WorkflowJobRepository;
        qb: {
            update: jest.Mock;
            set: jest.Mock;
            where: jest.Mock;
            andWhere: jest.Mock;
            returning: jest.Mock;
            execute: jest.Mock;
        };
    } {
        const qb = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            returning: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ raw: [], affected: 0 }),
        };
        const repository = {
            createQueryBuilder: jest.fn().mockReturnValue(qb),
        };
        return {
            repo: new WorkflowJobRepository(
                repository as unknown as Repository<WorkflowJobModel>,
            ),
            qb,
        };
    }

    it('reconciles only marked ephemeral jobs that are still non-terminal', async () => {
        const { repo, qb } = createHarness();

        await repo.failEphemeralJob('job-1', {
            lastError:
                'Review context transport failed. Submit the review again.',
            errorClassification: ErrorClassification.PERMANENT,
            terminalReason: 'consumer-rejected',
        });

        expect(qb.where).toHaveBeenCalledWith('uuid = :id', {
            id: 'job-1',
        });
        expect(qb.andWhere).toHaveBeenCalledWith('status IN (:...statuses)', {
            statuses: [JobStatus.PENDING, JobStatus.PROCESSING],
        });
        expect(qb.andWhere).toHaveBeenCalledWith(
            "metadata ->> 'ephemeralTransport' = 'true'",
        );
        expect(qb.set).toHaveBeenCalledWith(
            expect.objectContaining({
                status: JobStatus.FAILED,
                completedAt: expect.any(Function),
            }),
        );
    });

    it('reaps only stale PENDING jobs carrying the ephemeral marker', async () => {
        const { repo, qb } = createHarness();
        const olderThan = new Date('2026-09-05T00:00:00Z');

        await repo.failStaleEphemeralPending({
            olderThan,
            lastError: 'Review context expired. Submit the review again.',
            errorClassification: ErrorClassification.PERMANENT,
        });

        expect(qb.where).toHaveBeenCalledWith('status = :status', {
            status: JobStatus.PENDING,
        });
        expect(qb.andWhere).toHaveBeenCalledWith(
            "metadata ->> 'ephemeralTransport' = 'true'",
        );
        expect(qb.andWhere).toHaveBeenCalledWith('"updatedAt" < :olderThan', {
            olderThan,
        });
        expect(qb.set).toHaveBeenCalledWith(
            expect.objectContaining({
                status: JobStatus.FAILED,
                completedAt: expect.any(Function),
            }),
        );
    });
});
