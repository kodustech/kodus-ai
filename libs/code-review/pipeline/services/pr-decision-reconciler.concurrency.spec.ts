import { PrDecisionReconcilerService } from './pr-decision-reconciler.service';
import type {
    L0Assessor,
    L1Assessor,
    L2Assessor,
    L3Assessor,
    ReconcilerTrigger,
} from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';
import type { HostDriver } from '@libs/code-review/domain/risk/pr-decision-applier';
import { readyValue } from '@libs/code-review/domain/risk/pr-decision-reducer';

const SNAP = 'cfg=v11;head-snap';

/**
 * The reconciler runs for several PRs concurrently in one worker process —
 * the code-review channel's `prefetchCount` is 20. Every gate input
 * therefore travels ON the trigger, and every adapter is a pure function of
 * its input.
 *
 * A module-level holder (the shape this replaced) would make PR-A's
 * reconcile read PR-B's verdict: the two would interleave on the same
 * static field and the decision would be made from another PR's evidence.
 * These tests drive two reconciles concurrently and assert each sees only
 * its own.
 */

/**
 * The reconciler upserts the record twice per reconcile (before the apply and
 * after it). The second write carries the final gate verdicts, so take the
 * last upsert per repository.
 */
function lastUpsertsPerRepo(repo: any): Record<string, any[]> {
    const byRepo: Record<string, any[]> = {};
    for (const call of repo.upsert.mock.calls) {
        const input = call[0];
        byRepo[input.repositoryId] ??= [];
        byRepo[input.repositoryId].push(input);
    }
    const result: Record<string, any[]> = {};
    for (const [repoId, inputs] of Object.entries(byRepo)) {
        result[repoId] = [inputs[inputs.length - 1]];
    }
    return result;
}

