import { randomUUID } from 'crypto';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { shopRunRequest } from '../../../../apps/runtime/src/e2e/fixtures';
import { InMemoryPrAdmissionStore } from '../../../../apps/runtime/src/shared/admission/testing';
import { InMemoryDistributedLocks } from '../../../../apps/runtime/src/shared/persistence/testing';
import { RunRequestedHandler } from '../../../../apps/runtime/src/worker/commands/run-requested.handler';
import { RuntimeRunAccessService } from '../application/run-access.service';
import { GetRuntimeRunUseCase } from '../application/use-cases/get-run.use-case';
import { toRunSummary } from '../application/use-cases/list-runs.use-case';
import { realAuthorization, run, storeWith, user } from './fixtures';

// The Runs list reads each Run as its pull request's title: the
// runtime-worker keeps one clean line of the request's title, at most 256
// characters, on the Run, and the API serves it as `prTitle`. Runs recorded
// before have none and are never backfilled.

describe('the runtime-worker records the PR title on the Run', () => {
    const externalRequest = () => {
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
                            spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'GET', path: '/orders', timeoutMs: 1000 },
                        },
                    },
                ],
            },
        });
    };

    const record = async (kind: 'queued' | 'external-stopped' | 'obsolete', title: string | undefined) => {
        const initial = kind === 'external-stopped' ? externalRequest() : shopRunRequest();
        const req = { ...initial, pullRequest: { ...initial.pullRequest, ...(title === undefined ? {} : { title }) } };
        const projection = new InMemoryRunProjectionStore();
        const admissions = new InMemoryPrAdmissionStore();
        if (kind === 'obsolete') jest.spyOn(admissions, 'register').mockResolvedValue({ accepted: false, reason: 'superseded' });
        const handler = new RunRequestedHandler(
            { start: jest.fn(), stop: jest.fn() } as any,
            projection,
            { isStopped: async () => kind === 'external-stopped' } as any,
            new InMemoryDistributedLocks(),
            admissions,
        );
        expect(await handler.handle(req)).toBeUndefined();
        return projection.get(req.runId, { organizationId: req.organizationId });
    };

    it.each(['queued', 'external-stopped', 'obsolete'] as const)('keeps one clean line of it in the %s projection', async (kind) => {
        const got = await record(kind, `  fix(orders):\n coupon\u0000 total \u202Eslipped  ${'x'.repeat(900)}`);
        expect(got?.prTitle).toBe(`fix(orders): coupon total slipped ${'x'.repeat(256 - 'fix(orders): coupon total slipped '.length)}`);
        expect(Array.from(got!.prTitle!)).toHaveLength(256);
    });

    it.each([undefined, '', ' \n\t '])('records none for a request without a title to show (%j)', async (title) => {
        expect(await record('queued', title)).not.toHaveProperty('prTitle');
    });
});

describe('the API serves the recorded title as prTitle', () => {
    it.each(['fix(orders): coupon total', undefined])('in the Runs list row and the Run detail, absent on older Runs (%j)', async (prTitle) => {
        const recorded = run({ ...(prTitle === undefined ? {} : { prTitle }) });
        const access = new RuntimeRunAccessService(await storeWith(recorded), realAuthorization());
        const costs = { forRuns: async () => new Map() } as any;
        const detail = await new GetRuntimeRunUseCase(access, costs).execute({
            principal: { kind: 'user', user: user(Role.OWNER) as any },
            runId: recorded.runId,
        });
        for (const view of [detail, toRunSummary(recorded)]) {
            if (prTitle === undefined) expect(view).not.toHaveProperty('prTitle');
            else expect(view).toHaveProperty('prTitle', prTitle);
        }
    });
});
