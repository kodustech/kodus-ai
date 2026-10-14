import { canJudgeAgainst, gradeTask } from './task-quality';

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
