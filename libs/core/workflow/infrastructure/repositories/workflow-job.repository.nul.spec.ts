import { WorkflowJobRepository } from './workflow-job.repository';

/**
 * The sanitiser has to be WIRED, not merely written.
 *
 * `stripNulChars` is covered on its own; what this pins is that every jsonb
 * column on the way out of this repository actually passes through it. The
 * production failure was one INSERT rejecting the whole row, so a single
 * un-sanitised field is the same outage as none of them being sanitised.
 */
const NUL = '\u0000';

/**
 * Walk the structure looking for a raw NUL.
 *
 * NOT `JSON.stringify(x).includes(NUL)` — that was the first version of this
 * check and it silently passed on un-sanitised input: stringify ESCAPES the
 * character into the six literal characters `\u0000`, so the raw byte is never
 * in the output to find. The assertion looked strict and tested nothing.
 */
const findNulPath = (value: unknown, path = ''): string | null => {
    if (typeof value === 'string') {
        return value.includes(NUL) ? path || '(root)' : null;
    }
    if (value === null || typeof value !== 'object' || value instanceof Date) {
        return null;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key.includes(NUL)) return `${path}.${key} (key)`;
        const hit = findNulPath(item, `${path}.${key}`);
        if (hit) return hit;
    }
    return null;
};

const makeRepository = () => {
    const created: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];

    const typeorm = {
        create: jest.fn((model: Record<string, unknown>) => {
            created.push(model);
            return model;
        }),
        save: jest.fn(async (model: Record<string, unknown>) => ({
            ...model,
            uuid: 'job-1',
        })),
        update: jest.fn(async (_where: unknown, data: Record<string, unknown>) => {
            updated.push(data);
            return { affected: 1 };
        }),
        findOne: jest.fn(async () => null),
    };

    const repo = new WorkflowJobRepository(typeorm as never);
    const logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
    (repo as unknown as { logger: unknown }).logger = logger;

    return { repo, typeorm, created, updated, logger };
};

const dirtyJob = () => ({
    correlationId: 'corr-1',
    workflowType: 'code_review',
    handlerType: 'handler',
    status: 'pending',
    priority: 1,
    retryCount: 0,
    maxRetries: 3,
    payload: { branch: `feature/x${NUL}`, body: `## Summary${NUL}` },
    metadata: { source: `webhook${NUL}` },
    pipelineState: { stage: `validate${NUL}` },
    waitingForEvent: {
        eventType: `push${NUL}`,
        eventKey: 'k',
        timeout: 1,
        pausedAt: new Date('2026-09-03T12:00:00.000Z'),
    },
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
});

describe('WorkflowJobRepository — NUL characters never reach a jsonb column', () => {
    it('sanitises every jsonb field on create', async () => {
        const { repo, created } = makeRepository();

        await repo.create(dirtyJob() as never);

        expect(created).toHaveLength(1);
        const model = created[0];

        for (const field of [
            'payload',
            'metadata',
            'pipelineState',
            'waitingForEvent',
        ]) {
            expect(findNulPath(model[field], field)).toBeNull();
        }
    });

    it('keeps the content around the stripped character', async () => {
        const { repo, created } = makeRepository();

        await repo.create(dirtyJob() as never);

        expect(created[0].payload).toEqual({
            branch: 'feature/x',
            body: '## Summary',
        });
    });

    it('does not turn the pausedAt Date into a plain object', async () => {
        // A flattened Date reaches the column as `{}` and the resume logic
        // silently loses when the job was paused.
        const { repo, created } = makeRepository();

        await repo.create(dirtyJob() as never);

        const waiting = created[0].waitingForEvent as { pausedAt: unknown };
        expect(waiting.pausedAt).toBeInstanceOf(Date);
    });

    it('sanitises every jsonb field on update too', async () => {
        const { repo, updated } = makeRepository();

        await repo.update('job-1', {
            payload: { a: `1${NUL}` },
            metadata: { b: `2${NUL}` },
            pipelineState: { c: `3${NUL}` },
            waitingForEvent: {
                eventType: `push${NUL}`,
                eventKey: 'k',
                timeout: 1,
                pausedAt: new Date('2026-09-03T12:00:00.000Z'),
            },
        } as never);

        expect(updated).toHaveLength(1);
        expect(findNulPath(updated[0])).toBeNull();
    });

    it('says what it stripped, so the repair is not invisible', async () => {
        // Silently fixing this would hide how often it happens and which
        // producer emits it — the questions we could not answer for the two
        // hours of production that led here.
        const { repo, logger } = makeRepository();

        await repo.create(dirtyJob() as never);

        expect(logger.warn).toHaveBeenCalledTimes(1);
        const [call] = logger.warn.mock.calls[0];
        expect(call.message).toMatch(/NUL/i);
        expect(call.metadata.strippedPaths).toEqual(
            expect.arrayContaining([
                'payload.branch',
                'payload.body',
                'metadata.source',
                'pipelineState.stage',
                'waitingForEvent.eventType',
            ]),
        );
        expect(call.metadata.operation).toBe('create');
    });

    it('logs the field paths and never the values', async () => {
        // The content is customer code. A path tells us where to look; the
        // value would put their source in our log store.
        const { repo, logger } = makeRepository();

        await repo.create(dirtyJob() as never);

        const serialized = JSON.stringify(logger.warn.mock.calls[0][0]);
        expect(serialized).not.toContain('## Summary');
        expect(serialized).not.toContain('feature/x');
    });

    it('stays quiet when there was nothing to strip', async () => {
        // A warn on every clean job would bury the signal it exists to carry.
        const { repo, logger } = makeRepository();
        const clean = { ...dirtyJob(), payload: { branch: 'main' }, metadata: {}, pipelineState: {}, waitingForEvent: undefined };

        await repo.create(clean as never);

        expect(logger.warn).not.toHaveBeenCalled();
    });
});
