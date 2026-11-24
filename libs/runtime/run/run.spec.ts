import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

import { assertTransition, canTransition, checkConclusionFor, decideRunVerdict, isTerminal } from './run-state';
import { InvalidStreamOffsetError } from './run-stream';
import { FileRunStreamStore } from './adapters/file-run-stream.store';
import { InMemoryRunStreamStore } from './testing';
import {
    RuntimeRunRequestedSchema,
    publishKey,
    runtimeOutboxMessage,
    runtimeRunOutboxMessage,
    RuntimeEventName,
    RUNTIME_RUN_ROUTING_KEY,
    type RuntimeRunRequested,
} from './run-messages';
import { sealSecret } from './sealed-secret';
import { RuntimeRunReportSchema } from './run-report';

const nr = (entryPoint: string) => ({ probeId: `p-${entryPoint}`, entryPoint, verdict: 'not_reproduced' as const, reason: 'same' });

describe('Run state machine', () => {
    it('allows the §3 transitions and refuses leaving a terminal state', () => {
        expect(canTransition('queued', 'booting')).toBe(true);
        expect(canTransition('testing', 'halted')).toBe(true);
        expect(canTransition('booting', 'no_regressions')).toBe(false);
        expect(() => assertTransition('regression', 'testing')).toThrow('invalid Run transition');
        expect(isTerminal('superseded')).toBe(true);
        expect(isTerminal('testing')).toBe(false);
    });
});

