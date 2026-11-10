import { randomUUID } from 'crypto';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    RunBaseBranchSchema,
    RuntimeRunRequestedSchema,
} from '@libs/runtime/run/run-messages';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing/in-memory-run-projection.store';
import { shopRunRequest } from '../../../../apps/runtime/src/e2e/fixtures';
import { InMemoryDistributedLocks } from '../../../../apps/runtime/src/shared/locks';
import { InMemoryPrAdmissionStore } from '../../../../apps/runtime/src/shared/pr-admission-store';
import { RunRequestedHandler } from '../../../../apps/runtime/src/worker/commands/run-requested.handler';

import { RuntimeRunAccessService } from '../application/run-access.service';
import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { GetRuntimeRunUseCase } from '../application/use-cases/get-run.use-case';
import { toRunSummary } from '../application/use-cases/list-runs.use-case';
import type { PullRequestHead } from '../domain/ports';
import {
    BASE_SHA,
    ORG,
    REPO,
    SHA,
    TEAM,
    clock,
    config,
    realAuthorization,
    run,
    storeWith,
    user,
} from './fixtures';

it.each([
    ['release/2026', true],
    ['rélease/日本', true],
    ['feature/🚀', true],
    ['x', true],
    ['x'.repeat(1024), true],
    ['x'.repeat(1025), false],
    ['', false],
    ['\tref', false],
    ['ref\t', false],
    ['ref\r', false],
    ['ref\n', false],
    ['ref\r\n', false],
    ['ref\x7f', false],
    ['\x00ref', false],
    ['ref name', false],
] as const)(
    'preserves bounded ASCII ref metadata semantics (%j)',
    (value, allowed) => {
        expect(RunBaseBranchSchema.safeParse(value).success).toBe(allowed);
    },
);

const env = {
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
};
const builder = () =>
    new RuntimeRunRequestBuilder(
        {
            getPullRequestDiff: async () => ({ files: [], truncated: false }),
        } as any,
        { issue: async () => 'fixture-token' },
        { get: async () => ({ ...env, imageId: 'image-1', expose: [] }) },
        config(),
        clock,
    );

it.each(['release/2026', undefined])(
    'keeps verified branch metadata optional in the product Run request (%j)',
    async (baseBranch) => {
        const head: PullRequestHead = {
            headSha: SHA,
            baseSha: BASE_SHA,
            fork: false,
            ...(baseBranch === undefined ? {} : { baseBranch }),
        };
        const requested = await builder().build({
            env,
            prNumber: 7,
            head,
            trigger: 'pull_request',
        });
        if (baseBranch === undefined)
            expect(requested.pullRequest).not.toHaveProperty('baseBranch');
        else
            expect(requested.pullRequest).toHaveProperty(
                'baseBranch',
                baseBranch,
            );
        expect(RuntimeRunRequestedSchema.safeParse(requested).success).toBe(
            true,
        );
    },
);

it.each(['release/2026', undefined])(
    'exposes only recorded base metadata in public detail and summary, preserving legacy absence (%j)',
    async (baseBranch) => {
        const recorded = run({
            ...(baseBranch === undefined ? {} : { baseBranch }),
        });
        const access = new RuntimeRunAccessService(
            await storeWith(recorded),
            realAuthorization(),
        );
        const costs = { forRuns: async () => new Map() } as any;
        const detail = await new GetRuntimeRunUseCase(access, costs).execute({
            principal: { kind: 'user', user: user(Role.OWNER) as any },
            runId: recorded.runId,
        });
        const summary = toRunSummary(recorded);
        for (const view of [detail, summary]) {
            if (baseBranch === undefined)
                expect(view).not.toHaveProperty('baseBranch');
            else expect(view).toHaveProperty('baseBranch', baseBranch);
        }
        expect(recorded).not.toHaveProperty('defaultBranch');
    },
);

it.each(['', 'bad\nref', 'bad ref', 'x'.repeat(1025), null])(
    'refuses an invalid optional branch in the strict Run command (%j)',
    (baseBranch) => {
        const req = shopRunRequest();
        expect(
            RuntimeRunRequestedSchema.safeParse({
                ...req,
                pullRequest: { ...req.pullRequest, baseBranch },
            }).success,
        ).toBe(false);
    },
);

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

it.each(['queued', 'external-stopped', 'obsolete'] as const)(
    'records the admitted branch in the initial %s projection',
    async (kind) => {
        const initial =
            kind === 'external-stopped' ? externalRequest() : shopRunRequest();
        const req = {
            ...initial,
            pullRequest: { ...initial.pullRequest, baseBranch: 'release/2026' },
        };
        const projection = new InMemoryRunProjectionStore();
        const admissions = new InMemoryPrAdmissionStore();
        if (kind === 'obsolete')
            jest.spyOn(admissions, 'register').mockResolvedValue({
                accepted: false,
                reason: 'superseded',
            });
        const engine = { start: jest.fn(), stop: jest.fn() };
        const handler = new RunRequestedHandler(
            engine as any,
            projection,
            { isStopped: async () => kind === 'external-stopped' } as any,
            new InMemoryDistributedLocks(),
            admissions,
        );
        expect(await handler.handle(req)).toBeUndefined();
        const record = await projection.get(req.runId, {
            organizationId: req.organizationId,
        });
        expect(record).toMatchObject({
            baseBranch: 'release/2026',
            state:
                kind === 'queued'
                    ? 'queued'
                    : kind === 'external-stopped'
                      ? 'skipped'
                      : 'superseded',
        });
        expect(
            await projection.get(req.runId, { organizationId: 'another-org' }),
        ).toBeNull();
    },
);

it('keeps a legacy command and existing terminal projection branch-free on redelivery', async () => {
    const req = shopRunRequest();
    const projection = new InMemoryRunProjectionStore();
    const handler = new RunRequestedHandler(
        { start: jest.fn(), stop: jest.fn() } as any,
        projection,
        { isStopped: async () => false } as any,
        new InMemoryDistributedLocks(),
        new InMemoryPrAdmissionStore(),
    );
    await handler.handle(req);
    expect(
        await projection.get(req.runId, { organizationId: req.organizationId }),
    ).not.toHaveProperty('baseBranch');
    await projection.upsert(req.runId, { state: 'errored' });
    await handler.requested({
        ...req,
        pullRequest: { ...req.pullRequest, baseBranch: 'release/2026' },
    });
    expect(
        await projection.get(req.runId, { organizationId: req.organizationId }),
    ).not.toHaveProperty('baseBranch');
});
