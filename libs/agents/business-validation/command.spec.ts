import { commandArgument, inlineTask, replyFor } from './command';
import { gradeTask, canJudgeAgainst } from './task-quality';

describe('commandArgument', () => {
    it('reads what follows the command', () => {
        expect(commandArgument('@kody -v business-logic PROJ-42')).toBe(
            'PROJ-42',
        );
        expect(commandArgument('@kody -v business-logic')).toBeUndefined();
        expect(commandArgument(undefined)).toBeUndefined();
    });

    it("does not read Kody's own command text from a quote the comment opens with", () => {
        const footer =
            '> Fixed it? Comment `@kody -v business-logic` and this comment is updated.';
        expect(
            commandArgument(`${footer}\n\n@kody -v business-logic`),
        ).toBeUndefined();
        expect(
            commandArgument(
                `> or run \`@kody -v business-logic\` followed by the task id (\`#123\`)\r\n\r\n@kody -v business-logic PROJ-42`,
            ),
        ).toBe('PROJ-42');
        expect(
            commandArgument(
                '>>>\nFixed it? Comment `@kody -v business-logic` and this comment is updated.\n>>>\n\n@kody -v business-logic',
            ),
        ).toBeUndefined();
    });

    it('keeps a quote placed after the command', () => {
        expect(
            commandArgument('@kody -v business-logic PROJ-42\n> context'),
        ).toBe('PROJ-42\n> context');
    });
});

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

    it('says the comment was updated, and with what, when the result changed', () => {
        const reply = replyFor(validated, 'updated', true);
        expect(reply).toMatch(/result changed/);
        expect(reply).toMatch(/SAA-96 met/);
        expect(reply).toMatch(/is updated/);
    });

    it('claims nothing about the result when there was no earlier run to compare with', () => {
        const reply = replyFor(validated, 'updated', undefined);
        expect(reply).toMatch(/is updated/);
        expect(reply).not.toMatch(/changed|same result/);
    });

    it('says the result is the same, not that anything was updated, when nothing changed (#2423)', () => {
        const reply = replyFor(
            { ...validated, passed: false },
            'updated',
            false,
        );
        expect(reply).toMatch(/same result as before/);
        expect(reply).toMatch(/SAA-96 has open requirements/);
        expect(reply).not.toMatch(/updated/);
    });

    // QA of #2681 on GitLab: AC3 PARTIAL, the run passed (PARTIAL does not
    // fail a task), and the reply said "#1 met".
    it('does not call a task met while a requirement is partial', () => {
        const requirement = (state: string, accepted?: object) => ({
            requirement: `AC ${state}`,
            state,
            evidence: [],
            confidence: 'high',
            ...(accepted ? { accepted } : {}),
        });
        const withRequirements = (...requirements: object[]) =>
            ({
                kind: 'validated',
                passed: true,
                checks: [
                    {
                        task: { id: '#1' },
                        verdict: { requirements },
                        passed: true,
                    },
                ],
            }) as any;

        const partial = withRequirements(
            requirement('met'),
            requirement('partial'),
            requirement('partial'),
        );
        expect(replyFor(partial, 'updated', true)).toMatch(
            /#1 has 2 partial requirements and none missing/,
        );
        expect(replyFor(partial, 'updated', true)).not.toMatch(/\bmet\b/);
        expect(
            replyFor(
                withRequirements(requirement('met'), requirement('partial')),
                'none',
            ),
        ).toBe(
            'Business logic re-checked: #1 has 1 partial requirement and none missing.',
        );

        const accepted = withRequirements(
            requirement('met'),
            requirement('partial', { by: 'nina' }),
        );
        expect(replyFor(accepted, 'none')).toBe(
            'Business logic re-checked: #1 met.',
        );
    });

    // A PR that says it is part of a task passes with requirements missing
    // (`taskPasses`, UC-18): the reply says they are missing, never "none".
    it('names the missing requirements of a task the PR is part of', () => {
        const requirement = (state: string) => ({
            requirement: `AC ${state}`,
            state,
            evidence: [],
            confidence: 'high',
        });
        const partOf = (...states: string[]) =>
            ({
                kind: 'validated',
                passed: true,
                checks: [
                    {
                        task: { id: '#1' },
                        reference: { intent: 'part_of' },
                        verdict: { requirements: states.map(requirement) },
                        passed: true,
                    },
                ],
            }) as any;

        expect(replyFor(partOf('met', 'missing'), 'none')).toBe(
            'Business logic re-checked: #1 has 1 missing requirement, not failed because the pull request is part of the task.',
        );
        expect(replyFor(partOf('missing', 'missing', 'partial'), 'none')).toBe(
            'Business logic re-checked: #1 has 2 missing and 1 partial requirements, not failed because the pull request is part of the task.',
        );
        expect(replyFor(partOf('met', 'met'), 'none')).toBe(
            'Business logic re-checked: #1 met.',
        );
    });
});
