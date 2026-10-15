import { resolveBusinessLogicSettings } from './settings';
import { applyCriteriaLocation } from './task-quality';

describe('resolveBusinessLogicSettings', () => {
    it("keeps today's behavior with nothing configured (UC-44)", () => {
        expect(resolveBusinessLogicSettings(undefined)).toEqual({
            taskSource: 'auto',
            criteria: { location: 'auto' },
            failOn: ['missing'],
            commentWhenMet: true,
            recheckOn: 'failing',
            requireTask: false,
        });
    });

    it('reads a chosen source, criteria location, fail states and guidance', () => {
        expect(
            resolveBusinessLogicSettings({
                taskSource: 'azure-plugin',
                taskSourceTool: 'wit_work_item',
                criteriaLocation: 'heading',
                criteriaHeading: 'Acceptance criteria',
                failOn: ['partial', 'bogus' as any, 'missing'],
                teamGuidance: '  Ignore copy.  ',
                recheckOn: 'push',
                requireTask: true,
            }),
        ).toMatchObject({
            taskSource: 'azure-plugin',
            taskSourceTool: 'wit_work_item',
            criteria: { location: 'heading', heading: 'Acceptance criteria' },
            failOn: ['missing', 'partial'],
            teamGuidance: 'Ignore copy.',
            recheckOn: 'push',
            requireTask: true,
        });
    });

    it('re-checks while failing when the stored value is unknown', () => {
        expect(
            resolveBusinessLogicSettings({ recheckOn: 'sometimes' as any })
                .recheckOn,
        ).toBe('failing');
    });

    it('falls back to auto when the heading or field is empty', () => {
        expect(
            resolveBusinessLogicSettings({
                criteriaLocation: 'field',
                criteriaField: ' ',
            }).criteria,
        ).toEqual({ location: 'auto' });
    });
});

describe("the team's task id pattern (#1884)", () => {
    it('keeps a pattern that is safe to run on every pull request', () => {
        expect(
            resolveBusinessLogicSettings({ taskIdPattern: 'sc-(\\d+)' })
                .taskIdPattern,
        ).toBe('sc-(\\d+)');
    });

    it('drops a pattern that could hang a review, or does not compile', () => {
        for (const taskIdPattern of ['(a+)+$', '([', 'x'.repeat(201), '   ']) {
            expect(
                resolveBusinessLogicSettings({ taskIdPattern }).taskIdPattern,
            ).toBeUndefined();
        }
    });
});

describe('applyCriteriaLocation (UC-05, UC-23)', () => {
    const task = {
        tracker: 'Jira',
        id: 'PLAT-1',
        description: [
            '## Context',
            'Teams asked for it.',
            '',
            '## Acceptance criteria',
            '- Exports as CSV',
            '- Includes archived notes',
            '',
            '## Notes',
            '- Not a requirement',
        ].join('\n'),
        fields: {
            'Acceptance Criteria':
                '1. Logs every export\n2. Limits to 10k rows',
        },
    };

    it('takes the list under the named heading', () => {
        expect(
            applyCriteriaLocation(task, {
                location: 'heading',
                heading: 'acceptance criteria',
            }).acceptanceCriteria,
        ).toEqual(['Exports as CSV', 'Includes archived notes']);
    });

    it('takes the list in the named field', () => {
        expect(
            applyCriteriaLocation(task, {
                location: 'field',
                field: 'Acceptance Criteria',
            }).acceptanceCriteria,
        ).toEqual(['Logs every export', 'Limits to 10k rows']);
    });

    it('detects the criteria as "Detect automatically" does when that place is not on the task', () => {
        const auto = applyCriteriaLocation(task, { location: 'auto' });
        expect(
            applyCriteriaLocation(task, {
                location: 'heading',
                heading: 'Definition of done',
            }).acceptanceCriteria,
        ).toEqual(auto.acceptanceCriteria);
        expect(
            applyCriteriaLocation(
                { ...task, fields: undefined },
                { location: 'field', field: 'Acceptance Criteria' },
            ).acceptanceCriteria,
        ).toEqual(
            applyCriteriaLocation(
                { ...task, fields: undefined },
                { location: 'auto' },
            ).acceptanceCriteria,
        );
    });

    describe('detected automatically', () => {
        const auto = { location: 'auto' } as const;

        it('takes the list under a criteria heading, not the other lists', () => {
            expect(
                applyCriteriaLocation({ ...task, fields: undefined }, auto)
                    .acceptanceCriteria,
            ).toEqual(['Exports as CSV', 'Includes archived notes']);
        });

        it('reads a heading in Portuguese, accents and all', () => {
            expect(
                applyCriteriaLocation(
                    {
                        tracker: 'Git Issues',
                        id: '#245',
                        description:
                            '## Contexto\nLinks de reset.\n\n### Critérios de aceite\n- O link expira em 15 minutos\n- O link vale uma vez só',
                    },
                    auto,
                ).acceptanceCriteria,
            ).toEqual([
                'O link expira em 15 minutos',
                'O link vale uma vez só',
            ]);
        });

        it("keeps the tracker's own criteria", () => {
            const fromTracker = {
                ...task,
                acceptanceCriteria: ['From the Jira field'],
            };
            expect(applyCriteriaLocation(fromTracker, auto)).toBe(fromTracker);
        });

        it('falls back to the list in the description, but not a single item', () => {
            expect(
                applyCriteriaLocation(
                    {
                        tracker: 'Linear',
                        id: 'SAA-1',
                        description: '- Drag to reorder\n- Order persists',
                    },
                    auto,
                ).acceptanceCriteria,
            ).toEqual(['Drag to reorder', 'Order persists']);
            const one = {
                tracker: 'Linear',
                id: 'SAA-2',
                description: 'Context.\n- See the design file',
            };
            expect(applyCriteriaLocation(one, auto)).toBe(one);
        });
    });
});
