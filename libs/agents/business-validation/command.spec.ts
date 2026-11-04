import { inlineTask, replyFor } from './command';
import { gradeTask, canJudgeAgainst } from './task-quality';

describe('inlineTask', () => {
    it('judges a task written in the command even when it is shorter than a tracker description', () => {
        const text = 'Unassigned tickets never show the assigned badge';
        expect(text.length).toBeLessThan(80);
        const task = inlineTask(text, []);
        expect(task?.title).toBe(text);
        expect(canJudgeAgainst(gradeTask(task!))).toBe(true);
    });

    it('is not a task when it is too short or the command named one', () => {
        expect(inlineTask('fix it', [])).toBeUndefined();
        expect(
            inlineTask('Unassigned tickets never show the assigned badge', [
                { source: 'command' } as any,
            ]),
        ).toBeUndefined();
    });
});

describe('replyFor', () => {
    it('never points at a check: the comment is the only signal', () => {
        const reply = replyFor(
            {
                kind: 'validated',
                checks: [{ task: { id: 'SAA-96' } }],
                passed: true,
            } as any,
            'none',
        );
        expect(reply).toBe('Business logic re-checked: SAA-96 met.');
        expect(reply).not.toMatch(/kody\/business-logic/);
    });

    const validated = {
        kind: 'validated',
        checks: [{ task: { id: 'SAA-96' } }],
        passed: true,
    } as any;

    it('says the comment was posted on the first run, not updated', () => {
        const reply = replyFor(validated, 'created');
        expect(reply).not.toMatch(/updated/);
        expect(reply).toMatch(/Kody · Business Logic comment/);
    });

    it('says the comment was updated when an earlier run left one', () => {
        expect(replyFor(validated, 'updated')).toMatch(/is updated/);
    });
});
