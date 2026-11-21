import { decideProbe, GateStep } from './gate';
import {
    baseUnstableFields,
    MAX_KNOWN_UNSTABLE_FIELDS,
    NORMALIZER_VERSION,
    probeKeyOf,
    stabilityPolicyFor,
    StabilityRecord,
} from './stability';

const IMAGE = 'ami-0abc';
let n = 0;
const step = (side: 'base' | 'pr', round: number, fields: Record<string, string>, over: Partial<GateStep> = {}): GateStep => ({
    stepId: `s${++n}`,
    probeId: 'p1',
    side,
    round,
    executor: 'observer',
    imageId: IMAGE,
    transport: 'ok',
    vmHealth: 'ok',
    timedOut: false,
    fields,
    expectedHolds: true,
    ...over,
});
const rec = (over: Partial<StabilityRecord> = {}): StabilityRecord => ({ normalizerVersion: NORMALIZER_VERSION, unstableFields: [], verdict: 'not_reproduced', ...over });

describe('stability history (ADR-050)', () => {
    describe('stabilityPolicyFor', () => {
        it('without history a probe starts with the table default: two base rounds, nothing known to vary', () => {
            const p = stabilityPolicyFor([]);
            expect(p).toMatchObject({ baseRounds: 2, maxRoundsPerSide: 4, maxMaskedFields: 5, knownUnstableFields: [], historyRuns: 0 });
            expect(p.snapshot).toBe(JSON.stringify({ v: 1, baseRounds: 2, maxRoundsPerSide: 4, maxMaskedFields: 5, knownUnstableFields: [], historyRuns: 0 }));
        });

        it('a probe whose base varied in an earlier Run starts with one more base round and those fields masked', () => {
            const p = stabilityPolicyFor([rec({ unstableFields: ['json.id'] }), rec({ unstableFields: ['json.at', 'json.id'] }), rec()]);
            expect(p).toMatchObject({ baseRounds: 3, knownUnstableFields: ['json.at', 'json.id'], historyRuns: 3 });
        });

        it('a probe that ended inconclusive before starts with one more base round even with no field named', () => {
            expect(stabilityPolicyFor([rec({ verdict: 'inconclusive' })]).baseRounds).toBe(3);
        });

        it('ignores history written by another normalizer version: its field names may mean something else', () => {
            const p = stabilityPolicyFor([rec({ normalizerVersion: 'fields/0', unstableFields: ['json.id'], verdict: 'inconclusive' })]);
            expect(p).toMatchObject({ baseRounds: 2, knownUnstableFields: [], historyRuns: 0 });
        });

        it('keeps at most a bounded number of known fields, which the masked-field ceiling then turns inconclusive', () => {
            const many = Array.from({ length: MAX_KNOWN_UNSTABLE_FIELDS + 10 }, (_, i) => `json.f${String(i).padStart(3, '0')}`);
            expect(stabilityPolicyFor([rec({ unstableFields: many })]).knownUnstableFields).toHaveLength(MAX_KNOWN_UNSTABLE_FIELDS);
        });
    });

    describe('baseUnstableFields', () => {
        it('names only the fields the healthy base rounds disagree on: the PR side never writes history (S-36)', () => {
            const steps = [
                step('base', 1, { status: '200', 'json.id': '1', 'json.x': 'a' }),
                step('base', 2, { status: '200', 'json.id': '2', 'json.x': 'a' }),
                step('base', 3, { status: '500', 'json.id': '9' }, { transport: 'lost' }),
                step('pr', 1, { status: '200', 'json.id': '3', 'json.x': 'b' }),
                step('pr', 2, { status: '200', 'json.id': '4', 'json.x': 'c' }),
            ];
            expect(baseUnstableFields(steps)).toEqual(['json.id']);
        });
    });

    describe('probeKeyOf', () => {
        it('keys an http probe by method and route, without the query', () => {
            expect(probeKeyOf({ kind: 'http', method: 'GET', path: '/api/orders?id=1' } as never)).toBe('http GET /api/orders');
        });

        it('keys a sql probe by its target and query, never one key for every query of a database', () => {
            const a = probeKeyOf({ kind: 'sql', target: { service: 'db' }, query: 'select 1' } as never);
            const b = probeKeyOf({ kind: 'sql', target: { service: 'db' }, query: 'select 2' } as never);
            expect(a).toMatch(/^sql db [0-9a-f]{16}$/);
            expect(a).not.toBe(b);
        });

        it('gives a shell probe no key: it never decides', () => {
            expect(probeKeyOf({ kind: 'shell', command: 'true' } as never)).toBeUndefined();
        });
    });

    describe('decideProbe with known unstable fields', () => {
        const opts = (known: string[]) => ({ pinnedImageId: IMAGE, knownUnstableFields: known });

        it('masks a field known to vary on the base even when this Run\'s base rounds agree on it', () => {
            const d = decideProbe(
                [step('base', 1, { status: '200', 'json.at': 't1', 'json.ok': 'y' }), step('base', 2, { status: '200', 'json.at': 't1', 'json.ok': 'y' }), step('pr', 1, { status: '200', 'json.at': 't1', 'json.ok': 'y' })],
                opts(['json.at']),
            );
            expect(d).toMatchObject({ kind: 'verdict', verdict: 'not_reproduced', maskedFields: ['json.at'] });
        });

        it('asks for another base round when only a history-masked field differs on the PR, and stays inconclusive at the ceiling', () => {
            const base = [step('base', 1, { status: '200', 'json.at': 't1' }), step('base', 2, { status: '200', 'json.at': 't1' })];
            const pr = [step('pr', 1, { status: '200', 'json.at': 't9' })];
            expect(decideProbe([...base, ...pr], opts(['json.at']))).toMatchObject({ kind: 'more_rounds', base: 1, pr: 0 });
            const full = [...base, step('base', 3, { status: '200', 'json.at': 't1' }), step('base', 4, { status: '200', 'json.at': 't1' }), ...pr];
            expect(decideProbe(full, opts(['json.at']))).toMatchObject({ kind: 'verdict', verdict: 'inconclusive', maskedFields: ['json.at'] });
        });

        it('a decisive field known to vary on the base makes the probe inconclusive', () => {
            const d = decideProbe([step('base', 1, { status: '200' }), step('base', 2, { status: '200' }), step('pr', 1, { status: '500' })], opts(['status']));
            expect(d).toMatchObject({ kind: 'verdict', verdict: 'inconclusive' });
        });

        it('known fields count toward the masked-field ceiling', () => {
            const fields = { status: '200', 'json.a': '1', 'json.b': '1', 'json.c': '1', 'json.ok': 'y' };
            const d = decideProbe([step('base', 1, fields), step('base', 2, fields), step('pr', 1, fields)], { ...opts(['json.a', 'json.b', 'json.c']), maxMaskedFields: 2 });
            expect(d).toMatchObject({ kind: 'verdict', verdict: 'inconclusive', reason: 'more than 2 fields vary between base rounds' });
        });

        it('a known field the probe no longer answers changes nothing', () => {
            const f = { status: '200', 'json.ok': 'y' };
            expect(decideProbe([step('base', 1, f), step('base', 2, f), step('pr', 1, f)], opts(['json.gone']))).toMatchObject({ verdict: 'not_reproduced', maskedFields: [] });
        });
    });
});
