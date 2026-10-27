import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    approvalPolicyForPlatform,
    evaluateApproval,
    evaluateReviewedHeadApproval,
} from './approval-decision';

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

it('ignores inherited label restrictions on Bitbucket while keeping author scope', () => {
    const policy = approvalPolicyForPlatform(
        { labels: ['ready'], authors: ['alice'] },
        PlatformType.BITBUCKET,
    );
    expect(evaluateApproval({ ...base, labels: undefined, policy }).kind).toBe(
        'approve',
    );
    expect(evaluateApproval({ ...base, author: 'bob', policy }).kind).toBe(
        'out-of-scope',
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

it('requires a person for unknown or elevated risk and respects the master toggle', () => {
    const policy = { assessRisk: true };
    expect(
        evaluateApproval({ ...base, approvalActive: false, policy }).kind,
    ).toBe('disabled');

    for (const level of ['unknown', 'medium', 'high'] as const) {
        expect(
            evaluateApproval({
                ...base,
                policy,
                risk: {
                    level,
                    reason: `${level} risk`,
                    reviewedHeadSha: base.currentHeadSha,
                },
            }).kind,
        ).toBe('hold');
    }
});

// Risk assessment turned on after a head was reviewed: the decision Kody made
// under the policy of that review stands, and the next commit is assessed.
describe('evaluateReviewedHeadApproval', () => {
    const base = {
        approvalActive: true,
        policy: { labels: ['ready'], assessRisk: true },
        labels: ['ready'],
        changedPaths: ['src/a.ts'],
        reviewClean: true,
        currentHeadSha: 'head-1',
    };

    it('keeps an approval Kody gave while risk assessment was off', () => {
        expect(
            evaluateReviewedHeadApproval({
                ...base,
                reviewedDecision: { kind: 'approve' },
            }).kind,
        ).toBe('approve');
    });

    it('still holds a kept approval when a sensitive path or the scope changed', () => {
        expect(
            evaluateReviewedHeadApproval({
                ...base,
                policy: { ...base.policy, sensitivePaths: ['src/**'] },
                reviewedDecision: { kind: 'approve' },
            }).kind,
        ).toBe('hold');
        expect(
            evaluateReviewedHeadApproval({
                ...base,
                labels: [],
                reviewedDecision: { kind: 'approve' },
            }).kind,
        ).toBe('out-of-scope');
    });

    it('says the next commit is assessed when an unapproved head has no assessment', () => {
        const decision = evaluateReviewedHeadApproval({
            ...base,
            reviewedDecision: { kind: 'out-of-scope' },
        });
        expect(decision.kind).toBe('hold');
        expect(decision.reason).toContain('next commit');
    });

    it('judges the saved assessment when the head has one', () => {
        expect(
            evaluateReviewedHeadApproval({
                ...base,
                risk: {
                    level: 'high',
                    reason: 'Touches billing.',
                    reviewedHeadSha: 'head-1',
                } as any,
                reviewedDecision: { kind: 'approve' },
            }).reason,
        ).toBe('Touches billing.');
    });
});