describe('decideRunVerdict and checkConclusionFor', () => {
    it('success needs not_reproduced on every entry point', () => {
        const v = decideRunVerdict({ entryPoints: ['POST /orders', 'GET /cart'], probes: [nr('POST /orders'), nr('GET /cart')] });
        expect(v.verdictState).toBe('no_regressions');
        expect(checkConclusionFor('no_regressions', v)).toEqual({ conclusion: 'success', title: 'No regressions in what was tested' });
    });

    it('a pre-existing failure alone does not satisfy the not_reproduced requirement', () => {
        // §3/ADR-038: an existing failure is reported, but cannot certify the changed path.
        const v = decideRunVerdict({
            entryPoints: ['GET /cart'],
            probes: [{ probeId: 'old-cart-failure', entryPoint: 'GET /cart', verdict: 'pre_existing', reason: 'fails equally on both sides' }],
        });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.uncoveredEntryPoints).toEqual(['GET /cart']);
        expect(checkConclusionFor(v.verdictState, v).conclusion).toBe('action_required');
    });

    it('requires not_reproduced separately on each changed entry point', () => {
        const v = decideRunVerdict({
            entryPoints: ['POST /orders', 'GET /cart'],
            probes: [nr('POST /orders'), { probeId: 'old-cart-failure', entryPoint: 'GET /cart', verdict: 'pre_existing', reason: 'fails equally on both sides' }],
        });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.uncoveredEntryPoints).toEqual(['GET /cart']);
        expect(checkConclusionFor(v.verdictState, v).conclusion).toBe('action_required');
    });

    it('pre_existing does not prevent success when the same entry point also has not_reproduced', () => {
        const v = decideRunVerdict({
            entryPoints: ['GET /cart'],
            probes: [nr('GET /cart'), { probeId: 'old-cart-failure', entryPoint: 'GET /cart', verdict: 'pre_existing', reason: 'another pre-existing failure' }],
        });
        expect(v.verdictState).toBe('no_regressions');
        expect(v.uncoveredEntryPoints).toEqual([]);
        expect(checkConclusionFor(v.verdictState, v).conclusion).toBe('success');
    });

    it('an uncovered entry point is partly_tested and needs action', () => {
        const v = decideRunVerdict({ entryPoints: ['POST /orders', 'GET /cart'], probes: [nr('POST /orders')] });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.uncoveredEntryPoints).toEqual(['GET /cart']);
        expect(checkConclusionFor('partly_tested', v).conclusion).toBe('action_required');
    });

    it('regression wins over partly_tested', () => {
        const v = decideRunVerdict({
            entryPoints: ['POST /orders', 'GET /cart'],
            probes: [{ probeId: 'a', entryPoint: 'POST /orders', verdict: 'finding', reason: 'differs' }],
        });
        expect(v.verdictState).toBe('regression');
        expect(checkConclusionFor('regression', v)).toEqual({ conclusion: 'failure', title: '1 regression' });
    });

    it('an intended finding never leads to success', () => {
        const v = decideRunVerdict({
            entryPoints: ['POST /orders'],
            probes: [{ probeId: 'a', entryPoint: 'POST /orders', verdict: 'finding', intent: 'intended', reason: 'differs' }],
        });
        expect(checkConclusionFor('partly_tested', v)).toEqual({ conclusion: 'action_required', title: 'Partly tested · 1 intended change' });
    });

    it('a blocked outbound request makes the Run partly tested: the stored state, the timeline and the check all say so', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /cart'], probes: [nr('GET /cart')], blockedOutbound: 1 });
        expect(v.verdictState).toBe('partly_tested');
        expect(checkConclusionFor(v.verdictState, v)).toEqual({ conclusion: 'action_required', title: 'Partly tested · 1 blocked outbound request' });
    });

    it('a dependency change no probe tested makes the Run partly tested', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /cart'], probes: [nr('GET /cart')], dependencyChangeUntested: true });
        expect(v.verdictState).toBe('partly_tested');
        expect(checkConclusionFor(v.verdictState, v)).toEqual({ conclusion: 'action_required', title: 'Partly tested · dependency change not behavior-tested' });
    });

    it('a forced-neutral cause never touches a regression', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /cart'], probes: [{ probeId: 'a', entryPoint: 'GET /cart', verdict: 'finding', reason: 'x' }], blockedOutbound: 2, dependencyChangeUntested: true });
        expect(v.verdictState).toBe('regression');
        expect(checkConclusionFor('regression', v).conclusion).toBe('failure');
    });

    it('a no_regressions verdict that carries a forced-neutral cause is still never success', () => {
        const v = { verdictState: 'no_regressions' as const, findings: [], intendedFindings: [], forcedNeutral: ['1 blocked outbound request'] };
        expect(checkConclusionFor('no_regressions', v).conclusion).toBe('action_required');
    });

    it('a state that bears a verdict, read without its verdict, is never success and never counts zero regressions', () => {
        expect(checkConclusionFor('no_regressions').conclusion).toBe('neutral');
        expect(checkConclusionFor('partly_tested')).toEqual({ conclusion: 'action_required', title: 'Partly tested' });
        expect(checkConclusionFor('regression').conclusion).toBe('failure');
        expect(checkConclusionFor('regression').title).not.toMatch(/^0 /);
    });

    it('a verdict that disagrees with the stored state is never read as green', () => {
        const green = decideRunVerdict({ entryPoints: ['GET /cart'], probes: [nr('GET /cart')] });
        expect(green.verdictState).toBe('no_regressions');
        expect(checkConclusionFor('partly_tested', green).conclusion).toBe('action_required');
        expect(checkConclusionFor('regression', green).conclusion).toBe('failure');
    });

    it('halted keeps the computed verdict and adds the security event', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /cart'], probes: [{ probeId: 'a', entryPoint: 'GET /cart', verdict: 'finding', reason: 'x' }] });
        expect(checkConclusionFor('halted', v)).toEqual({ conclusion: 'failure', title: '1 regression · security event' });
    });

    it('a security violation the cell saw halts as a failure that needs attention, whatever the verdict', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /cart'], probes: [nr('GET /cart')] });
        expect(checkConclusionFor('halted', v, undefined, { securityViolation: true })).toEqual({
            conclusion: 'failure',
            title: 'Security violation · No regressions in what was tested',
        });
        expect(checkConclusionFor('halted', undefined, undefined, { securityViolation: true }).conclusion).toBe('failure');
    });

    it('a halted Run never ends green, even when what it tested had no regression', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /cart'], probes: [nr('GET /cart')] });
        expect(checkConclusionFor('halted', v)).toEqual({ conclusion: 'neutral', title: 'No regressions in what was tested · security event' });
    });

    it('an entry point with an inconclusive probe stays uncovered, even when another probe settled it', () => {
        const v = decideRunVerdict({
            entryPoints: ['GET /a'],
            probes: [nr('GET /a'), { probeId: 'p2', entryPoint: 'GET /a', verdict: 'inconclusive', reason: 'flaky' }],
        });
        expect(v).toMatchObject({ verdictState: 'partly_tested', uncoveredEntryPoints: ['GET /a'] });
    });

    describe('what a partly tested check concludes (owner decision of 2026-11-18)', () => {
        const intended = decideRunVerdict({ entryPoints: ['POST /orders'], probes: [{ probeId: 'a', entryPoint: 'POST /orders', verdict: 'finding', intent: 'intended', reason: 'differs' }] });
        const inconclusive = decideRunVerdict({ entryPoints: ['GET /a'], probes: [{ probeId: 'p', entryPoint: 'GET /a', verdict: 'inconclusive', reason: 'PR rounds keep disagreeing' }] });
        const shortfall = decideRunVerdict({ entryPoints: ['GET /a'], probes: [nr('GET /a')], keptChecksNotRun: 1 });

        it('something left to decide blocks a required check by default', () => {
            for (const v of [intended, inconclusive, shortfall]) expect(checkConclusionFor(v.verdictState, v).conclusion).toBe('action_required');
        });

        it("the org's neutral fallback gives today's neutral back", () => {
            for (const v of [intended, inconclusive, shortfall]) expect(checkConclusionFor(v.verdictState, v, undefined, { partlyTestedCheck: 'neutral' }).conclusion).toBe('neutral');
            expect(checkConclusionFor('partly_tested', undefined, undefined, { partlyTestedCheck: 'neutral' }).conclusion).toBe('neutral');
        });

        it('a partly tested Run with nothing to test stays neutral', () => {
            const v = decideRunVerdict({ entryPoints: [], probes: [] });
            expect(v).toMatchObject({ verdictState: 'partly_tested', nothingToTest: true });
            expect(checkConclusionFor(v.verdictState, v)).toEqual({ conclusion: 'neutral', title: 'Partly tested' });
        });

        it('a probe outside the diff or a forced cause is something to decide, not nothing to test', () => {
            const outside = decideRunVerdict({ entryPoints: [], probes: [{ ...nr('unmapped'), probeId: 'o' }] });
            const truncated = decideRunVerdict({ entryPoints: [], probes: [], diffTruncated: true });
            for (const v of [outside, truncated]) {
                expect(v.nothingToTest).toBeUndefined();
                expect(checkConclusionFor(v.verdictState, v).conclusion).toBe('action_required');
            }
        });

        it('a PR boot the egress proxy stopped needs action whatever the org chose, and is never a regression', () => {
            const v = decideRunVerdict({ entryPoints: ['GET /a'], probes: [], prEgressDenied: ['api.example.com'] });
            expect(v.verdictState).toBe('partly_tested');
            for (const partlyTestedCheck of ['action_required', 'neutral'] as const) {
                expect(checkConclusionFor(v.verdictState, v, undefined, { partlyTestedCheck })).toEqual({ conclusion: 'action_required', title: "Partly tested · the PR's machine was denied api.example.com" });
            }
            expect(checkConclusionFor('halted', v).conclusion).toBe('action_required');
        });

        it('a halted Run keeps needing action, never neutral, when its verdict needs one', () => {
            expect(checkConclusionFor('halted', intended)).toEqual({ conclusion: 'action_required', title: 'Partly tested · 1 intended change · security event' });
        });
    });

    it('a truncated diff is partly tested at best', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /a'], probes: [nr('GET /a')], diffTruncated: true });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.forcedNeutral).toContain('diff too large to test whole');
    });

    it('a Run whose two sides ran with different drawn identities is partly tested at best (S-36)', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /a'], probes: [nr('GET /a')], identityMismatch: true });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.forcedNeutral).toContain('the two sides ran with different drawn identities');
        // A finding still wins: what the two sides were sent was the same.
        const f = decideRunVerdict({ entryPoints: ['GET /a'], probes: [{ probeId: 'p1', entryPoint: 'GET /a', verdict: 'finding', intent: 'unintended', reason: 'status 500' }], identityMismatch: true });
        expect(f.verdictState).toBe('regression');
    });

    // demo-shop#4: two probes of POST /orders/preview, 404 on main (no such route), 200 and 400 on the PR.
    const newEndpoint = (probeId: string) => ({ probeId, entryPoint: 'POST /orders/preview', verdict: 'new_endpoint' as const, reason: 'main has no such route (404)' });

    it('a route the PR adds is reported as a new endpoint, not a regression', () => {
        const v = decideRunVerdict({ entryPoints: ['POST /orders/preview', 'GET /orders'], probes: [newEndpoint('preview-total'), newEndpoint('preview-empty'), nr('GET /orders')] });
        expect(v).toMatchObject({ verdictState: 'no_regressions', findings: [], uncoveredEntryPoints: [] });
        expect(v.newEndpoints.map((p) => p.probeId)).toEqual(['preview-total', 'preview-empty']);
        expect(checkConclusionFor('no_regressions', v)).toEqual({ conclusion: 'success', title: 'No regressions in what was tested · 2 new endpoints' });
    });

    it('a route the PR removes still fails as a regression', () => {
        const removed = { probeId: 'preview', entryPoint: 'POST /orders/preview', verdict: 'finding' as const, findingKind: 'behavior_change' as const, reason: 'differs' };
        const v = decideRunVerdict({ entryPoints: ['POST /orders/preview'], probes: [removed] });
        expect(checkConclusionFor(v.verdictState, v)).toEqual({ conclusion: 'failure', title: '1 regression' });
    });

    it('a new route that errors in the PR is reported as a finding on the new code', () => {
        const error = { probeId: 'preview', entryPoint: 'POST /orders/preview', verdict: 'finding' as const, findingKind: 'new_endpoint_error' as const, reason: 'answers 502' };
        const v = decideRunVerdict({ entryPoints: ['POST /orders/preview', 'GET /orders'], probes: [error, newEndpoint('preview-empty'), nr('GET /orders')] });
        expect(v.verdictState).toBe('regression');
        expect(checkConclusionFor(v.verdictState, v)).toEqual({ conclusion: 'failure', title: '1 error on a new endpoint · 1 new endpoint' });
        const both = decideRunVerdict({ entryPoints: ['POST /orders/preview', 'GET /orders'], probes: [error, { ...error, probeId: 'orders', entryPoint: 'GET /orders', findingKind: 'behavior_change' as const }] });
        expect(checkConclusionFor(both.verdictState, both).title).toBe('1 regression · 1 error on a new endpoint');
    });

    it('a new endpoint next to an undecided probe of the same route leaves it uncovered', () => {
        const v = decideRunVerdict({ entryPoints: ['POST /orders/preview'], probes: [newEndpoint('a'), { probeId: 'b', entryPoint: 'POST /orders/preview', verdict: 'inconclusive', reason: 'flaky' }] });
        expect(v).toMatchObject({ verdictState: 'partly_tested', uncoveredEntryPoints: ['POST /orders/preview'] });
        expect(checkConclusionFor('partly_tested', v).title).toBe('Partly tested · 1 new endpoint');
    });

    it('a Run waiting for approval can time out, and a boot can halt', () => {
        expect(canTransition('awaiting_approval', 'timed_out')).toBe(true);
        expect(canTransition('booting', 'halted')).toBe(true);
    });

    it('maps the non-verdict states', () => {
        expect(checkConclusionFor('awaiting_approval').conclusion).toBe('action_required');
        expect(checkConclusionFor('superseded').conclusion).toBe('cancelled');
        expect(checkConclusionFor('timed_out').conclusion).toBe('timed_out');
        expect(checkConclusionFor('errored')).toEqual({ conclusion: 'neutral', title: 'Could not finish' });
        expect(checkConclusionFor('could_not_boot', { verdictState: 'could_not_boot' })).toEqual({ conclusion: 'neutral', title: 'Could not boot' });
    });
});