describe('PrDecisionReconcilerService — concurrent reconciles', () => {
    function buildService() {
        // Each assessor echoes back what its OWN input carried, so a
        // cross-talk is visible in the recorded verdict.
        const l0: L0Assessor = {
            async assess(input) {
                return readyValue(
                    [
                        {
                            name: 'marker',
                            passed: true,
                            reason: `draft=${input.prShape.isDraft}`,
                        },
                    ],
                    input.snapshotKey,
                );
            },
        };
        const l1: L1Assessor = {
            async assess(input) {
                return readyValue(
                    {
                        riskScore: 0.1,
                        level: 'LOW' as const,
                        blastRadius: { totalFunctions: 1, totalFiles: 1 },
                        testGaps: [],
                        vetoContributingFunctions: [],
                        factors: [
                            {
                                name: 'marker',
                                value: 0.1,
                                detail: String(
                                    (input.sandbox as any)?.repoDir ?? 'none',
                                ),
                            },
                        ],
                    },
                    input.snapshotKey,
                );
            },
        };
        const l2: L2Assessor = {
            async assess(input) {
                // The interleave point: the reconciler awaits the L2 call, so
                // the other reconcile runs its own L2 (and any shared state)
                // while this one is suspended.
                await new Promise((resolve) => setImmediate(resolve));
                return readyValue(
                    {
                        riskIdentified: false,
                        reason: `assessment=${
                            (input.riskAssessment as any)?.reason ?? 'none'
                        }`,
                    },
                    input.snapshotKey,
                );
            },
        };
        const l3: L3Assessor = {
            async assess(input) {
                return readyValue(
                    {
                        matchedPolicyId: 'docs/**',
                        unmatchedReasons: [],
                    },
                    input.snapshotKey,
                );
            },
        };

        const repo = {
            findByRecordKey: jest.fn().mockResolvedValue(null),
            upsert: jest.fn().mockImplementation(async (input: any) => ({
                ...input,
                lastReconciledAt: new Date(),
            })),
        };

        const driver: HostDriver = {
            async dismissIfNeeded() {
                return { status: 'ok' as const };
            },
            async approve() {
                return { status: 'ok' as const };
            },
            async upsertDecisionComment() {
                return { status: 'ok' as const };
            },
        };

        return new PrDecisionReconcilerService(
            l0,
            l1,
            l2,
            l3,
            repo as any,
            driver,
        );
    }

    function triggerFor(
        prNumber: number,
        marker: string,
        sandboxRepoDir: string,
    ): ReconcilerTrigger {
        return {
            organizationId: 'org-1',
            repositoryId: `repo-${prNumber}`,
            prNumber,
            headSha: `head-${prNumber}`,
            baseSha: `base-${prNumber}`,
            kind: 'commit-pushed',
            triggeredAt: new Date().toISOString(),
            snapshotKey: `${SNAP}-${prNumber}`,
            gates: {
                riskAssessment: {
                    status: 'assessed',
                    riskIdentified: false,
                    reason: marker,
                    snapshot: { organizationId: 'org-1' } as any,
                },
                platform: 'forgejo',
                approvalDecision: {
                    kind: 'approve',
                    reason: marker,
                    matchedPolicy: { id: 'docs/**', name: 'docs' },
                },
                prShape: { isDraft: prNumber % 2 === 0 },
                changedFiles: [],
                sandbox: { repoDir: sandboxRepoDir } as any,
                host: {
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                    },
                    repository: {
                        id: `repo-${prNumber}`,
                        name: `repo-${prNumber}`,
                    },
                },
            },
        };
    }

    it('each concurrent reconcile sees only its own gate inputs', async () => {
        const service = buildService();

        const [a, b] = await Promise.all([
            service.reconcile(triggerFor(101, 'marker-A', '/repo-a')),
            service.reconcile(triggerFor(202, 'marker-B', '/repo-b')),
        ]);

        const snapshotOf = (outcome: any) => outcome.record.configurationKey;

        expect(snapshotOf(a)).toBe(`${SNAP}-101`);
        expect(snapshotOf(b)).toBe(`${SNAP}-202`);
    });

    it("the recorded L1 verdict carries THIS reconcile's sandbox", async () => {
        const service = buildService();
        const repo = (service as any).recordRepo;

        await Promise.all([
            service.reconcile(triggerFor(101, 'marker-A', '/repo-a')),
            service.reconcile(triggerFor(202, 'marker-B', '/repo-b')),
        ]);

        const final = lastUpsertsPerRepo(repo);
        const details = Object.values(final)
            .map(
                (inputs: any) =>
                    inputs[0].gateVerdictsSnapshot.l1.value.factors[0].detail,
            )
            .sort();
        expect(details).toEqual(['/repo-a', '/repo-b']);
    });

    it("the recorded L0 verdict carries THIS reconcile's PR shape", async () => {
        const service = buildService();
        const repo = (service as any).recordRepo;

        // 101 is odd (not draft), 202 is even (draft).
        await Promise.all([
            service.reconcile(triggerFor(101, 'marker-A', '/repo-a')),
            service.reconcile(triggerFor(202, 'marker-B', '/repo-b')),
        ]);

        const final = lastUpsertsPerRepo(repo);
        const reasons = Object.values(final)
            .map(
                (inputs: any) =>
                    inputs[0].gateVerdictsSnapshot.l0.value[0].reason,
            )
            .sort();
        expect(reasons).toEqual(['draft=false', 'draft=true']);
    });

    it("the recorded L2 verdict carries THIS reconcile's risk assessment", async () => {
        const service = buildService();
        const repo = (service as any).recordRepo;

        await Promise.all([
            service.reconcile(triggerFor(101, 'marker-A', '/repo-a')),
            service.reconcile(triggerFor(202, 'marker-B', '/repo-b')),
        ]);

        const final = lastUpsertsPerRepo(repo);
        const reasons = Object.values(final)
            .map(
                (inputs: any) => inputs[0].gateVerdictsSnapshot.l2.value.reason,
            )
            .sort();
        expect(reasons).toEqual(['assessment=marker-A', 'assessment=marker-B']);
    });
});
