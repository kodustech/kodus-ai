import { taskPasses } from './check-policy';
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
        expect(taskPasses(verdict([req('missing')]), 'closes')).toBe(false);
        expect(taskPasses(verdict([req('check_manually')]), 'closes')).toBe(
            true,
        );
    });

    it('never fails on PARTIAL or NOT IN TASK: both are shown, not left to fix', () => {
        expect(taskPasses(verdict([req('partial')]), 'closes')).toBe(true);
        expect(
            taskPasses(
                verdict([req('met')], [{ change: 'pagination', evidence: [] }]),
                'closes',
            ),
        ).toBe(true);
    });

    it('does not fail a PR that says it is part of the task for what it leaves out', () => {
        expect(taskPasses(verdict([req('missing')]), 'part_of')).toBe(true);
    });

    it('does not count a requirement a reviewer accepted', () => {
        const accepted = req('missing', {
            accepted: { by: 'nina', at: '2026-10-05T00:00:00Z' },
        });
        expect(taskPasses(verdict([accepted]), 'closes')).toBe(true);
    });

    it('fails a PR whose diff works on another domain', () => {
        expect(
            taskPasses(
                { ...verdict([req('met')]), scopeMismatch: true },
                'closes',
            ),
        ).toBe(false);
    });
});