describe('Runtime messages', () => {
    it('builds the outbox row without a job and with the full payload', () => {
        const msg = runtimeRunOutboxMessage(
            { organizationId: 'org-1', repositoryId: 'repo-1', prNumber: 7, reason: 'pr_closed' },
            RuntimeEventName.RunCancelRequested,
            'msg-1',
        );
        expect(msg.jobId).toBeUndefined();
        expect(msg.routingKey).toBe(RUNTIME_RUN_ROUTING_KEY);
        expect((msg.payload as any).payload.prNumber).toBe(7);
        expect(publishKey('r', 2, 'check')).toBe('r:2:check');
    });

    it('validates the payload against its own event: a cancel cannot travel as a Run request', () => {
        const cancel = { organizationId: 'org-1', repositoryId: 'repo-1', prNumber: 7, reason: 'pr_closed' as const };
        expect(() => runtimeRunOutboxMessage(cancel, RuntimeEventName.RunRequested, 'm')).toThrow();
        expect(() => runtimeRunOutboxMessage(cancel, 'runtime.publish.requested', 'm')).toThrow();
        expect(runtimeOutboxMessage(RuntimeEventName.RunCancelRequested, cancel, 'm').routingKey).toBe(RUNTIME_RUN_ROUTING_KEY);
    });

    it('refuses a Run request whose tokens are not sealed', () => {
        const runId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
        const key = Buffer.alloc(32, 7);
        const req: RuntimeRunRequested = {
            runId,
            attempt: 1,
            correlationId: 'c',
            requestedAt: '2026-10-29T12:00:00.000Z',
            organizationId: 'o',
            teamId: 't',
            repository: { id: 'r', name: 'acme/shop' },
            pullRequest: { number: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), fork: false },
            environment: { environmentId: 'e', imageId: 'i', expose: [] },
            diff: [],
            repoToken: sealSecret('ghs_x', key, runId),
            runToken: sealSecret('krt1.x.y', key, runId),
            trigger: 'pull_request',
        };
        expect(RuntimeRunRequestedSchema.safeParse(req).success).toBe(true);
        expect(RuntimeRunRequestedSchema.safeParse({ ...req, repoToken: 'ghs_plain' }).success).toBe(false);
        expect(RuntimeRunRequestedSchema.safeParse({ ...req, runToken: 'krt1.plain.sig' }).success).toBe(false);
    });

    it("carries the org's exercised-lines threshold as a whole percent from 0 to 100, and refuses anything else", () => {
        const runId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
        const key = Buffer.alloc(32, 7);
        const req: RuntimeRunRequested = {
            runId,
            attempt: 1,
            correlationId: 'c',
            requestedAt: '2026-10-29T12:00:00.000Z',
            organizationId: 'o',
            teamId: 't',
            repository: { id: 'r', name: 'acme/shop' },
            pullRequest: { number: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), fork: false },
            environment: { environmentId: 'e', imageId: 'i', expose: [] },
            diff: [],
            repoToken: sealSecret('ghs_x', key, runId),
            runToken: sealSecret('krt1.x.y', key, runId),
            trigger: 'pull_request',
        };
        for (const ok of [0, 30, 100]) {
            expect(RuntimeRunRequestedSchema.safeParse({ ...req, exercisedLinesThresholdPercent: ok }).success).toBe(true);
        }
        for (const bad of [-1, 101, 12.5, '50', null]) {
            expect(RuntimeRunRequestedSchema.safeParse({ ...req, exercisedLinesThresholdPercent: bad }).success).toBe(false);
        }
    });

    it("carries the org's intent checks switch as a boolean; absent, the worker checks intent", () => {
        const runId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
        const key = Buffer.alloc(32, 7);
        const req = {
            runId,
            attempt: 1,
            correlationId: 'c',
            requestedAt: '2026-10-29T12:00:00.000Z',
            organizationId: 'o',
            teamId: 't',
            repository: { id: 'r', name: 'acme/shop' },
            pullRequest: { number: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), fork: false },
            environment: { environmentId: 'e', imageId: 'i', expose: [] },
            diff: [],
            repoToken: sealSecret('ghs_x', key, runId),
            runToken: sealSecret('krt1.x.y', key, runId),
            trigger: 'pull_request' as const,
        };
        for (const ok of [true, false]) expect(RuntimeRunRequestedSchema.safeParse({ ...req, intentChecks: ok }).success).toBe(true);
        expect(RuntimeRunRequestedSchema.safeParse({ ...req, intentChecks: 'off' }).success).toBe(false);
    });

    it('refuses an unknown field in RuntimeRunRequested', () => {
        const r = RuntimeRunRequestedSchema.safeParse({ runId: 'x', extra: 1 });
        expect(r.success).toBe(false);
    });
});

