import type { BusinessValidationOutcome } from './business-validation.types';
import { carryOver, matchPrevious } from './carry-over';
import type { RunTask } from './runs/validation-run.model';

type Validated = Extract<BusinessValidationOutcome, { kind: 'validated' }>;

const now = (
    requirements: Validated['checks'][number]['verdict']['requirements'],
): Validated => ({
    kind: 'validated',
    checks: [
        {
            task: { tracker: 'Linear', id: 'SAA-96' },
            verdict: {
                needsMoreInfo: false,
                summary: '',
                requirements,
                outOfScope: [],
            },
            passed: false,
            readAt: '2026-10-05T12:00:00.000Z',
        },
    ],
    thinTasks: [],
    passed: false,
    unseenFiles: [],
});

const before: RunTask[] = [
    {
        tracker: 'Linear',
        id: 'SAA-96',
        readAt: '2026-10-05T10:00:00.000Z',
        passed: false,
        requirements: [
            {
                requirement: 'Keyboard reordering',
                state: 'missing',
                evidence: [],
                confidence: 'high',
                accepted: {
                    by: 'nina',
                    movedTo: 'SAA-102',
                    at: '2026-10-05T11:00:00.000Z',
                },
            },
            {
                requirement: 'Order persists after reload',
                state: 'missing',
                evidence: [],
                confidence: 'high',
            },
        ],
        outOfScope: [],
    },
];

describe('carryOver', () => {
    it('keeps what a reviewer accepted, so a re-check passes (UC-37)', () => {
        const result = carryOver(
            now([
                {
                    requirement: 'Keyboard reordering',
                    state: 'missing',
                    evidence: [],
                    confidence: 'high',
                },
                {
                    requirement: 'Order persists after reload!',
                    state: 'met',
                    evidence: [],
                    confidence: 'high',
                },
            ]),
            before,
        );
        if (result.kind !== 'validated') throw new Error('expected validated');
        const [keyboard, order] = result.checks[0].verdict.requirements!;
        expect(keyboard.accepted).toMatchObject({
            by: 'nina',
            movedTo: 'SAA-102',
        });
        expect(order.previousState).toBe('missing');
        expect(result.passed).toBe(true);
    });

    it('drops an acceptance once the requirement is met', () => {
        const result = carryOver(
            now([
                {
                    requirement: 'Keyboard reordering',
                    state: 'met',
                    evidence: [],
                    confidence: 'high',
                },
            ]),
            before,
        );
        if (result.kind !== 'validated') throw new Error('expected validated');
        expect(
            result.checks[0].verdict.requirements![0].accepted,
        ).toBeUndefined();
    });

    it('never carries an acceptance to a requirement whose operator changed', () => {
        const accepted: RunTask[] = [
            {
                ...before[0],
                requirements: [
                    {
                        requirement: 'Rejects a count > 10',
                        state: 'missing',
                        evidence: [],
                        confidence: 'high',
                        accepted: {
                            by: 'nina',
                            at: '2026-10-05T11:00:00.000Z',
                        },
                    },
                ],
            },
        ];
        const result = carryOver(
            now([
                {
                    requirement: 'Rejects a count < 10',
                    state: 'missing',
                    evidence: [],
                    confidence: 'high',
                },
            ]),
            accepted,
        );
        if (result.kind !== 'validated') throw new Error('expected validated');
        expect(
            result.checks[0].verdict.requirements![0].accepted,
        ).toBeUndefined();
        expect(result.passed).toBe(false);
    });

    it('keeps an acceptance when the judge re-quotes the requirement differently', () => {
        const accepted: RunTask[] = [
            {
                ...before[0],
                requirements: [
                    {
                        requirement:
                            'Notes can be reordered with the keyboard, using the arrow keys.',
                        state: 'missing',
                        evidence: [],
                        confidence: 'high',
                        accepted: {
                            by: 'nina',
                            at: '2026-10-05T11:00:00.000Z',
                        },
                    },
                ],
            },
        ];
        const result = carryOver(
            now([
                {
                    requirement: 'Notes can be reordered with the keyboard',
                    state: 'missing',
                    evidence: [],
                    confidence: 'high',
                },
            ]),
            accepted,
        );
        if (result.kind !== 'validated') throw new Error('expected validated');
        expect(
            result.checks[0].verdict.requirements![0].accepted,
        ).toMatchObject({ by: 'nina' });
        expect(result.passed).toBe(true);
    });
});

describe('matchPrevious', () => {
    it('takes the exact text first, then the most alike, each earlier requirement once', () => {
        expect(
            matchPrevious(
                [
                    'Admins can archive notes',
                    'Admins can delete notes',
                    'Notes sync across devices',
                ],
                [
                    'Admins can delete notes',
                    'Notes sync across devices and browsers',
                ],
            ),
        ).toEqual([undefined, 0, 1]);
    });
});
