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
    let repository: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
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
        repository = {
            createQueryBuilder: jest.fn().mockReturnValue(qb),
            findOne: jest.fn(),
        };
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
                uuid: 'job-1',
                workflowType: 'CODE_REVIEW',
                organizationId: 'org-1',
                startedAt: new Date('2026-06-26T14:00:00Z'),
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

    it('selects only the id for an idempotency lookup', async () => {
        repository.findOne.mockResolvedValue({ uuid: 'job-1' });

        const result = await repo.findIdByIdempotencyKey('delivery-1');

        expect(repository.findOne).toHaveBeenCalledWith({
            where: { idempotencyKey: 'delivery-1' },
            select: { uuid: true },
        });
        expect(result).toBe('job-1');
    });
});
