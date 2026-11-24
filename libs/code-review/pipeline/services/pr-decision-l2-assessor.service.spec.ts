import type { GateVerdict } from '@libs/code-review/domain/risk/pr-decision-graph-verdict';
import type { L2Verdict } from '@libs/code-review/domain/risk/pr-decision-reducer';
import type { RiskAssessmentResult } from '@libs/code-review/domain/risk/risk-assessment';

import { PrDecisionL2AssessorService } from './pr-decision-l2-assessor.service';

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

describe('PrDecisionL2AssessorService', () => {
    const service = new PrDecisionL2AssessorService();

    const INPUT = (assessment: RiskAssessmentResult | null) => ({
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        prNumber: 142,
        title: 't',
        headSha: 'h',
        baseSha: 'b',
        changedFiles: [],
        configurationKeySnapshot: 'k',
        snapshotKey: 'k',
        riskAssessment: assessment,
    });

    it('maps an assessed verdict with risk to Ready(riskIdentified=true)', async () => {
        const value = ready<L2Verdict>(
            await service.assess(
                INPUT({
                    status: 'assessed',
                    riskIdentified: true,
                    reason: 'auth path compromise',
                    snapshot: { organizationId: 'org-1' } as any,
                }),
            ),
        );

        expect(value).toEqual({
            riskIdentified: true,
            reason: 'auth path compromise',
        });
    });

    it('maps an assessed verdict without risk to Ready(riskIdentified=false)', async () => {
        const value = ready<L2Verdict>(
            await service.assess(
                INPUT({
                    status: 'assessed',
                    riskIdentified: false,
                    reason: 'clean',
                    snapshot: { organizationId: 'org-1' } as any,
                }),
            ),
        );

        expect(value.riskIdentified).toBe(false);
    });

    it('fails closed on an unavailable assessment', async () => {
        const reason = unavailable(
            await service.assess(
                INPUT({
                    status: 'unavailable',
                    reason: 'could not verify the diff',
                }),
            ),
        );

        expect(reason).toBe('could not verify the diff');
    });

    it('treats a disabled assessment as Ready(false) — not a veto', async () => {
        const value = ready<L2Verdict>(
            await service.assess(INPUT({ status: 'disabled' })),
        );

        expect(value.riskIdentified).toBe(false);
    });

    it('fails closed when no verdict was produced at all', async () => {
        const reason = unavailable(await service.assess(INPUT(null)));

        expect(reason).toMatch(/no verdict/i);
    });

    it('carries the snapshot key through', async () => {
        const verdict = await service.assess({
            ...INPUT({
                status: 'assessed',
                riskIdentified: false,
                reason: 'clean',
                snapshot: { organizationId: 'org-1' } as any,
            }),
            snapshotKey: 'cfg=xyz;head=1234567',
        });

        expect(verdict.snapshotKey).toBe('cfg=xyz;head=1234567');
    });

    it('keeps a routine unavailable assessment unavailable — the reason is carried', async () => {
        // `expected: true` marks a routine outcome (a push during the diff
        // read). It must NOT become a Ready(false): that would turn a
        // failed assessment into a clean bill of health.
        const reason = unavailable(
            await service.assess(
                INPUT({
                    status: 'unavailable',
                    reason: 'a push arrived during the diff read',
                    expected: true,
                }),
            ),
        );

        expect(reason).toBe('a push arrived during the diff read');
    });

    it('reads the assessment from ITS input — two calls do not share state', async () => {
        // The reconciler may run for several PRs concurrently in one worker
        // process, so the assessor must not hold the verdict between calls.
        const risky = ready<L2Verdict>(
            await service.assess(
                INPUT({
                    status: 'assessed',
                    riskIdentified: true,
                    reason: 'risky',
                    snapshot: { organizationId: 'org-1' } as any,
                }),
            ),
        );
        const clean = ready<L2Verdict>(
            await service.assess(
                INPUT({
                    status: 'assessed',
                    riskIdentified: false,
                    reason: 'clean',
                    snapshot: { organizationId: 'org-1' } as any,
                }),
            ),
        );

        expect(risky.riskIdentified).toBe(true);
        expect(clean.riskIdentified).toBe(false);
    });
});
