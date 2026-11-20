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
});

describe('WorkflowJobRepository.failIfProcessing', () => {
    let qb: {
        update: jest.Mock;
        set: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        execute: jest.Mock;
    };
    let repository: { createQueryBuilder: jest.Mock };
    let repo: WorkflowJobRepository;

    beforeEach(() => {
        qb = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        repository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        repo = new WorkflowJobRepository(repository as any);
    });

    it('flips only the named PROCESSING row to FAILED', async () => {
        const flipped = await repo.failIfProcessing('job-1', {
            lastError: 'unrecorded child exit',
            errorClassification: ErrorClassification.PERMANENT,
        });

        expect(flipped).toBe(true);
        expect(qb.where).toHaveBeenCalledWith('uuid = :id', { id: 'job-1' });
        expect(qb.andWhere).toHaveBeenCalledWith('status = :status', {
            status: JobStatus.PROCESSING,
        });
        expect(qb.set).toHaveBeenCalledWith(
            expect.objectContaining({
                status: JobStatus.FAILED,
                lastError: 'unrecorded child exit',
            }),
        );
    });

    it('returns false when the row is already terminal', async () => {
        qb.execute.mockResolvedValue({ affected: 0 });
        await expect(
            repo.failIfProcessing('job-1', {
                lastError: 'unrecorded child exit',
                errorClassification: ErrorClassification.PERMANENT,
            }),
        ).resolves.toBe(false);
    });
});

describe('WorkflowJobRepository.cancelActiveByCorrelation', () => {
    let qb: {
        update: jest.Mock;
        set: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        execute: jest.Mock;
    };
    let repo: WorkflowJobRepository;

    beforeEach(() => {
        qb = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 2 }),
        };
        repo = new WorkflowJobRepository({
            createQueryBuilder: jest.fn().mockReturnValue(qb),
        } as any);
    });

    it('cancels only PENDING and PROCESSING jobs of that run', async () => {
        const affected = await repo.cancelActiveByCorrelation({
            correlationId: 'scan-1',
            workflowType: 'SECURITY_SCAN',
        });

        expect(affected).toBe(2);
        expect(qb.update).toHaveBeenCalledWith(WorkflowJobModel);
        expect(qb.set).toHaveBeenCalledWith(
            expect.objectContaining({ status: JobStatus.CANCELLED }),
        );
        expect(qb.where).toHaveBeenCalledWith(
            '"correlationId" = :correlationId',
            { correlationId: 'scan-1' },
        );
        expect(qb.andWhere).toHaveBeenCalledWith(
            '"workflowType" = :workflowType',
            { workflowType: 'SECURITY_SCAN' },
        );
        expect(qb.andWhere).toHaveBeenCalledWith('status IN (:...statuses)', {
            statuses: [JobStatus.PENDING, JobStatus.PROCESSING],
        });
    });
});

describe('WorkflowJobRepository.countReapedSince', () => {
    it('bounds the window on the DB clock and on the indexed updatedAt', async () => {
        const qb = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getCount: jest.fn().mockResolvedValue(7),
        };
        const repo = new WorkflowJobRepository({
            createQueryBuilder: jest.fn().mockReturnValue(qb),
        } as any);

        await expect(repo.countReapedSince(60, 'Orphaned:')).resolves.toBe(7);

        const clauses = qb.andWhere.mock.calls.map(([sql]) => String(sql));
        // No JS Date reaches the SQL: the cut-off is NOW() on the DB, the
        // clock that stamped completedAt, whatever the process time zone.
        for (const [, params] of qb.andWhere.mock.calls) {
            for (const v of Object.values(params ?? {}))
                expect(v).not.toBeInstanceOf(Date);
        }
        expect(clauses).toContain(
            'job."updatedAt" >= NOW() - make_interval(mins => :windowMinutes)',
        );
        expect(clauses).toContain(
            'job."completedAt" >= NOW() - make_interval(mins => :windowMinutes)',
        );
        expect(qb.where).toHaveBeenCalledWith('job.status = :status', {
            status: JobStatus.FAILED,
        });
    });
});
