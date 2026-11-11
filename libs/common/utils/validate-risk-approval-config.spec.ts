import { validateRiskApprovalSettings } from './validateCodeReviewConfigFile';

const policy = {
    id: 'docs',
    name: 'Docs',
    enabled: false,
    includedFiles: ['src/**/*.{ts,tsx}'],
};
const criterion = {
    id: 'data',
    name: 'Data',
    enabled: true,
    instructions: 'Check irreversible data changes.',
    excludedFiles: ['**/*.test.ts'],
};
const check = (over: Record<string, unknown>) =>
    validateRiskApprovalSettings(over);
it('accepts named policies, optional criteria, array globs and a scoped routing delta in YAML', () => {
    expect(
        check({
            approvalPolicies: [policy],
            riskAssessmentActive: true,
            riskCriteria: [criterion],
            riskReviewRouting: { noRisk: 'heavy' },
        }),
    ).toEqual([]);
});
it.each([
    { approvalPolicies: [policy, policy] },
    { approvalPolicies: [policy, { ...policy, id: 'other', name: 'docs' }] },
    { approvalPolicies: [{ ...policy, includedFiles: ['!src/**'] }] },
    { approvalPolicies: [{ ...policy, excludedFiles: ['src/['] }] },
    { approvalPolicies: [{ ...policy, maxChangedLines: -1 }] },
    { riskCriteria: [criterion, criterion] },
    { riskCriteria: [{ ...criterion, instructions: '   ' }] },
    { riskReviewRouting: { riskFound: 'light' } },
])(
    'rejects the same ambiguous or invalid contract as the settings API: %j',
    (over) => {
        const result = check(over);
        expect(result).not.toHaveLength(0);
    },
);
