import { InMemoryPrAdmissionStore } from '../../shared/pr-admission-store';
import { randomUUID } from 'crypto';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { shopRunRequest } from '../../e2e/fixtures';
import { InMemoryDistributedLocks } from '../../shared/locks';
import { RunRequestedHandler } from './run-requested.handler';

const request = () => {
    const id = randomUUID();
    return shopRunRequest({
        trigger: 'external_finding',
        externalVerification: {
            taskId: randomUUID(),
            source: { name: 'fixture' },
            findings: [
                {
                    findingId: id,
                    probe: {
                        id,
                        origin: 'external',
                        purpose: 'orders list',
                        expected: '200',
                        compare: ['status'],
                        spec: {
                            kind: 'http',
                            target: { service: 'web', port: 3000 },
                            method: 'GET',
                            path: '/orders',
                            timeoutMs: 1000,
                        },
                    },
                },
            ],
        },
    });
};

it.each(['live head', 'org stopped'])(
    'external verification admission terminalizes %s instead of disappearing',
    async (why) => {
        const req = request();
        const projection = new InMemoryRunProjectionStore();
        const old = { ...req, runId: randomUUID() };
        if (why === 'live head')
            await projection.upsert(old.runId, {
                organizationId: req.organizationId,
                repositoryId: req.repository.id,
                prNumber: req.pullRequest.number,
                headSha: req.pullRequest.headSha,
                state: 'testing',
                attempt: 1,
                requestedAt: req.requestedAt,
            });
        const engine = { start: jest.fn(), stop: jest.fn() };
        const handler = new RunRequestedHandler(
            engine as any,
            projection,
            { isStopped: async () => why === 'org stopped' } as any,
            new InMemoryDistributedLocks(), new InMemoryPrAdmissionStore(),
        );
        await handler.requested(req);
        expect(engine.start).not.toHaveBeenCalled();
        expect(engine.stop).not.toHaveBeenCalled();
        const record = await projection.get(req.runId, {
            organizationId: req.organizationId,
        });
        expect(record).toMatchObject({
            state: 'skipped',
            runId: req.runId,
            trigger: 'external_finding',
            headSha: req.pullRequest.headSha,
            teamId: req.teamId,
            repositoryId: req.repository.id,
        });
        expect(record!.finishedAt).toBeDefined();
        expect(record!.reason).toBe(
            why === 'live head'
                ? 'external_verification_head_busy'
                : 'external_verification_stopped',
        );
        if (why === 'live head')
            expect((await projection.get(old.runId))!.state).toBe('testing');
        await handler.requested(req);
        expect(engine.start).not.toHaveBeenCalled();
    },
);
