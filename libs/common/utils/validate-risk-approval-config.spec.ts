import validateKodusConfigFile, {
    getDefaultKodusConfigFile,
    validateRiskApprovalSettings,
} from './validateCodeReviewConfigFile';

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
    { riskCriteria: [{ id: 'kodus-securty', enabled: false }] },
    { riskReviewRouting: { riskFound: 'light' } },
])(
    'rejects the same ambiguous or invalid contract as the settings API: %j',
    (over) => {
        const result = check(over);
        expect(result).not.toHaveLength(0);
    },
);
it('accepts a Kodus default rule turned off or edited by id in the YAML file', () => {
    const riskCriteria = [
        { id: 'kodus-shared-contract', enabled: false },
        {
            id: 'kodus-ci-build',
            enabled: true,
            includedFiles: ['.github/workflows/release*.yml'],
        },
    ];
    // The shipped file has unrelated drift; only the risk errors matter here.
    const riskErrors = (criteria: unknown) =>
        (
            validateKodusConfigFile({
                ...(getDefaultKodusConfigFile() as object),
                version: '1.2',
                riskCriteria: criteria,
            }).validationErrors ?? []
        ).filter((error) => error.instancePath.startsWith('/riskCriteria'));
    expect(check({ riskCriteria })).toEqual([]);
    expect(riskErrors(riskCriteria)).toEqual([]);
    expect(riskErrors([{ id: 'tenant', enabled: true }])).not.toEqual([]);
});
