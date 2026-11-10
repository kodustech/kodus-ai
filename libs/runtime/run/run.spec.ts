import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

import { aggregateVerdicts, assertTransition, canTransition, checkConclusionFor, checkFor, decideRunVerdict, isTerminal } from './run-state';
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

describe('aggregateVerdicts and checkFor', () => {
    it('success needs not_reproduced on every entry point', () => {
        const v = aggregateVerdicts({ entryPoints: ['POST /orders', 'GET /cart'], probes: [nr('POST /orders'), nr('GET /cart')] });
        expect(v.verdictState).toBe('no_regressions');
        expect(checkFor('no_regressions', v)).toEqual({ conclusion: 'success', title: 'No regressions in what was tested' });
    });

    it('a pre-existing failure alone does not satisfy the not_reproduced requirement', () => {
        // §3/ADR-038: an existing failure is reported, but cannot certify the changed path.
        const v = decideRunVerdict({
            entryPoints: ['GET /cart'],
            probes: [{ probeId: 'old-cart-failure', entryPoint: 'GET /cart', verdict: 'pre_existing', reason: 'fails equally on both sides' }],
        });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.uncoveredEntryPoints).toEqual(['GET /cart']);
        expect(checkFor(v.verdictState, v).conclusion).toBe('neutral');
    });

    it('requires not_reproduced separately on each changed entry point', () => {
        const v = decideRunVerdict({
            entryPoints: ['POST /orders', 'GET /cart'],
            probes: [nr('POST /orders'), { probeId: 'old-cart-failure', entryPoint: 'GET /cart', verdict: 'pre_existing', reason: 'fails equally on both sides' }],
        });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.uncoveredEntryPoints).toEqual(['GET /cart']);
        expect(checkFor(v.verdictState, v).conclusion).toBe('neutral');
    });

    it('pre_existing does not prevent success when the same entry point also has not_reproduced', () => {
        const v = decideRunVerdict({
            entryPoints: ['GET /cart'],
            probes: [nr('GET /cart'), { probeId: 'old-cart-failure', entryPoint: 'GET /cart', verdict: 'pre_existing', reason: 'another pre-existing failure' }],
        });
        expect(v.verdictState).toBe('no_regressions');
        expect(v.uncoveredEntryPoints).toEqual([]);
        expect(checkFor(v.verdictState, v).conclusion).toBe('success');
    });

    it('an uncovered entry point is partly_tested and neutral', () => {
        const v = aggregateVerdicts({ entryPoints: ['POST /orders', 'GET /cart'], probes: [nr('POST /orders')] });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.uncoveredEntryPoints).toEqual(['GET /cart']);
        expect(checkFor('partly_tested', v).conclusion).toBe('neutral');
    });

    it('regression wins over partly_tested', () => {
        const v = aggregateVerdicts({
            entryPoints: ['POST /orders', 'GET /cart'],
            probes: [{ probeId: 'a', entryPoint: 'POST /orders', verdict: 'finding', reason: 'differs' }],
        });
        expect(v.verdictState).toBe('regression');
        expect(checkFor('regression', v)).toEqual({ conclusion: 'failure', title: '1 regression' });
    });

    it('an intended finding never leads to success', () => {
        const v = aggregateVerdicts({
            entryPoints: ['POST /orders'],
            probes: [{ probeId: 'a', entryPoint: 'POST /orders', verdict: 'finding', intent: 'intended', reason: 'differs' }],
        });
        expect(checkFor('partly_tested', v)).toEqual({ conclusion: 'neutral', title: 'Partly tested · 1 intended change' });
    });

    it('a blocked outbound request forces neutral', () => {
        const v = aggregateVerdicts({ entryPoints: ['GET /cart'], probes: [nr('GET /cart')], blockedOutbound: 1 });
        expect(checkFor('no_regressions', v)).toEqual({
            conclusion: 'neutral',
            title: 'No regressions in what was tested · 1 blocked outbound request',
        });
    });

    it('halted keeps the computed verdict and adds the security event', () => {
        const v = aggregateVerdicts({ entryPoints: ['GET /cart'], probes: [{ probeId: 'a', entryPoint: 'GET /cart', verdict: 'finding', reason: 'x' }] });
        expect(checkFor('halted', v)).toEqual({ conclusion: 'failure', title: '1 regression · security event' });
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

    it('a truncated diff is partly tested at best', () => {
        const v = decideRunVerdict({ entryPoints: ['GET /a'], probes: [nr('GET /a')], diffTruncated: true });
        expect(v.verdictState).toBe('partly_tested');
        expect(v.forcedNeutral).toContain('diff too large to test whole');
    });

    it('a Run waiting for approval can time out, and a boot can halt', () => {
        expect(canTransition('awaiting_approval', 'timed_out')).toBe(true);
        expect(canTransition('booting', 'halted')).toBe(true);
    });

    it('maps the non-verdict states', () => {
        expect(checkFor('awaiting_approval').conclusion).toBe('action_required');
        expect(checkFor('superseded').conclusion).toBe('cancelled');
        expect(checkFor('timed_out').conclusion).toBe('timed_out');
        expect(checkFor('errored')).toEqual({ conclusion: 'neutral', title: 'Could not finish' });
        expect(checkFor('could_not_boot', { verdictState: 'could_not_boot' })).toEqual({ conclusion: 'neutral', title: 'Could not boot' });
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
