import type { BusinessValidationOutcome } from './business-validation.types';
import {
    carryOver,
    matchOutOfScope,
    matchPrevious,
    taskTextHash,
} from './carry-over';
import type { RunTask } from './runs/validation-run.model';

type Validated = Extract<BusinessValidationOutcome, { kind: 'validated' }>;

const TASK = {
    tracker: 'Linear',
    id: 'SAA-96',
    description: 'Notes can be reordered with the keyboard.',
};

const now = (
    requirements: Validated['checks'][number]['verdict']['requirements'],
    task: Validated['checks'][number]['task'] = TASK,
): Validated => ({
    kind: 'validated',
    checks: [
        {
            task,
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
                textHash: taskTextHash(TASK),
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

describe('carryOver of an accepted out-of-scope change', () => {
    const accepted = {
        by: 'nina',
        reason: 'fair refactor',
        at: '2026-10-05T11:00:00.000Z',
    };
    const beforeWith = (outOfScope: RunTask['outOfScope']): RunTask[] => [
        { ...before[0], requirements: [], outOfScope },
    ];
    const nowWith = (
        outOfScope: Validated['checks'][number]['verdict']['outOfScope'],
    ): Validated => {
        const outcome = now([]);
        outcome.checks[0].verdict.outOfScope = outOfScope;
        return outcome;
    };
    const changes = (result: BusinessValidationOutcome) => {
        if (result.kind !== 'validated') throw new Error('expected validated');
        return result.checks[0].verdict.outOfScope ?? [];
    };

    // The judge words the same change differently on every run.
    it('keeps the acceptance when the change is reworded on the same files', () => {
        const result = carryOver(
            nowWith([
                {
                    change: 'Caches refund lookups in Redis',
                    evidence: [{ file: 'src/refunds/cache.ts' }],
                },
            ]),
            beforeWith([
                {
                    change: 'Adds a Redis cache in front of refunds',
                    evidence: [{ file: 'src/refunds/cache.ts' }],
                    accepted,
                },
            ]),
        );
        expect(changes(result)[0].accepted).toMatchObject({ by: 'nina' });
    });

    // Two changes on one file, both reworded: which one was accepted cannot
    // be told, so neither inherits it.
    it('never guesses between two reworded changes on the same files', () => {
        const file = [{ file: 'src/refunds/cache.ts' }];
        const result = carryOver(
            nowWith([
                { change: 'Caches refund lookups in Redis', evidence: file },
                { change: 'Logs every cache miss', evidence: file },
            ]),
            beforeWith([
                {
                    change: 'Adds a Redis cache in front of refunds',
                    evidence: file,
                    accepted,
                },
                { change: 'Adds a debug log', evidence: file },
            ]),
        );
        expect(changes(result).map((c) => c.accepted)).toEqual([
            undefined,
            undefined,
        ]);
    });

    // As before this matcher: the judge listing the accepted change twice
    // shows both as accepted.
    it('keeps the acceptance on every change with the accepted text', () => {
        const file = [{ file: 'src/refunds/cache.ts' }];
        const result = carryOver(
            nowWith([
                { change: 'Adds a Redis cache', evidence: file },
                { change: 'Adds a Redis cache', evidence: [] },
            ]),
            beforeWith([
                { change: 'Adds a Redis cache', evidence: file, accepted },
            ]),
        );
        expect(changes(result).map((c) => c.accepted?.by)).toEqual([
            'nina',
            'nina',
        ]);
    });

    it('leaves a verdict with no out-of-scope list without one', () => {
        const outcome = now([]);
        delete (outcome.checks[0].verdict as { outOfScope?: unknown })
            .outOfScope;
        expect(
            changes(
                carryOver(
                    outcome,
                    beforeWith([
                        { change: 'Adds a cache', evidence: [], accepted },
                    ]),
                ),
            ),
        ).toEqual([]);
    });

    it('never moves an acceptance to a change on another file', () => {
        const result = carryOver(
            nowWith([
                {
                    change: 'Caches order lookups in Redis',
                    evidence: [{ file: 'src/orders/cache.ts' }],
                },
            ]),
            beforeWith([
                {
                    change: 'Adds a Redis cache in front of refunds',
                    evidence: [{ file: 'src/refunds/cache.ts' }],
                    accepted,
                },
            ]),
        );
        expect(changes(result)[0].accepted).toBeUndefined();
    });
});

describe('matchOutOfScope', () => {
    const change = (text: string, ...files: string[]) => ({
        change: text,
        evidence: files.map((file) => ({ file })),
    });

    it('takes the exact text first, each earlier change once', () => {
        expect(
            matchOutOfScope(
                [change('A', 'x.ts'), change('A', 'x.ts'), change('B')],
                [change('A', 'x.ts'), change('B'), change('A', 'x.ts')],
            ),
        ).toEqual([0, 2, 1]);
    });

    it('then a reworded change on the same set of files, in any order', () => {
        expect(
            matchOutOfScope(
                [change('Caches refunds', 'b.ts', 'a.ts', 'a.ts')],
                [change('Adds a cache', 'a.ts', 'b.ts')],
            ),
        ).toEqual([0]);
    });

    it('only when that set of files is cited once on each side', () => {
        expect(
            matchOutOfScope(
                [change('One', 'a.ts'), change('Two', 'a.ts')],
                [change('Uno', 'a.ts')],
            ),
        ).toEqual([undefined, undefined]);
        expect(
            matchOutOfScope(
                [change('One', 'a.ts')],
                [change('Uno', 'a.ts'), change('Dos', 'a.ts')],
            ),
        ).toEqual([undefined]);
    });

    it('takes the earlier change on those files, not the first one left', () => {
        expect(
            matchOutOfScope(
                [change('One', 'a.ts')],
                [change('Other', 'b.ts'), change('Uno', 'a.ts')],
            ),
        ).toEqual([1]);
    });

    it('counts only what the exact text left unmatched', () => {
        expect(
            matchOutOfScope(
                [change('Kept', 'a.ts'), change('Reworded', 'a.ts')],
                [change('Kept', 'a.ts'), change('Original', 'a.ts')],
            ),
        ).toEqual([0, 1]);
    });

    it('never matches by files a change that cites none, or another set', () => {
        expect(matchOutOfScope([change('New')], [change('Old')])).toEqual([
            undefined,
        ]);
        expect(
            matchOutOfScope(
                [change('New', 'a.ts', 'b.ts')],
                [change('Old', 'a.tsb.ts')],
            ),
        ).toEqual([undefined]);
        expect(
            matchOutOfScope([change('New', 'a.ts')], [change('Old', 'b.ts')]),
        ).toEqual([undefined]);
    });

    it('never gives one earlier change to two', () => {
        expect(
            matchOutOfScope(
                [change('Same'), change('Reworded', 'a.ts')],
                [change('Same', 'a.ts')],
            ),
        ).toEqual([0, undefined]);
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

    it('never matches a requirement with its negation', () => {
        expect(
            matchPrevious(
                ['Members must not export reports'],
                ['Members must export reports'],
            ),
        ).toEqual([undefined]);
    });

    it('matches repeated texts one to one', () => {
        expect(
            matchPrevious(
                ['Logs the event', 'Logs the event'],
                ['Logs the event', 'Logs the event'],
            ),
        ).toEqual([0, 1]);
    });
});

describe('carryOver when the task changed', () => {
    it('never moves an acceptance onto a requirement the edited task reworded', () => {
        const ordersTask = {
            ...TASK,
            description: 'Show the export button on the orders page.',
        };
        const accepted: RunTask[] = [
            {
                ...before[0],
                textHash: taskTextHash(ordersTask),
                requirements: [
                    {
                        requirement:
                            'The export button is shown on the orders page',
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
            now(
                [
                    {
                        requirement:
                            'The export button is shown on the invoices page',
                        state: 'missing',
                        evidence: [],
                        confidence: 'high',
                    },
                ],
                {
                    ...TASK,
                    description: 'Show the export button on the invoices page.',
                },
            ),
            accepted,
        );
        if (result.kind !== 'validated') throw new Error('expected validated');
        expect(
            result.checks[0].verdict.requirements![0].accepted,
        ).toBeUndefined();
    });
});
