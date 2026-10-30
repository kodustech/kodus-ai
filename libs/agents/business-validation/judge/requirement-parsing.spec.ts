import { parseReplyIntent } from './reply-classifier';
import { parseBusinessRulesValidationResult } from './validation-result.parser';

describe('parsing a requirement-level verdict', () => {
    it('reads requirements and changes, and derives the status from them', () => {
        const result = parseBusinessRulesValidationResult({
            needsMoreInfo: false,
            summary: 'One gap.',
            requirements: [
                {
                    requirement: 'Persists per user',
                    state: 'met',
                    confidence: 'high',
                    evidence: [{ file: 'a.ts', line: 3 }],
                    topic: 'data_and_persistence',
                },
                {
                    requirement: 'Defaults to comfortable',
                    state: 'missing',
                    confidence: 'weird',
                    evidence: [{ file: 'b.ts', line: 'x' }],
                },
                { requirement: '', state: 'met' },
                { requirement: 'Unknown state', state: 'done' },
            ],
            outOfScope: [{ change: 'Pagination size', evidence: [] }],
        });
        expect(result.requirements).toEqual([
            expect.objectContaining({
                requirement: 'Persists per user',
                state: 'met',
                topic: 'data_and_persistence',
                evidence: [{ file: 'a.ts', line: 3 }],
            }),
            expect.objectContaining({
                requirement: 'Defaults to comfortable',
                state: 'missing',
                confidence: 'medium',
                evidence: [{ file: 'b.ts' }],
            }),
        ]);
        expect(result.outOfScope).toEqual([
            { change: 'Pagination size', evidence: [] },
        ]);
        expect(result.status).toBe('issues_found');
        expect(result.findings).toEqual([
            { severity: 'must_fix', title: 'Defaults to comfortable' },
            { severity: 'suggestion', title: 'Pagination size' },
        ]);
    });

    it('is compliant when every requirement is met and nothing is out of scope', () => {
        const result = parseBusinessRulesValidationResult({
            needsMoreInfo: false,
            summary: 'ok',
            requirements: [
                { requirement: 'x', state: 'met', confidence: 'high' },
            ],
            outOfScope: [],
        });
        expect(result.status).toBe('compliant');
    });
});

describe('parseReplyIntent', () => {
    const findings = [
        {
            index: 1,
            taskId: 'SAA-96',
            kind: 'requirement' as const,
            text: 'Keyboard reordering',
            state: 'missing',
        },
    ];

    it('reads an acceptance with where the work went', () => {
        expect(
            parseReplyIntent(
                { intent: 'accept', findings: [1], movedTo: 'SAA-102' },
                findings,
            ),
        ).toEqual({ intent: 'accept', findings: [1], movedTo: 'SAA-102' });
    });

    it('treats a decision about no known finding as other', () => {
        expect(
            parseReplyIntent({ intent: 'accept', findings: [7] }, findings),
        ).toEqual({
            intent: 'other',
        });
        expect(parseReplyIntent(undefined, findings)).toEqual({
            intent: 'other',
        });
    });
});
