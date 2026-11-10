import { publishKey, type RuntimePublishRequested } from '@libs/runtime/run';

import {
    isFinalPublication,
    MAX_REDRIVE_ATTEMPTS,
    MAX_STORED_REQUEST_BYTES,
    nextRedriveStep,
    storableRequestOf,
} from './publication-redrive';

const RUN_ID = '0b9f4c1e-8d2a-4f6b-9a3c-1e2d3f4a5b6c';
const report = (paths = 1): RuntimePublishRequested['report'] => ({
    state: 'no_regressions',
    headSha: 'a'.repeat(40),
    requestedAt: '2026-10-31T14:00:00.000Z',
    paths: Array.from({ length: paths }, (_, i) => ({ entryPoint: `GET /${'x'.repeat(500)}${i}`, probeId: `p${i}`, verdict: 'not_reproduced' as const })),
    uncovered: [],
    blockedOutbound: [],
});
const msg = (patch: Partial<RuntimePublishRequested>): RuntimePublishRequested => ({
    runId: RUN_ID,
    attempt: 1,
    kind: 'comment',
    key: publishKey(RUN_ID, 1, 'comment'),
    correlationId: 'c',
    ...patch,
});
const check = (status: 'queued' | 'in_progress' | 'completed', summary = 's') =>
    msg({ kind: 'check', key: publishKey(RUN_ID, 1, 'check'), check: { status, conclusion: status === 'completed' ? 'success' : undefined, title: 't', summary }, report: report() });

describe('isFinalPublication', () => {
    it('is the report comment and the completed check, never a progress phase or an open check', () => {
        expect(isFinalPublication(msg({ report: report() }))).toBe(true);
        expect(isFinalPublication(msg({ progress: { phase: 'testing', requestedAt: 'x', startedAt: 'x' } }))).toBe(false);
        expect(isFinalPublication(check('completed'))).toBe(true);
        expect(isFinalPublication(check('in_progress'))).toBe(false);
    });
});

describe('storableRequestOf', () => {
    it('keeps a final request as is, and nothing for a non-final one', () => {
        const final = msg({ report: report() });
        expect(storableRequestOf(final)).toBe(final);
        expect(storableRequestOf(check('queued'))).toBeUndefined();
    });

    it('drops the never-rendered check summary first when the request is too large', () => {
        const big = check('completed', 'y'.repeat(MAX_STORED_REQUEST_BYTES));
        expect(storableRequestOf(big)?.check?.summary).toBe('');
        expect(storableRequestOf(big)?.report).toEqual(big.report);
    });

    it('keeps nothing when even the trimmed request is over the bound', () => {
        expect(storableRequestOf(msg({ report: report(100), correlationId: 'c'.repeat(128) }))).toBeDefined();
        const huge = { ...msg({}), report: { ...report(1), paths: report(1)!.paths.map((p) => ({ ...p, entryPoint: 'z'.repeat(MAX_STORED_REQUEST_BYTES) })) } };
        expect(storableRequestOf(huge)).toBeUndefined();
    });
});

describe('nextRedriveStep', () => {
    const comment = { kind: 'comment' as const, request: msg({ report: report() }) };
    it('re-drives up to the limit, then a report comment gets one fallback, then gives up', () => {
        expect(nextRedriveStep({ ...comment })).toBe('redrive');
        expect(nextRedriveStep({ ...comment, redrive: { attempts: MAX_REDRIVE_ATTEMPTS - 1 } })).toBe('redrive');
        expect(nextRedriveStep({ ...comment, redrive: { attempts: MAX_REDRIVE_ATTEMPTS } })).toBe('fallback');
        expect(nextRedriveStep({ ...comment, redrive: { attempts: MAX_REDRIVE_ATTEMPTS + 1 } })).toBe('give_up');
    });

    it('a completed check gets one fallback (closed neutral), then gives up', () => {
        expect(nextRedriveStep({ kind: 'check', request: check('completed'), redrive: { attempts: MAX_REDRIVE_ATTEMPTS } })).toBe('fallback');
        expect(nextRedriveStep({ kind: 'check', request: check('completed'), redrive: { attempts: MAX_REDRIVE_ATTEMPTS + 1 } })).toBe('give_up');
    });

    it('a check that never completed has no fallback', () => {
        expect(nextRedriveStep({ kind: 'check', request: check('in_progress'), redrive: { attempts: MAX_REDRIVE_ATTEMPTS } })).toBe('give_up');
    });
});
