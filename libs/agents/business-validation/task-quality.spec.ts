import {
    applyCriteriaLocation,
    canJudgeAgainst,
    gradeTask,
} from './task-quality';

const grade = (title: string, description = '') =>
    gradeTask({ tracker: 'Git Issues', id: '#7', title, description });

describe('gradeTask', () => {
    it('asks for criteria when a short description says no more than the title', () => {
        expect(grade('Improve tickets', 'Make tickets better.')).toBe(
            'MINIMAL',
        );
        expect(canJudgeAgainst(grade('Export recipes'))).toBe(false);
    });

    it('judges a title with a description that says what to do', () => {
        expect(
            grade(
                'Add a logout button',
                'Put it in the header, next to the avatar.',
            ),
        ).toBe('PARTIAL');
    });

    it('judges criteria however short the rest is', () => {
        expect(grade('Tickets', '- Sort by date\n- Hide closed')).toBe(
            'COMPLETE',
        );
    });
});

describe('applyCriteriaLocation, detecting automatically', () => {
    const task = {
        tracker: 'Jira',
        id: 'GE-75',
        title: 'Priority filter',
        description:
            'Agents need it.\n\n## Notes\n- Agents asked for this in the survey.\n- Mobile is a separate task.',
        fields: {
            'Acceptance Criteria':
                '* The filter defaults to All.\n* The priority is kept in the URL.',
        },
    };

    it('reads a field named for criteria, not the notes in the description', () => {
        expect(
            applyCriteriaLocation(task, { location: 'auto' })
                .acceptanceCriteria,
        ).toEqual([
            'The filter defaults to All.',
            'The priority is kept in the URL.',
        ]);
    });

    it('still reads the description list when no field is named for criteria', () => {
        expect(
            applyCriteriaLocation(
                { ...task, fields: { Team: 'Support' } },
                { location: 'auto' },
            ).acceptanceCriteria,
        ).toEqual([
            'Agents asked for this in the survey.',
            'Mobile is a separate task.',
        ]);
    });
});
