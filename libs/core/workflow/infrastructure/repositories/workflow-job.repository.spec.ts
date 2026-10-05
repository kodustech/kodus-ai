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

    it('returns an empty array when nothing is stale', async () => {
        const result = await repo.failStaleProcessing({
            olderThan,
            lastError,
            errorClassification: ErrorClassification.PERMANENT,
        });

        expect(result).toEqual([]);
    });
});

describe('WorkflowJobRepository — lease-based stale-job reclaim (#1830)', () => {
    let qb: {
        update: jest.Mock;
        set: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        returning: jest.Mock;
        execute: jest.Mock;
        select: jest.Mock;
        from: jest.Mock;
        getRawMany: jest.Mock;
        whereInIds: jest.Mock;
    };
    let repository: { createQueryBuilder: jest.Mock };
    let repo: WorkflowJobRepository;

    const now = new Date('2026-07-01T00:00:00Z');
    const olderThan = new Date('2026-06-30T00:00:00Z');

    beforeEach(() => {
        qb = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            returning: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ raw: [], affected: 0 }),
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            getRawMany: jest.fn().mockResolvedValue([]),
            whereInIds: jest.fn().mockReturnThis(),
        };
        repository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        repo = new WorkflowJobRepository(repository as any);
    });

    it('selects PROCESSING rows with an expired lease OR (no lease + old age)', async () => {
        const stale = [{ uuid: 'job-expired', workflowType: 'CODE_REVIEW' }];
        qb.getRawMany.mockResolvedValue(stale);

        const result = await repo.findStaleProcessing({ now, olderThan });

        expect(result).toEqual(stale);
        expect(qb.where).toHaveBeenCalledWith('job.status = :status', {
            status: JobStatus.PROCESSING,
        });
        expect(qb.andWhere).toHaveBeenCalledWith(
            expect.stringContaining('leaseExpiresAt'),
            { now, olderThan },
        );
        // A live job (renewed, unexpired lease) must never be matched.
        expect(qb.andWhere.mock.calls[0][0]).not.toContain(
            'leaseExpiresAt > :now',
        );
    });

    it('requeues a stale job to PENDING and increments retryCount, clearing the lease', async () => {
        qb.execute.mockResolvedValue({
            raw: [{ uuid: 'job-1' }],
            affected: 1,
        });
        const requeued = await repo.requeueStaleJobs({
            uuids: ['job-1'],
            lastError: 'lease expired',
            requeuedBy: 'reaper',
        });

        // Returns the UUID of the row actually flipped (Postgres RETURNING),
        // so the watchdog republishes only what it truly requeued (#1902).
        expect(requeued).toEqual(['job-1']);
        expect(qb.update).toHaveBeenCalledWith(WorkflowJobModel);
        const setArgs = qb.set.mock.calls[0][0];
        expect(setArgs.status).toBe(JobStatus.PENDING);
        expect(setArgs.leaseOwner).toBeNull();
        expect(setArgs.leaseExpiresAt).toBeNull();
        expect(qb.whereInIds).toHaveBeenCalledWith(['job-1']);
        // Re-assert PROCESSING in the UPDATE so a job that completed between
        // the SELECT and this write is not clobbered back to PENDING.
        expect(qb.andWhere).toHaveBeenCalledWith('status = :status', {
            status: JobStatus.PROCESSING,
        });
        expect(qb.returning).toHaveBeenCalledWith('uuid');
    });

    it('requeue is a no-op for an empty uuid list', async () => {
        const requeued = await repo.requeueStaleJobs({
            uuids: [],
            lastError: 'x',
            requeuedBy: 'reaper',
        });
        expect(requeued).toEqual([]);
        expect(qb.execute).not.toHaveBeenCalled();
    });

    it('permanently fails a stale job whose retry budget is exhausted', async () => {
        qb.execute.mockResolvedValue({ affected: 1 });
        const count = await repo.failStaleJobs({
            uuids: ['job-dead'],
            lastError: 'retry budget exhausted',
            errorClassification: ErrorClassification.PERMANENT,
        });

        expect(count).toBe(1);
        expect(qb.set).toHaveBeenCalledWith(
            expect.objectContaining({
                status: JobStatus.FAILED,
                errorClassification: ErrorClassification.PERMANENT,
                leaseOwner: null,
                leaseExpiresAt: null,
            }),
        );
        expect(qb.whereInIds).toHaveBeenCalledWith(['job-dead']);
        // Only a still-PROCESSING row may be terminally failed.
        expect(qb.andWhere).toHaveBeenCalledWith('status = :status', {
            status: JobStatus.PROCESSING,
        });
    });

    it('wraps the lease disjunction in its own parens so the status guard covers both branches', async () => {
        await repo.findStaleProcessing({ now, olderThan });

        const predicate = qb.andWhere.mock.calls[0][0] as string;
        // Without the outer pair, SQL precedence parses
        // `status = PROCESSING AND lease-expired OR legacy` and the legacy
        // branch escapes the status guard entirely.
        expect(predicate.startsWith('((')).toBe(true);
        expect(predicate.trim().endsWith('))')).toBe(true);
    });

    it('quotes + alias-qualifies every selected column (no unquoted mixed-case)', async () => {
        await repo.findStaleProcessing({ now, olderThan });

        expect(qb.select).toHaveBeenCalledWith([
            'job."uuid"',
            'job."workflowType"',
            'job."organizationId"',
            'job."startedAt"',
            'job."leaseExpiresAt"',
            'job."retryCount"',
            'job."maxRetries"',
        ]);
    });

    // The no-live-owner guard is what a run that never claimed a lease writes
    // through (the payload check, the rate-limit gate). Its predicate runs as
    // raw SQL, so the mixed-case column has to be quoted or PostgreSQL folds it
    // to `leaseexpiresat` and the whole UPDATE fails — and a throw here escapes
    // into the caller's catch, which stamps the very FAILED over a live worker's
    // row this guard exists to withhold (#1902 review).
    it('fences the no-live-owner write on a quoted, mixed-case-safe predicate', async () => {
        qb.execute.mockResolvedValue({ raw: [], affected: 0 });

        const landed = await repo.update(
            'job-1',
            { status: JobStatus.FAILED },
            { noLiveOwner: true },
        );

        const predicate = qb.andWhere.mock.calls[0][0] as string;
        expect(predicate).toContain('"leaseExpiresAt"');
        expect(predicate).not.toMatch(/[^"]leaseExpiresAt/);
        expect(predicate).toContain('status <> :processing');
        expect(qb.andWhere.mock.calls[0][1]).toEqual({
            processing: JobStatus.PROCESSING,
            now: expect.any(Date),
        });
        // No row matched, i.e. a live worker owns the job.
        expect(landed).toBe(false);
    });

    it('reports the no-live-owner write as landed when the row was free', async () => {
        qb.execute.mockResolvedValue({ raw: [], affected: 1 });

        await expect(
            repo.update(
                'job-1',
                { status: JobStatus.FAILED },
                { noLiveOwner: true },
            ),
        ).resolves.toBe(true);
    });
});
