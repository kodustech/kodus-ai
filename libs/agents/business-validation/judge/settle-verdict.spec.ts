import { settleVerdict } from './settle-verdict';
import type { RequirementVerdict, ValidationResult } from './validation.types';

const requirement = (
    overrides: Partial<RequirementVerdict>,
): RequirementVerdict => ({
    requirement: 'Defaults to comfortable',
    state: 'missing',
    evidence: [],
    confidence: 'high',
    ...overrides,
});

const result = (requirements: RequirementVerdict[]): ValidationResult => ({
    needsMoreInfo: false,
    summary: '',
    requirements,
});

describe('settleVerdict', () => {
    it('keeps a confident gap the judge could see', () => {
        const settled = settleVerdict(result([requirement({})]), {
            unseenFiles: [],
        });
        expect(settled.requirements?.[0].state).toBe('missing');
        expect(settled.status).toBe('issues_found');
    });

    it('turns a low-confidence gap into CHECK MANUALLY (UC-31)', () => {
        const settled = settleVerdict(
            result([requirement({ confidence: 'low' })]),
            { unseenFiles: [] },
        );
        expect(settled.requirements?.[0]).toMatchObject({
            state: 'check_manually',
            judgedState: 'missing',
            downgraded: 'low_confidence',
        });
        expect(settled.status).toBe('compliant');
    });

    it('turns a visual or flow gap into CHECK MANUALLY (UC-30)', () => {
        const settled = settleVerdict(
            result([requirement({ state: 'partial', kind: 'visual' })]),
            { unseenFiles: [] },
        );
        expect(settled.requirements?.[0]).toMatchObject({
            state: 'check_manually',
            downgraded: 'visual',
        });
    });

    it('keeps a flow gap the judge is sure of and pins to code', () => {
        const sure = requirement({
            kind: 'flow',
            confidence: 'high',
            evidence: [{ file: 'src/archive.ts', line: 3 }],
        });
        expect(
            settleVerdict(result([sure]), { unseenFiles: [] })
                .requirements?.[0],
        ).toMatchObject({ state: 'missing' });
        const unpinned = requirement({
            kind: 'flow',
            confidence: 'high',
            evidence: [],
        });
        expect(
            settleVerdict(result([unpinned]), { unseenFiles: [] })
                .requirements?.[0],
        ).toMatchObject({ state: 'check_manually', downgraded: 'visual' });
    });

    it('does not call MISSING what may live in a file the judge never saw (UC-32)', () => {
        const settled = settleVerdict(result([requirement({})]), {
            unseenFiles: ['src/huge.ts'],
        });
        expect(settled.requirements?.[0]).toMatchObject({
            state: 'check_manually',
            downgraded: 'not_in_diff',
        });
    });

    it('leaves MET and a result without a requirement list alone', () => {
        const met = requirement({ state: 'met', confidence: 'low' });
        expect(
            settleVerdict(result([met]), { unseenFiles: ['x'] }).requirements,
        ).toEqual([met]);
        const prose: ValidationResult = { needsMoreInfo: false, summary: 'ok' };
        expect(settleVerdict(prose, { unseenFiles: [] })).toBe(prose);
    });
});

describe('settleVerdict · work handled elsewhere', () => {
    const marked = (
        note: string,
        input: { subtasks?: boolean; teamGuidance?: boolean },
        extra: Partial<RequirementVerdict> = {},
    ) =>
        settleVerdict(
            result([requirement({ state: 'check_manually', note, ...extra })]),
            { unseenFiles: [], ...input },
        ).requirements![0].handledElsewhere;

    it("marks a sub-task's or the guidance's CHECK MANUALLY, so nothing re-judges it", () => {
        expect(
            marked('Delivered by PROJ-217: the template.', { subtasks: true }),
        ).toBe('sub_task');
        expect(
            marked('Team guidance: QA checks copy.', { teamGuidance: true }),
        ).toBe('team_guidance');
    });

    it('never marks it when the task has no sub-tasks or the team no guidance', () => {
        expect(
            marked('Delivered by PROJ-217: the template.', {
                teamGuidance: true,
            }),
        ).toBeUndefined();
        expect(
            marked('Team guidance: QA checks copy.', { subtasks: true }),
        ).toBeUndefined();
    });

    it("drops a mark the judge's note doesn't back, and any mark off a CHECK MANUALLY", () => {
        // A helper the judge couldn't see, pinned on someone else's work.
        expect(
            marked(
                'Left to assertRenewable, not in this diff.',
                { subtasks: true, teamGuidance: true },
                { handledElsewhere: 'team_guidance' },
            ),
        ).toBeUndefined();
        expect(
            settleVerdict(
                result([
                    requirement({
                        state: 'met',
                        handledElsewhere: 'sub_task',
                    }),
                ]),
                { unseenFiles: [], subtasks: true },
            ).requirements![0].handledElsewhere,
        ).toBeUndefined();
    });
});
