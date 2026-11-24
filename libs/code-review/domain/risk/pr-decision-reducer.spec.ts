import {
    readyValue,
    reduce,
    stale,
    unavailable,
    type L0Verdict,
    type L2Verdict,
    type L3Verdict,
    type ReducerInput,
} from './pr-decision-reducer';

const SNAP = 'cfg=v11;model=kodus-managed;head-sha-test';

const l0Ok: L0Verdict = [];
const l0Fail: L0Verdict = [
    {
        name: 'has-required-labels',
        passed: false,
        reason: 'policy "release" requires label "release-required"',
    },
];

const l1Low = {
    riskScore: 0.16,
    level: 'LOW' as const,
    blastRadius: { totalFunctions: 1, totalFiles: 1 },
    testGaps: [],
    vetoContributingFunctions: [],
    factors: [{ name: 'blast_radius', value: 0.1, detail: 'small' }],
};

const l1High = {
    riskScore: 0.78,
    level: 'HIGH' as const,
    blastRadius: { totalFunctions: 30, totalFiles: 18 },
    testGaps: [{ functionName: 'f', filePath: 'src/x.ts', lineStart: 10 }],
    vetoContributingFunctions: [],
    factors: [{ name: 'blast_radius', value: 0.7, detail: 'wide' }],
};

const l1Medium = {
    riskScore: 0.45,
    level: 'MEDIUM' as const,
    blastRadius: { totalFunctions: 6, totalFiles: 4 },
    testGaps: [],
    vetoContributingFunctions: [],
    factors: [{ name: 'blast_radius', value: 0.4, detail: 'local' }],
};

const l2Clean: L2Verdict = {
    riskIdentified: false,
    reason: 'no risk indicators',
};
const l2Risk: L2Verdict = {
    riskIdentified: true,
    reason: 'auth path with no test coverage',
};

const l3Matched = (id: string): L3Verdict => ({
    matchedPolicyId: id,
    unmatchedReasons: [],
});

const l3Unmatched = (reasons: string[]): L3Verdict => ({
    matchedPolicyId: null,
    unmatchedReasons: reasons,
});

function build(over: Partial<ReducerInput> = {}): ReducerInput {
    return {
        snapshotKey: SNAP,
        l0: readyValue(l0Ok, SNAP),
        l1: readyValue(l1Low, SNAP),
        l2: readyValue(l2Clean, SNAP),
        l3: readyValue(l3Matched('docs/**'), SNAP),
        ...over,
    };
}

describe('reduce (truth-table)', () => {
    it('APPROVE on quiet L0+L1LOW+L2CLEAN+L3 matched', () => {
        const r = reduce(build());
        expect(r.kind).toBe('APPROVE');
        if (r.kind === 'APPROVE') {
            expect(r.policyId).toBe('docs/**');
            expect(r.snapshotKey).toBe(SNAP);
        }
    });

    it('Q1 — L1 Unavailable does not veto; APPROVE if others are quiet', () => {
        const r = reduce(
            build({ l1: unavailable(SNAP, 'ast graph not indexed') }),
        );
        expect(r.kind).toBe('APPROVE');
    });

    it('L1 HIGH vetoes with l1 source', () => {
        const r = reduce(build({ l1: readyValue(l1High, SNAP) }));
        expect(r.kind).toBe('HOLD');
        if (r.kind === 'HOLD') {
            expect(r.vetoSources).toContain('l1');
            expect(r.reason).toContain('HIGH');
        }
    });

    it('L1 MEDIUM is non-vetoing; reduces to L2-led decision', () => {
        // L1 medium, L2 clean, L3 matched: should still APPROVE
        const r = reduce(build({ l1: readyValue(l1Medium, SNAP) }));
        expect(r.kind).toBe('APPROVE');
        if (r.kind === 'APPROVE') {
            expect(r.reason).toContain('MEDIUM'); // context rides along
        }

        // L1 medium, L2 risk-found: still HOLD via L2 (l1 doesn't add a veto)
        const r2 = reduce(
            build({
                l1: readyValue(l1Medium, SNAP),
                l2: readyValue(l2Risk, SNAP),
            }),
        );
        expect(r2.kind).toBe('HOLD');
        if (r2.kind === 'HOLD') {
            expect(r2.vetoSources).toContain('l2');
            expect(r2.vetoSources).not.toContain('l1');
        }
    });

    it('L2 risk-found vetoes with l2 source', () => {
        const r = reduce(build({ l2: readyValue(l2Risk, SNAP) }));
        expect(r.kind).toBe('HOLD');
        if (r.kind === 'HOLD') {
            expect(r.vetoSources).toContain('l2');
            expect(r.reason).toContain('auth path with no test coverage');
        }
    });

    it('L2 Unavailable fails closed', () => {
        const r = reduce(
            build({ l2: unavailable(SNAP, 'rate-limit by main-provider') }),
        );
        expect(r.kind).toBe('HOLD');
        if (r.kind === 'HOLD') {
            expect(r.vetoSources).toContain('l2');
            expect(r.reason).toContain('fail-closed');
        }
    });

    it('L3 unmatched → HOLD(veto=l3)', () => {
        const r = reduce(
            build({
                l3: readyValue(l3Unmatched(['no label', 'no match']), SNAP),
            }),
        );
        expect(r.kind).toBe('HOLD');
        if (r.kind === 'HOLD') {
            expect(r.vetoSources).toContain('l3');
            expect(r.reason).toContain('No policy matched');
        }
    });

    it('L3 Unavailable → HOLD(veto=l3)', () => {
        const r = reduce(build({ l3: unavailable(SNAP, 'matcher threw') }));
        expect(r.kind).toBe('HOLD');
        if (r.kind === 'HOLD') {
            expect(r.vetoSources).toContain('l3');
            expect(r.reason).toContain('matcher unavailable');
        }
    });

    it('Stale on any gate → HOLD(staleness)', () => {
        const r = reduce(build({ l2: stale(SNAP, 'cfg=v10') }));
        expect(r.kind).toBe('HOLD');
        if (r.kind === 'HOLD') {
            expect(r.vetoSources).toEqual(['stale-snapshot']);
        }
    });

    it('L0 failed conditions surface in reason but L0 does not veto', () => {
        const r = reduce(build({ l0: readyValue(l0Fail, SNAP) }));
        // L0 failed → reason carries it. But the reduce function does *not*
        // treat L0 as a veto source. The reducer PIN's L0 as advisory until
        // the team explicitly elevates it. So approval can still go through
        // if L3 matched AND L1+L2 quiet.
        expect(r.kind).toBe('APPROVE');
        if (r.kind === 'APPROVE') {
            expect(r.reason).toContain('L0 conditions failed');
        }
    });

    it('multiple veto sources are surfaced together', () => {
        const r = reduce(
            build({
                l1: readyValue(l1High, SNAP),
                l2: readyValue(l2Risk, SNAP),
            }),
        );
        expect(r.kind).toBe('HOLD');
        if (r.kind === 'HOLD') {
            expect(r.vetoSources).toEqual(expect.arrayContaining(['l1', 'l2']));
            expect(r.reason).toMatch(/HIGH.*auth path with no test coverage/);
        }
    });

    it('Approval reason snapshot key matches the reducer input', () => {
        const r = reduce(build({ snapshotKey: 'cfg=v12' }));
        expect(r.snapshotKey).toBe('cfg=v12');
    });
});