describe.each([
    ['memory', async () => new InMemoryRunStreamStore()],
    ['file', async () => new FileRunStreamStore(await fs.mkdtemp(path.join(os.tmpdir(), 'rt-stream-')))],
])('RunStreamStore (%s)', (_name, make) => {
    it('resumes from an offset without losing or repeating events', async () => {
        const s = await make();
        for (let i = 0; i < 5; i++) await s.append('org-1', 'run-1', { type: 'phase', at: `t${i}`, data: { i } });
        const p1 = await s.read('org-1', 'run-1', undefined, 2);
        expect(p1!.events.map((e) => e.data.i)).toEqual([0, 1]);
        expect(p1!.upToDate).toBe(false);
        const p2 = await s.read('org-1', 'run-1', p1!.nextOffset);
        expect(p2!.events.map((e) => e.data.i)).toEqual([2, 3, 4]);
        expect(p2!.upToDate).toBe(true);
        const p3 = await s.read('org-1', 'run-1', p2!.nextOffset);
        expect(p3!.events).toEqual([]);
    });

    it('returns null for a missing stream and refuses forged offsets and keys', async () => {
        const s = await make();
        expect(await s.read('org-1', 'nope')).toBeNull();
        await s.append('org-1', 'run-2', { type: 'state', at: 't', data: {} });
        await expect(s.read('org-1', 'run-2', 'garbage')).rejects.toBeInstanceOf(InvalidStreamOffsetError);
        await expect(s.append('../etc', 'run-2', { type: 'state', at: 't', data: {} })).rejects.toThrow('invalid stream key');
    });
});

