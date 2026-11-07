import {
    migratedReviewSettings,
    migratedReviewLayer,
    resolveReviewSettings,
} from './migrate-review-settings';
const defaults = {
    riskAssessmentActive: false,
    riskCriteria: [],
    approvalPolicies: [],
    pullRequestApprovalActive: false,
    approvalRiskActive: false,
};

it('preserves unrestricted legacy approval as one enabled policy without changing its master switch', () => {
    const settings = migratedReviewSettings(
        { ...defaults, pullRequestApprovalActive: true },
        { pullRequestApprovalActive: true },
    );
    expect(settings.approvalPolicies).toEqual([
        expect.objectContaining({ enabled: true, labels: [], authors: [] }),
    ]);
    expect(settings.riskAssessmentActive).toBe(false);
});
it('preserves effective legacy risk before independent defaults and carries its team guidance', () => {
    const saved = {
        pullRequestApprovalActive: true,
        approvalRiskActive: true,
        approvalRiskInstructions: 'Check access changes.',
    };
    expect(
        migratedReviewSettings({ ...defaults, ...saved }, saved),
    ).toMatchObject({
        riskAssessmentActive: true,
        riskCriteria: [
            { instructions: 'Check access changes.', enabled: true },
        ],
    });
});
it('does not introduce a risk call for a legacy organization whose approval was off', () => {
    expect(
        migratedReviewSettings({
            pullRequestApprovalActive: false,
            approvalRiskActive: true,
        }).riskAssessmentActive,
    ).toBe(false);
});
it('keeps a new independent risk choice when approval is off and respects explicit empty policies', () => {
    expect(
        migratedReviewSettings({
            riskAssessmentActive: true,
            pullRequestApprovalActive: false,
            approvalPolicies: [],
        }),
    ).toMatchObject({ riskAssessmentActive: true, approvalPolicies: [] });
});
it('preserves an explicitly selected Heavy review as the legacy default mapping', () => {
    expect(
        migratedReviewSettings({ reviewMode: 'heavy' }).riskReviewRouting,
    ).toEqual({ noRisk: 'heavy', riskFound: 'heavy' });
});
it('resolves each scope without freezing policy arrays in storage', () => {
    const global = {
        pullRequestApprovalActive: true,
        approvalRiskActive: true,
        approvalLabels: ['ready'],
        approvalAuthors: ['alice'],
    };
    const repository = { approvalAuthors: ['bot'] };
    const directory = { approvalRiskActive: false };
    const result = resolveReviewSettings(
        defaults,
        global,
        repository,
        directory,
    );
    expect(result.approvalPolicies).toEqual([
        expect.objectContaining({ labels: ['ready'], authors: ['bot'] }),
    ]);
    expect(result.riskAssessmentActive).toBe(false);
    expect(
        migratedReviewLayer(defaults, [global, repository], directory)
            ?.riskAssessmentActive,
    ).toBe(false);
    expect(global).not.toHaveProperty('approvalPolicies');
    expect(repository).not.toHaveProperty('approvalPolicies');
});

it('preserves higher legacy label and author aliases over a migrated stored policy', () => {
    const migrated = resolveReviewSettings(defaults, {
        pullRequestApprovalActive: true,
    });
    const result = resolveReviewSettings(
        defaults,
        migrated,
        { approvalLabels: ['ready'] },
        { approvalAuthors: ['bot'] },
    );
    expect(result.approvalPolicies).toEqual([
        expect.objectContaining({ labels: ['ready'], authors: ['bot'] }),
    ]);
});

it('rejects an ambiguous legacy restriction rather than dropping it from a new named policy list', () => {
    expect(() =>
        resolveReviewSettings(
            defaults,
            { approvalPolicies: [{ id: 'docs', name: 'Docs', enabled: true }] },
            { approvalLabels: ['ready'] },
        ),
    ).toThrow('Legacy approval filters');
});

it('lets an explicit named list own the aliases remaining in its same source', () => {
    const policy = {
        id: 'docs',
        name: 'Docs',
        enabled: true,
        labels: ['new-label'],
    };
    expect(
        resolveReviewSettings(defaults, {
            approvalLabels: ['old-label'],
            approvalPolicies: [policy],
        }).approvalPolicies,
    ).toEqual([policy]);
});

it.each([
    [
        { riskAssessmentActive: false, pullRequestApprovalActive: true },
        { approvalRiskActive: true },
        true,
    ],
    [
        { riskAssessmentActive: true, pullRequestApprovalActive: true },
        { approvalRiskActive: false },
        false,
    ],
    [
        { riskAssessmentActive: true },
        { pullRequestApprovalActive: false },
        true,
    ],
    [
        { approvalRiskActive: true, pullRequestApprovalActive: true },
        { pullRequestApprovalActive: false },
        false,
    ],
])(
    'applies the last explicit risk flag with its independent or legacy meaning',
    (parent, child, active) => {
        expect(
            resolveReviewSettings(defaults, parent as object, child as object)
                .riskAssessmentActive,
        ).toBe(active);
    },
);

it('does not erase a repository-file label when deriving a directory author override for the UI', () => {
    const global = {
        approvalPolicies: [
            {
                id: 'legacy-approval',
                name: 'Existing approval policy',
                enabled: true,
            },
        ],
    };
    const file = { approvalLabels: ['ready'] };
    const dir = { approvalAuthors: ['bot'] };
    const view = migratedReviewLayer(defaults, [global, file], dir);
    expect(view?.approvalPolicies).toEqual([
        expect.objectContaining({ labels: ['ready'], authors: ['bot'] }),
    ]);
});
