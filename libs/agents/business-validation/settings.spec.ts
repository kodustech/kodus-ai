import { resolveBusinessLogicSettings } from './settings';
import { applyCriteriaLocation } from './task-quality';

describe('resolveBusinessLogicSettings', () => {
    it("keeps today's behavior with nothing configured (UC-44)", () => {
        expect(resolveBusinessLogicSettings(undefined)).toEqual({
            taskSource: 'auto',
            criteria: { location: 'auto' },
            failOn: ['missing'],
            commentWhenMet: false,
            recheckOnPush: false,
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
                recheckOnPush: true,
            }),
        ).toMatchObject({
            taskSource: 'azure-plugin',
            taskSourceTool: 'wit_work_item',
            criteria: { location: 'heading', heading: 'Acceptance criteria' },
            failOn: ['missing', 'partial'],
            teamGuidance: 'Ignore copy.',
            recheckOnPush: true,
        });
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

    it('leaves the task as is when that place is empty', () => {
        expect(
            applyCriteriaLocation(task, {
                location: 'heading',
                heading: 'Definition of done',
            }),
        ).toBe(task);
    });
});
