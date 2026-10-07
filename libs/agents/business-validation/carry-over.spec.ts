import type { BusinessValidationOutcome } from './business-validation.types';
import { carryOver } from './carry-over';
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
            ['missing'],
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
            ['missing'],
        );
        if (result.kind !== 'validated') throw new Error('expected validated');
        expect(
            result.checks[0].verdict.requirements![0].accepted,
        ).toBeUndefined();
    });
});
