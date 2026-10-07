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
