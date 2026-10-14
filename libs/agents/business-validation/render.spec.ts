import type { BusinessValidationOutcome } from './business-validation.types';
import { renderCheckTitle, renderCliText, renderComment } from './render';

type Validated = Extract<BusinessValidationOutcome, { kind: 'validated' }>;

const outcome = (
    overrides: Partial<Validated['checks'][number]> = {},
): Validated => ({
    kind: 'validated',
    checks: [
        {
            task: {
                tracker: 'Azure DevOps',
                id: 'AB#8',
                title: 'Compact density toggle',
                url: 'https://dev.azure.com/acme/_workitems/edit/8',
            },
            verdict: {
                needsMoreInfo: false,
                summary: '',
                requirements: [
                    {
                        requirement: 'Persists per user',
                        source: 'AC #1',
                        state: 'met',
                        evidence: [{ file: 'settings/density.ts', line: 14 }],
                        confidence: 'high',
                    },
                    {
                        requirement: 'Defaults to comfortable',
                        state: 'missing',
                        evidence: [{ file: 'density.ts', line: 6 }],
                        note: 'Sets "compact" as the default.',
                        action: 'Change it to "comfortable".',
                        confidence: 'high',
                    },
                    {
                        requirement: 'Toggle visible | in the toolbar',
                        state: 'check_manually',
                        evidence: [],
                        confidence: 'medium',
                        downgraded: 'visual',
                    },
                ],
                outOfScope: [
                    {
                        change: 'Changes list pagination size',
                        evidence: [{ file: 'TicketList.tsx', line: 88 }],
                    },
                ],
            },
            passed: false,
            readAt: '2026-10-05T12:00:00.000Z',
            ...overrides,
        },
    ],
    thinTasks: [],
    passed: false,
    unseenFiles: [],
});

describe('renderComment', () => {
    it('lists every requirement with its state, evidence and the action', () => {
        const body = renderComment(outcome(), {
            headSha: 'a41c9e2ff',
            trigger: 'command',
        });

        expect(body).toContain(
            '[AB#8 · Compact density toggle](https://dev.azure.com/acme/_workitems/edit/8)',
        );
        expect(body).toContain(
            'To merge: 1 missing requirement · 1 change not in the task · also open: 1 to check manually',
        );
        expect(body).toContain(
            '✅ **MET** | Persists per user <sub>AC #1</sub> | `settings/density.ts:14`',
        );
        expect(body).toContain('**Do:** Change it to "comfortable".');
        expect(body).toContain(
            '➕ **NOT IN TASK** | Changes list pagination size',
        );
        expect(body).toContain('re-checked on request at `a41c9e2`');
        // A pipe in a requirement would break the table.
        expect(body).toContain('Toggle visible \\| in the toolbar');
        // A backslash before a pipe must not undo its escape.
        const tricky = renderComment(
            outcome({
                verdict: {
                    needsMoreInfo: false,
                    summary: '',
                    requirements: [
                        {
                            requirement: 'Path C:\\temp\\| ends here',
                            state: 'missing',
                            evidence: [],
                            confidence: 'high',
                        },
                    ],
                    outOfScope: [],
                },
            }),
        );
        expect(tricky).toContain('Path C:\\\\temp\\\\\\| ends here');
    });

    it('says when the PR only delivers part of the task', () => {
        const body = renderComment(
            outcome({
                reference: {
                    kind: 'work_item',
                    id: '8',
                    raw: 'AB#8',
                    source: 'body',
                    intent: 'part_of',
                },
                passed: true,
            }),
        );
        expect(body).toContain('part of AB#8');
    });

    it('shows an accepted requirement with who accepted it and where it went', () => {
        const accepted = outcome();
        accepted.checks[0].verdict.requirements![1].accepted = {
            by: 'nina',
            movedTo: 'SAA-102',
            at: '2026-10-05T12:00:00.000Z',
        };
        expect(renderComment(accepted)).toContain(
            '☑️ **MISSING · ACCEPTED** | Defaults to comfortable | Accepted by @nina · moved to SAA-102',
        );
    });
});

describe('the trail of earlier commits', () => {
    it('shows how the PR got here, with the commit this check read', () => {
        const comment = renderComment(outcome(), {
            headSha: 'ccc3333ffff',
            trigger: 'push',
            history: [
                { headSha: 'aaa1111ffff', met: 1, total: 3, passed: false },
                { headSha: 'bbb2222ffff', met: 2, total: 3, passed: false },
            ],
        });
        expect(comment).toContain('re-checked after the push of `ccc3333`');
        expect(comment).toContain(
            'Earlier checks: `aaa1111` 1/3 met ✗ → `bbb2222` 2/3 met ✗',
        );
    });

    it('keeps the line short on a long-lived PR and leaves it out on the first check', () => {
        const history = Array.from({ length: 8 }, (_, i) => ({
            headSha: `${i}`.repeat(7),
            met: i,
            total: 8,
        }));
        const comment = renderComment(outcome(), { history });
        expect(comment).not.toContain('`2222222`');
        expect(comment).toContain('`3333333` 3/8 met → ');
        expect(renderComment(outcome())).not.toContain('Earlier checks');
    });
});

describe('renderCheckTitle and renderCliText', () => {
    it('names what blocks the merge', () => {
        expect(renderCheckTitle(outcome())).toBe(
            'AB#8: 1 requirement missing, 1 change not in the task',
        );
    });

    it('says the task is met and what to check by hand', () => {
        const met = outcome({ passed: true });
        met.passed = true;
        met.checks[0].verdict.requirements =
            met.checks[0].verdict.requirements!.filter(
                (r) => r.state !== 'missing',
            );
        met.checks[0].verdict.outOfScope = [];
        expect(renderCheckTitle(met)).toBe('AB#8 met · 1 to check manually');
    });

    it('prints one line per requirement for an agent to act on (UC-41)', () => {
        const text = renderCliText(outcome());
        expect(text).toContain(
            'MISSING        Defaults to comfortable density.ts:6',
        );
        expect(text).toContain('→ Change it to "comfortable".');
        expect(text).toContain('status: issues_found');
    });
});

describe('what the check fails on, as the comment and the check say it', () => {
    it('lists only what fails the check as to merge, and the rest as still open', () => {
        const comment = renderComment(outcome(), { failOn: ['not_in_task'] });
        expect(comment).toContain(
            'To merge: 1 change not in the task · also open: 1 missing requirement · 1 to check manually',
        );
        expect(renderCheckTitle(outcome(), ['not_in_task'])).toBe(
            'AB#8: 1 change not in the task',
        );
    });

    it('keeps CHECK MANUALLY out of what blocks the merge', () => {
        expect(renderComment(outcome(), { failOn: ['missing'] })).toContain(
            'To merge: 1 missing requirement · also open: 1 to check manually · 1 change not in the task',
        );
    });
});

describe('the check title when the check passes with findings left open', () => {
    it('never calls a task met when it passes only because nothing fails on what is open', () => {
        expect(renderCheckTitle(outcome({ passed: true }), [])).toBe(
            'Passes · open: AB#8: 1 requirement missing, 1 change not in the task',
        );
    });
});