describe('FileRunStreamStore offsets', () => {
    it('refuses an offset in the middle of an event instead of failing on half a line', async () => {
        const s = new FileRunStreamStore(await fs.mkdtemp(path.join(os.tmpdir(), 'rt-stream-')));
        await s.append('org-1', 'run-1', { type: 'state', at: 't', data: { a: 1 } });
        await s.append('org-1', 'run-1', { type: 'state', at: 't', data: { a: 2 } });
        const mid = Buffer.from('o5').toString('base64url');
        await expect(s.read('org-1', 'run-1', mid)).rejects.toBeInstanceOf(InvalidStreamOffsetError);
    });
});

describe('nothing_to_test (planner-eval.md fix 1)', () => {
    it('comes straight from the queue, ends the Run and is a neutral check of its own', () => {
        expect(canTransition('queued', 'nothing_to_test')).toBe(true);
        expect(canTransition('testing', 'nothing_to_test')).toBe(false);
        expect(isTerminal('nothing_to_test')).toBe(true);
        expect(checkConclusionFor('nothing_to_test')).toEqual({ conclusion: 'neutral', title: 'Nothing to test at runtime' });
    });
});

describe('kept checks in the verdict (docs/runtime/kept-checks.md §6)', () => {
    const kept = (verdict: 'finding' | 'not_reproduced') => ({ probeId: 'kept:6f1c1d3e-2b7a-4c55-9a0e-3d2f4b5a6c7d', entryPoint: 'unmapped', verdict, reason: 'r', source: 'kept_check' as const, keptCheckId: '6f1c1d3e-2b7a-4c55-9a0e-3d2f4b5a6c7d' });

    it('a failing kept check is a regression like any other finding', () => {
        const v = decideRunVerdict({ entryPoints: ['POST /orders'], probes: [nr('POST /orders'), kept('finding')] });
        expect(v.verdictState).toBe('regression');
        expect(v.findings.map((f) => f.source)).toEqual(['kept_check']);
        expect(checkConclusionFor('regression', v)).toMatchObject({ conclusion: 'failure', title: '1 regression' });
    });

    it('a kept check that could not run holds a green Run at partly tested and says how many', () => {
        const v = decideRunVerdict({ entryPoints: ['POST /orders'], probes: [nr('POST /orders')], keptChecksNotRun: 2 });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.forcedNeutral).toContain('2 kept checks could not run');
        expect(checkConclusionFor(v.verdictState, v).conclusion).toBe('action_required');
    });

    it('a kept check that could not run never touches a regression', () => {
        const v = decideRunVerdict({ entryPoints: ['POST /orders'], probes: [kept('finding')], keptChecksNotRun: 1 });
        expect(v.verdictState).toBe('regression');
    });

    it('a passing kept check never settles an entry point the observer did not back', () => {
        const v = decideRunVerdict({ entryPoints: ['POST /orders'], probes: [kept('not_reproduced')] });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.uncoveredEntryPoints).toEqual(['POST /orders']);
    });
});

