import type { GateVerdict } from '@libs/code-review/domain/risk/pr-decision-graph-verdict';
import type { L3Verdict } from '@libs/code-review/domain/risk/pr-decision-reducer';
import type { ApprovalDecision } from '@libs/code-review/domain/approval/approval-decision';
import type { L3AssessInput } from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';

import { PrDecisionL3AssessorService } from './pr-decision-l3-assessor.service';

function ready<T>(verdict: GateVerdict<T>): T {
    if (verdict.status !== 'Ready') {
        throw new Error(`Expected a Ready verdict, got ${verdict.status}`);
    }
    return verdict.value;
}

function unavailable<T>(verdict: GateVerdict<T>): string {
    if (verdict.status !== 'Unavailable') {
        throw new Error(
            `Expected an Unavailable verdict, got ${verdict.status}`,
        );
    }
    return verdict.reason;
}

describe('PrDecisionL3AssessorService', () => {
    const service = new PrDecisionL3AssessorService();

    const INPUT = (decision: ApprovalDecision | null): L3AssessInput => ({
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        prNumber: 142,
        title: 't',
        headSha: 'h',
        baseSha: 'b',
        changedFiles: [],
        changedLines: 0,
        policies: [],
        snapshotKey: 'k',
        approvalDecision: decision,
    });

    it('maps an approve decision to Ready with the matched policy id', async () => {
        const value = ready<L3Verdict>(
            await service.assess(
                INPUT({
                    kind: 'approve',
                    reason: 'matched',
                    matchedPolicy: { id: 'docs/**', name: 'docs' },
                }),
            ),
        );

        expect(value).toEqual({
            matchedPolicyId: 'docs/**',
            unmatchedReasons: [],
        });
    });

    it('maps an approve decision with no matched policy to a null id', async () => {
        const value = ready<L3Verdict>(
            await service.assess(INPUT({ kind: 'approve', reason: 'matched' })),
        );

        expect(value.matchedPolicyId).toBeNull();
    });

    it('maps a hold decision to Ready with no match and the reason', async () => {
        const value = ready<L3Verdict>(
            await service.assess(
                INPUT({
                    kind: 'hold',
                    reason: 'no policy matched: author not listed',
                }),
            ),
        );

        expect(value.matchedPolicyId).toBeNull();
        expect(value.unmatchedReasons).toEqual([
            'no policy matched: author not listed',
        ]);
    });

    it('maps an out-of-scope decision to Ready with no match', async () => {
        const value = ready<L3Verdict>(
            await service.assess(
                INPUT({
                    kind: 'out-of-scope',
                    reason: 'the PR is not in scope',
                }),
            ),
        );

        expect(value.matchedPolicyId).toBeNull();
    });

    it('maps a disabled decision to Unavailable — an unapproved PR must not be auto-approved', async () => {
        const reason = unavailable(
            await service.assess(
                INPUT({
                    kind: 'disabled',
                    reason: 'Automatic approval is disabled.',
                }),
            ),
        );

        expect(reason).toBe('Automatic approval is disabled.');
    });

    it('fails closed when no decision was produced', async () => {
        const reason = unavailable(await service.assess(INPUT(null)));

        expect(reason).toMatch(/no verdict/i);
    });

    it('falls back to a generic reason when a disabled decision carries none', async () => {
        const reason = unavailable(
            await service.assess(INPUT({ kind: 'disabled', reason: '' })),
        );

        expect(reason).toMatch(/disabled/i);
    });

    it('reads the decision from ITS input — two calls do not share state', async () => {
        // The reconciler may run for several PRs concurrently in one worker
        // process, so the assessor must not hold the decision between calls.
        const matched = ready<L3Verdict>(
            await service.assess(
                INPUT({
                    kind: 'approve',
                    reason: 'matched',
                    matchedPolicy: { id: 'docs/**', name: 'docs' },
                }),
            ),
        );
        const unmatched = ready<L3Verdict>(
            await service.assess(
                INPUT({ kind: 'hold', reason: 'no policy matched' }),
            ),
        );

        expect(matched.matchedPolicyId).toBe('docs/**');
        expect(unmatched.matchedPolicyId).toBeNull();
    });
});
