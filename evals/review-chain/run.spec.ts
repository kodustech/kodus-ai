/**
 * Self-test for the review-chain wiring ledger. The ledger is a GATE — an
 * untested gate can silently stop gating — so this pins its two failure modes
 * (a boundary regressing below its resilience floor; an undeclared LLM
 * call-site) and the marker detection that both rest on, driving the pure
 * `analyze` / `detectMarkers` with synthetic inputs (no fs, no real chain).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { detectMarkers, analyze, BOUNDARIES } = require('./run');

describe('review-chain ledger — marker detection', () => {
    it('reads a real wiring, not a bare mention', () => {
        expect(detectMarkers('schema: mySchema,').schema).toBe(true);
        expect(detectMarkers('normalizeEnvelope(v, key)').shape).toBe(true);
        expect(detectMarkers('extractJsonFromText(raw)').shape).toBe(true);
        expect(detectMarkers('recoverEnvelopeShape: true').recover).toBe(true);
    });

    it('does NOT count a look-alike token (the substring trap)', () => {
        // `recoverEnvelopeShapeX:` must not satisfy the recover marker — the bug
        // an earlier loose /recoverEnvelopeShape/ regex had.
        expect(detectMarkers('recoverEnvelopeShapeX: true').recover).toBe(false);
        // a prose mention with no call/assignment is not a wiring
        expect(detectMarkers('// we call normalizeEnvelope somewhere').shape).toBe(false);
        expect(detectMarkers('the schema is validated').schema).toBe(false);
    });
});

describe('review-chain ledger — analyze gates', () => {
    const wiredDetect = () => ({ missing: [], schema: true, shape: true, recover: true });

    it('passes a wired boundary with no gating failures', () => {
        const { rows, gaps } = analyze({
            boundaries: [{ phase: 'p', files: ['f.ts'], requires: ['schema'] }],
            detectFor: wiredDetect,
            callSites: ['f.ts'],
        });
        expect(gaps).toBe(0);
        expect(rows[0].status).toBe('WIRED');
    });

    it('GATES a boundary that regressed below its resilience floor', () => {
        const { rows, gaps } = analyze({
            boundaries: [{ phase: 'shard', files: ['f.ts'], requires: ['schema', 'recover'] }],
            // schema kept, recover lost → below floor
            detectFor: () => ({ missing: [], schema: true, shape: false, recover: false }),
            callSites: ['f.ts'],
        });
        expect(gaps).toBe(1);
        expect(rows[0].status).toBe('REGRESSED');
        expect(rows[0].detail).toContain('recover');
    });

    it('GATES an undeclared LLM call-site (no manifest entry)', () => {
        const { rows, gaps } = analyze({
            boundaries: [{ phase: 'p', files: ['known.ts'], requires: ['schema'] }],
            detectFor: wiredDetect,
            callSites: ['known.ts', 'sneaky-new-phase.ts'],
        });
        expect(gaps).toBe(1);
        expect(rows.some((r: any) => r.status === 'UNDECLARED' && r.detail.includes('sneaky-new-phase.ts'))).toBe(true);
    });

    it('GATES a manifest entry whose file is missing', () => {
        const { rows, gaps } = analyze({
            boundaries: [{ phase: 'p', files: ['gone.ts'], requires: ['schema'] }],
            detectFor: () => ({ missing: ['gone.ts'] }),
            callSites: [],
        });
        expect(gaps).toBe(1);
        expect(rows[0].status).toBe('MISSING-FILE');
    });

    it('never gates a declined-by-design or accepted-gap boundary', () => {
        const { rows, gaps } = analyze({
            boundaries: [
                { phase: 'compiler', files: ['c.ts'], declined: true, note: 'regex' },
                { phase: 'severity', files: ['s.ts'], accepted: true, note: 'degrades safe' },
            ],
            detectFor: () => ({ missing: [], schema: false, shape: false, recover: false }),
            callSites: ['c.ts', 's.ts'],
        });
        expect(gaps).toBe(0);
        expect(rows.map((r: any) => r.status).sort()).toEqual(['ACCEPTED', 'DECLINED']);
    });
});

describe('review-chain ledger — the real manifest is coherent', () => {
    it('every entry declares exactly one posture (requires | declined | accepted)', () => {
        for (const b of BOUNDARIES) {
            const postures = [
                Array.isArray(b.requires) && b.requires.length > 0,
                b.declined === true,
                b.accepted === true,
            ].filter(Boolean);
            expect({ phase: b.phase, postures: postures.length }).toEqual({
                phase: b.phase,
                postures: 1,
            });
        }
    });

    it('the shard keeps recover in its floor (regression guard for #1786)', () => {
        const shard = BOUNDARIES.find((b: any) => b.phase === 'kody-rules-shard');
        expect(shard.requires).toContain('recover');
    });
});
