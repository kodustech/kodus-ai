import { evaluateApproval } from './approval-decision';

const base = {
    approvalActive: true,
    reviewClean: true,
    currentHeadSha: 'head-1',
    author: 'alice',
    labels: ['ready'],
    changedPaths: ['src/core.ts'],
};

it('preserves clean-review approval when no policy is configured', () => {
    expect(evaluateApproval(base).kind).toBe('approve');
    expect(evaluateApproval({ ...base, reviewClean: false }).kind).toBe('hold');
});

it('requires both configured scope groups and never bypasses findings', () => {
    const policy = { labels: ['ready'], authors: ['alice'] };
    expect(evaluateApproval({ ...base, policy }).kind).toBe('approve');
    expect(evaluateApproval({ ...base, labels: [], policy }).kind).toBe(
        'out-of-scope',
    );
    expect(evaluateApproval({ ...base, author: 'bob', policy }).kind).toBe(
        'out-of-scope',
    );
    expect(evaluateApproval({ ...base, reviewClean: false, policy }).kind).toBe(
        'hold',
    );
});

it('holds sensitive paths and stale or failed risk assessments', () => {
    const policy = { assessRisk: true, sensitivePaths: ['src/auth/**'] };
    const risk = {
        level: 'low' as const,
        reason: 'Narrow change with tests.',
        reviewedHeadSha: 'head-1',
    };
    expect(evaluateApproval({ ...base, policy, risk }).kind).toBe('approve');
    expect(
        evaluateApproval({
            ...base,
            policy,
            risk,
            changedPaths: ['src/auth/login.ts'],
        }).kind,
    ).toBe('hold');
    expect(
        evaluateApproval({
            ...base,
            policy,
            risk: { ...risk, reviewedHeadSha: 'old-head' },
        }).kind,
    ).toBe('hold');
    expect(evaluateApproval({ ...base, policy }).kind).toBe('hold');
    expect(
        evaluateApproval({
            ...base,
            policy: { sensitivePaths: ['src/auth/**'] },
            changedPaths: ['src/auth/login.ts'],
        }).kind,
    ).toBe('hold');
});
