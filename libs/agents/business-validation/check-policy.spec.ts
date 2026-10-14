import { taskPasses } from './check-policy';
import { FAIL_ON_STATES, type FailOnState } from './settings';
import type {
    RequirementVerdict,
    ValidationResult,
} from './judge/validation.types';

const req = (
    state: RequirementVerdict['state'],
    extra: Partial<RequirementVerdict> = {},
): RequirementVerdict => ({
    requirement: state,
    state,
    evidence: [],
    confidence: 'high',
    ...extra,
});

const verdict = (
    requirements: RequirementVerdict[],
    outOfScope: ValidationResult['outOfScope'] = [],
): ValidationResult => ({
    needsMoreInfo: false,
    summary: '',
    requirements,
    outOfScope,
});

describe('taskPasses (UC-09, UC-18)', () => {
    it('fails on MISSING by default, and never on CHECK MANUALLY', () => {
        expect(
            taskPasses(verdict([req('missing')]), ['missing'], 'closes'),
        ).toBe(false);
        expect(
            taskPasses(verdict([req('check_manually')]), ['missing'], 'closes'),
        ).toBe(true);
    });

    it('fails on PARTIAL and NOT IN TASK only when the team says so', () => {
        const partial = verdict([req('partial')]);
        expect(taskPasses(partial, ['missing'], 'closes')).toBe(true);
        expect(taskPasses(partial, ['missing', 'partial'], 'closes')).toBe(
            false,
        );

        const extra = verdict(
            [req('met')],
            [{ change: 'pagination', evidence: [] }],
        );
        expect(taskPasses(extra, ['missing'], 'closes')).toBe(true);
        expect(taskPasses(extra, ['not_in_task'], 'closes')).toBe(false);
    });

    it('does not fail a PR that says it is part of the task for what it leaves out', () => {
        expect(
            taskPasses(verdict([req('missing')]), ['missing'], 'part_of'),
        ).toBe(true);
    });

    it('does not count a requirement a reviewer accepted', () => {
        const accepted = req('missing', {
            accepted: { by: 'nina', at: '2026-10-05T00:00:00Z' },
        });
        expect(taskPasses(verdict([accepted]), ['missing'], 'closes')).toBe(
            true,
        );
    });

    it('fails a PR whose diff works on another domain', () => {
        expect(
            taskPasses(
                { ...verdict([req('met')]), scopeMismatch: true },
                ['missing'],
                'closes',
            ),
        ).toBe(false);
    });
});

describe('taskPasses for every "fails on" choice on the settings page', () => {
    const choices: FailOnState[][] = [[]];
    for (const state of FAIL_ON_STATES) {
        for (const choice of [...choices]) {
            choices.push([...choice, state]);
        }
    }

    // One finding per case, and the box that would make it fail, if any.
    const findings: Array<{
        name: string;
        verdict: ValidationResult;
        failsWith?: FailOnState;
        slicesOut?: boolean;
    }> = [
        { name: 'MET', verdict: verdict([req('met')]) },
        {
            name: 'CHECK MANUALLY',
            verdict: verdict([req('check_manually')]),
        },
        {
            name: 'MISSING a reviewer accepted',
            verdict: verdict([
                req('missing', { accepted: { by: 'ana', at: 'x' } }),
            ]),
        },
        {
            name: 'MISSING',
            verdict: verdict([req('missing')]),
            failsWith: 'missing',
            slicesOut: true,
        },
        {
            name: 'PARTIAL',
            verdict: verdict([req('partial')]),
            failsWith: 'partial',
            slicesOut: true,
        },
        {
            name: 'NOT IN TASK',
            verdict: verdict(
                [req('met')],
                [{ change: 'Export ungated', evidence: [] }],
            ),
            failsWith: 'not_in_task',
        },
    ];

    for (const failOn of choices) {
        for (const finding of findings) {
            for (const intent of ['closes', 'part_of'] as const) {
                const fails =
                    !!finding.failsWith &&
                    failOn.includes(finding.failsWith) &&
                    !(intent === 'part_of' && finding.slicesOut);
                it(`[${failOn.join('+') || 'nothing'}] ${finding.name}, ${intent} → ${fails ? 'fails' : 'passes'}`, () => {
                    expect(taskPasses(finding.verdict, failOn, intent)).toBe(
                        !fails,
                    );
                });
            }
        }
    }
});