describe('the intent oracle in the verdict (docs/runtime/intent-oracle.md)', () => {
    const said = (failed: boolean) => [
        {
            probeId: 'intent-1',
            quote: '`charge` is what the card is charged, so it must equal `total`.',
            source: 'description',
            assertions: 1,
            held: failed ? 0 : 1,
            failures: failed ? [{ assertion: '$.charge == $.total', expected: '$.charge = $.total (320)', received: '400' }] : [],
        },
    ];
    const quote = 'POST /orders/quote';

    it('a described change settles its entry point and never fails the check', () => {
        const described = { probeId: 'order-1', entryPoint: 'GET /orders/:id', verdict: 'described_change' as const, reason: 'as described', statedIntents: said(false) };
        const v = decideRunVerdict({ entryPoints: ['GET /orders/:id'], probes: [described] });
        expect(v).toMatchObject({ verdictState: 'no_regressions', findings: [], uncoveredEntryPoints: [] });
        expect(v.describedChanges?.map((p) => p.probeId)).toEqual(['order-1']);
        expect(checkConclusionFor(v.verdictState, v)).toEqual({ conclusion: 'success', title: 'No regressions in what was tested · 1 described change' });
    });

    it('an intent mismatch is advisory: never a finding, never a failure (kr-shop #7)', () => {
        const added = { probeId: 'quote', entryPoint: quote, verdict: 'new_endpoint' as const, reason: 'main has no such route' };
        const mismatch = { probeId: 'intent-1', entryPoint: quote, verdict: 'intent_mismatch' as const, reason: 'fails', source: 'intent' as const, statedIntents: said(true) };
        const v = decideRunVerdict({ entryPoints: [quote], probes: [added, mismatch] });
        expect(v).toMatchObject({ verdictState: 'no_regressions', findings: [] });
        expect(v.intentMismatches?.map((p) => p.probeId)).toEqual(['intent-1']);
        expect(checkConclusionFor(v.verdictState, v)).toEqual({ conclusion: 'success', title: 'No regressions in what was tested · 1 new endpoint · 1 not what the PR describes' });
    });

    it('an intent mismatch alone settles nothing', () => {
        const mismatch = { probeId: 'intent-1', entryPoint: quote, verdict: 'intent_mismatch' as const, reason: 'fails', source: 'intent' as const, statedIntents: said(true) };
        expect(decideRunVerdict({ entryPoints: [quote], probes: [mismatch] })).toMatchObject({ verdictState: 'partly_tested', uncoveredEntryPoints: [quote] });
    });

    it("a planned regression whose quoted assertion fails stays a regression, and the check counts the mismatch", () => {
        const regression = { probeId: 'order-1', entryPoint: 'GET /orders/:id', verdict: 'finding' as const, findingKind: 'behavior_change' as const, reason: 'differs', statedIntents: said(true) };
        const v = decideRunVerdict({ entryPoints: ['GET /orders/:id'], probes: [regression] });
        expect(v.verdictState).toBe('regression');
        expect(checkConclusionFor(v.verdictState, v)).toEqual({ conclusion: 'failure', title: '1 regression · 1 not what the PR describes' });
    });

    it("an intent probe the gate could not decide never holds its entry point back", () => {
        const undecided = { probeId: 'intent-1', entryPoint: 'GET /orders', verdict: 'inconclusive' as const, reason: 'base varies', source: 'intent' as const };
        expect(decideRunVerdict({ entryPoints: ['GET /orders'], probes: [nr('GET /orders'), undecided] }).verdictState).toBe('no_regressions');
    });
});

