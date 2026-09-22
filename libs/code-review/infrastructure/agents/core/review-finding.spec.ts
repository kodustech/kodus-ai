import {
    buildFindingsFromVerify,
    diedAt,
    makeFindingId,
    summarizeFunnel,
    type ReviewFinding,
} from './review-finding';
import type { FinderSuggestion } from './finder.agent';
import type { FinderWithVerifyResult } from './finder.agent';

const EMPTY_EVIDENCE = { strongFiles: [], weakFiles: [] } as any;

function sugg(over: Partial<FinderSuggestion> = {}): FinderSuggestion {
    return {
        relevantFile: 'src/a.ts',
        suggestionContent: 'use optional chaining',
        existingCode: 'a.b',
        improvedCode: 'a?.b',
        severity: 'high',
        label: 'bug',
        relevantLinesStart: 10,
        ...over,
    };
}

function result(over: Partial<FinderWithVerifyResult> = {}): FinderWithVerifyResult {
    return {
        reasoning: 'r',
        kept: [],
        keptEvidence: [],
        droppedByVerify: [],
        finderState: { steps: [], usage: {} } as any,
        verifyUsage: {} as any,
        recallUsage: {} as any,
        ...over,
    };
}

describe('review-finding', () => {
    describe('makeFindingId', () => {
        it('is stable for the same payload + agent', () => {
            const s = sugg();
            expect(makeFindingId(s, 'bug')).toBe(makeFindingId(s, 'bug'));
        });

        it('differs by file, line, content and agent', () => {
            const base = sugg();
            const id = makeFindingId(base, 'bug');
            expect(makeFindingId(sugg({ relevantFile: 'src/b.ts' }), 'bug')).not.toBe(id);
            expect(makeFindingId(sugg({ relevantLinesStart: 99 }), 'bug')).not.toBe(id);
            expect(makeFindingId(sugg({ suggestionContent: 'other' }), 'bug')).not.toBe(id);
            expect(makeFindingId(base, 'security')).not.toBe(id);
        });
    });

    describe('buildFindingsFromVerify', () => {
        it('tags kept findings as surviving the verify gate, with evidence', () => {
            const r = result({
                kept: [sugg()],
                keptEvidence: [{ strongFiles: ['src/a.ts'], weakFiles: [] } as any],
            });
            const [f] = buildFindingsFromVerify(r, { agent: 'bug', pass: 'initial' });
            expect(f.gates).toEqual([
                { gate: 'found', outcome: 'survived' },
                { gate: 'verify', outcome: 'survived' },
            ]);
            expect(f.evidence).toEqual({ strongFiles: ['src/a.ts'], weakFiles: [] });
            expect(diedAt(f)).toBeUndefined();
            expect(f.provenance.agent).toBe('bug');
            expect(f.provenance.pass).toBe('initial');
        });

        it('tags dropped findings as dying at verify, carrying the reason', () => {
            const r = result({
                droppedByVerify: [
                    {
                        finding: sugg({ relevantFile: 'src/x.ts' }),
                        evidence: 'not reachable in this path',
                        verifierEvidence: EMPTY_EVIDENCE,
                    },
                ],
            });
            const [f] = buildFindingsFromVerify(r, { agent: 'security', pass: 'synthesis' });
            expect(diedAt(f)).toBe('verify');
            expect(f.gates.at(-1)).toEqual({
                gate: 'verify',
                outcome: 'dropped',
                reason: 'not reachable in this path',
            });
        });

        it('carries self-confidence from the payload into provenance', () => {
            const r = result({ kept: [sugg({ confidence: 7 })] });
            const [f] = buildFindingsFromVerify(r, { agent: 'bug', pass: 'initial' });
            expect(f.provenance.selfConfidence).toBe(7);
        });
    });

    describe('summarizeFunnel', () => {
        it('counts the verify gate split overall and per severity/label', () => {
            const findings: ReviewFinding[] = buildFindingsFromVerify(
                result({
                    kept: [sugg({ severity: 'high', label: 'bug' })],
                    keptEvidence: [EMPTY_EVIDENCE],
                    droppedByVerify: [
                        {
                            finding: sugg({ severity: 'high', label: 'bug' }),
                            evidence: 'x',
                            verifierEvidence: EMPTY_EVIDENCE,
                        },
                        {
                            finding: sugg({ severity: 'low', label: 'performance' }),
                            evidence: 'y',
                            verifierEvidence: EMPTY_EVIDENCE,
                        },
                    ],
                }),
                { agent: 'bug', pass: 'initial' },
            );

            const report = summarizeFunnel(findings);
            expect(report.found).toBe(3);
            expect(report.survivedVerify).toBe(1);
            expect(report.droppedByVerify).toBe(2);
            expect(report.bySeverity.high).toEqual({ found: 2, dropped: 1 });
            expect(report.bySeverity.low).toEqual({ found: 1, dropped: 1 });
            expect(report.byLabel.bug).toEqual({ found: 2, dropped: 1 });
            expect(report.byLabel.performance).toEqual({ found: 1, dropped: 1 });
        });

        it('buckets missing severity/label under "unknown"', () => {
            const findings = buildFindingsFromVerify(
                result({ kept: [sugg({ severity: undefined, label: undefined })], keptEvidence: [EMPTY_EVIDENCE] }),
                { agent: 'bug', pass: 'initial' },
            );
            const report = summarizeFunnel(findings);
            expect(report.bySeverity.unknown).toEqual({ found: 1, dropped: 0 });
            expect(report.byLabel.unknown).toEqual({ found: 1, dropped: 0 });
        });

        it('is empty-safe', () => {
            const report = summarizeFunnel([]);
            expect(report).toEqual({
                found: 0,
                survivedVerify: 0,
                droppedByVerify: 0,
                bySeverity: {},
                byLabel: {},
            });
        });
    });
});
