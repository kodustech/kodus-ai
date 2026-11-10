import { randomUUID } from 'crypto';

import { FakeEnvironmentRuntime } from '@libs/runtime/environment';
import type { Probe } from '@libs/runtime/probe';
import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { inMemoryRunDeps } from './in-memory-deps';
import { runRuntimeRun } from './run-orchestrator';

const id = randomUUID();
const request = (probePatch: Partial<Probe> = {}) =>
    shopRunRequest({
        trigger: 'external_finding',
        externalVerification: {
            taskId: randomUUID(),
            source: { name: 'external-fixture' },
            findings: [
                {
                    findingId: id,
                    probe: {
                        id,
                        origin: 'external',
                        purpose: 'empty order is refused',
                        expected: '400',
                        compare: ['lines'],
                        spec: {
                            kind: 'http',
                            target: { service: 'web', port: 3000 },
                            method: 'POST',
                            path: '/orders',
                            timeoutMs: 1000,
                        },
                        ...probePatch,
                    },
                },
            ],
        },
    } as any);

async function rig(regression = true) {
    const scenario = SCENARIOS.shop;
    const env = new FakeEnvironmentRuntime(
        {
            shop: {
                ...scenario,
                probes: {
                    [id]: {
                        base: () => ({
                            http: {
                                status: 400,
                                headers: {},
                                body: '{"error":"cart is empty"}',
                            },
                        }),
                        pr: () => ({
                            http: {
                                status: regression ? 500 : 400,
                                headers: {},
                                body: regression
                                    ? '{"error":"internal"}'
                                    : '{"error":"cart is empty"}',
                            },
                        }),
                    },
                },
            },
        },
        () => new Date(),
    );
    const h = inMemoryRunDeps({ env });
    jest.spyOn(h.deps.agent, 'plan').mockRejectedValue(
        new Error('external input must never reach the planner'),
    );
    const classify = jest.spyOn(h.deps.intent, 'classify');
    const seen: Probe[] = [];
    const runProbe = h.deps.env.probe.bind(h.deps.env);
    h.deps.env.probe = async (claim, probe, stepId) => {
        seen.push(probe);
        return runProbe(claim, probe, stepId);
    };
    return { ...h, rawEnv: env, seen, classify };
}
async function run(h: Awaited<ReturnType<typeof rig>>, req = request()) {
    await h.projection.upsert(req.runId, {
        organizationId: req.organizationId,
        teamId: req.teamId,
        repositoryId: req.repository.id,
        repositoryName: req.repository.name,
        prNumber: req.pullRequest.number,
        headSha: req.pullRequest.headSha,
        baseSha: req.pullRequest.baseSha,
        environmentId: req.environment.environmentId,
        imageId: req.environment.imageId,
        attempt: req.attempt,
        correlationId: req.correlationId,
        state: 'queued',
        requestedAt: req.requestedAt,
        trigger: req.trigger,
    });
    await runRuntimeRun(req, h.deps);
    return (await h.projection.get(req.runId))!;
}

describe('external verification uses independent replay', () => {
    it('skips planner/intent and proves the exact external probe using reset and the comparison floor', async () => {
        const h = await rig();
        const row = await run(h);
        expect(h.deps.agent.plan).not.toHaveBeenCalled();
        expect(h.classify).not.toHaveBeenCalled();
        expect(row.probes).toEqual([
            expect.objectContaining({
                probeId: id,
                verdict: 'finding',
                intent: 'uncertain',
                baseStepIds: expect.any(Array),
                prStepIds: expect.any(Array),
            }),
        ]);
        expect(row.probes![0].baseStepIds).toHaveLength(2);
        expect(row.probes![0].prStepIds).toHaveLength(2);
        expect(h.seen).toHaveLength(4);
        expect(
            h.seen.every((p) => p.id === id && p.origin === 'external'),
        ).toBe(true);
        expect(h.rawEnv.resets).toHaveLength(4);
        expect(h.published).toHaveLength(0);
        expect(await h.claims.forRun(row.runId)).toEqual([]);
    });
    it('cannot turn a submitted allegation into a finding when both independently measured sides agree', async () => {
        const h = await rig(false);
        const row = await run(h);
        expect(row.probes).toEqual([
            expect.objectContaining({ probeId: id, verdict: 'not_reproduced' }),
        ]);
        expect(h.seen).toHaveLength(3);
        expect(h.published).toHaveLength(0);
    });
    it.each([
        {
            kind: 'http',
            target: { service: 'other', port: 3000 },
            method: 'GET',
            path: '/',
            timeoutMs: 1000,
        },
        {
            kind: 'http',
            target: { service: 'web', port: 5432 },
            method: 'GET',
            path: '/',
            timeoutMs: 1000,
        },
        {
            kind: 'sql',
            target: { service: 'web', port: 3000 },
            query: 'SELECT 1',
            timeoutMs: 1000,
        },
        { kind: 'shell', command: 'true', timeoutMs: 1000 },
    ])(
        'refuses targets outside the recorded expose before any claim starts',
        async (spec) => {
            const h = await rig();
            const acquire = jest.spyOn(h.deps.env, 'acquire');
            const row = await run(h, request({ spec } as any));
            expect(row.state).toBe('skipped');
            expect(acquire).not.toHaveBeenCalled();
            expect(h.seen).toHaveLength(0);
            expect(h.published).toHaveLength(0);
        },
    );
    it('keeps reset failure inconclusive rather than fabricating an externally verified finding', async () => {
        const h = await rig();
        h.deps.env.reset = async () => ({
            code: 'transport_lost',
            stepId: randomUUID(),
        });
        const row = await run(h);
        expect(row.probes).toEqual([
            expect.objectContaining({ probeId: id, verdict: 'inconclusive' }),
        ]);
        expect(h.seen).toHaveLength(0);
        expect(h.published).toHaveLength(0);
        expect(await h.claims.forRun(row.runId)).toEqual([]);
    });
});