describe('kept checks on the wire', () => {
    const runId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    const key = Buffer.alloc(32, 7);
    const req: RuntimeRunRequested = {
        runId,
        attempt: 1,
        correlationId: 'c',
        requestedAt: '2026-10-29T12:00:00.000Z',
        organizationId: 'o',
        teamId: 't',
        repository: { id: 'r', name: 'acme/shop' },
        pullRequest: { number: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), fork: false },
        environment: { environmentId: 'e', imageId: 'i', expose: [] },
        diff: [],
        repoToken: sealSecret('ghs_x', key, runId),
        runToken: sealSecret('krt1.x.y', key, runId),
        trigger: 'pull_request',
    };
    const check = {
        keptCheckId: '6f1c1d3e-2b7a-4c55-9a0e-3d2f4b5a6c7d',
        entryPoint: 'POST /orders',
        probe: { spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'POST', path: '/orders', timeoutMs: 5_000 }, purpose: 'p', expected: '400', compare: ['status'] },
        assertions: { kind: 'http', status: 400 },
        differingFields: ['status'],
        sourcePrNumber: 7,
    };

    it('a Run request carries the kept checks of its repository', () => {
        expect(RuntimeRunRequestedSchema.safeParse({ ...req, keptChecks: [check] }).success).toBe(true);
        expect(RuntimeRunRequestedSchema.safeParse({ ...req, keptChecks: [{ ...check, assertions: undefined }] }).success).toBe(false);
    });

    it("a Run request carries the suite section the Run's e2e stage runs from: sealed tokens bound to the Run, the main commit and the PR's files", () => {
        const suite = { mainSha: 'c'.repeat(40), repoToken: sealSecret('ghs_s0', key, runId), moreRepoTokens: [sealSecret('ghs_s1', key, runId)], changedFiles: ['src/a.ts'], removedFiles: [], deltaFiles: ['src/a.ts'] };
        expect(RuntimeRunRequestedSchema.safeParse({ ...req, suite }).success).toBe(true);
        expect(RuntimeRunRequestedSchema.safeParse({ ...req, suite: { ...suite, repoToken: 'ghs_plain' } }).success).toBe(false);
        expect(RuntimeRunRequestedSchema.safeParse({ ...req, suite: { ...suite, extra: 1 } }).success).toBe(false);
        expect(RuntimeRunRequestedSchema.safeParse({ ...req, suite: { ...suite, mainSha: 'abc' } }).success).toBe(false);
    });

    it('an external finding Run never carries the suite: its plan is closed', () => {
        const suite = { mainSha: 'c'.repeat(40), repoToken: sealSecret('ghs_s0', key, runId) };
        const r = RuntimeRunRequestedSchema.safeParse({ ...req, trigger: 'external_finding' as const, suite });
        expect(r.success).toBe(false);
        expect(!r.success && r.error.issues.some((i) => i.path[0] === 'suite')).toBe(true);
    });

    it('an external finding Run never carries kept checks: its plan is closed', () => {
        const external = { ...req, trigger: 'external_finding' as const, keptChecks: [check] };
        expect(RuntimeRunRequestedSchema.safeParse(external).success).toBe(false);
    });

    it('the report says which path a kept check played and which kept checks went stale', () => {
        const report = {
            state: 'regression',
            verdictState: 'regression',
            headSha: 'a'.repeat(40),
            requestedAt: '2026-10-29T12:00:00.000Z',
            paths: [{ entryPoint: 'unmapped', probeId: `kept:${check.keptCheckId}`, verdict: 'finding', source: 'kept_check', keptCheckId: check.keptCheckId }],
            uncovered: [],
            blockedOutbound: [],
            keptChecks: { played: 2, failed: 1, notRun: [{ keptCheckId: '7f1c1d3e-2b7a-4c55-9a0e-3d2f4b5a6c7d', outcome: 'stale', staleReason: 'route_gone' }] },
        };
        expect(RuntimeRunReportSchema.safeParse(report).success).toBe(true);
        expect(RuntimeRunReportSchema.safeParse({ ...report, paths: [{ ...report.paths[0], source: 'planner_typo' }] }).success).toBe(false);
    });
});
