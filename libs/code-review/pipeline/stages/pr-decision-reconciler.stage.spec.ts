import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';

import { PrDecisionReconcilerService } from '../services/pr-decision-reconciler.service';
import { PrDecisionReconcilerStage } from './pr-decision-reconciler.stage';

function buildContext(
    over: Partial<{
        organizationId: string;
        repositoryId: string;
        headSha: string;
        baseSha: string;
        prNumber: number;
        hasPullRequest: boolean;
        isDraft: boolean;
        botAuthor: string;
        riskAssessment: unknown;
        approvalDecision: unknown;
    }> = {},
): CodeReviewPipelineContext {
    const ctx: any = {};
    ctx.organizationAndTeamData = {
        organizationId: over.organizationId ?? 'org-1',
        teamId: 'team-1',
    };
    ctx.repository = { id: over.repositoryId ?? 'repo-1', name: 'repo' };
    if (over.hasPullRequest !== false) {
        ctx.pullRequest = {
            number: over.prNumber ?? 142,
            head: { sha: over.headSha ?? 'a1b2c3d4e5f6' },
            base: { sha: over.baseSha ?? 'e5f6a7b8c9d0' },
            isDraft: over.isDraft ?? false,
            author: over.botAuthor
                ? { login: over.botAuthor }
                : { login: 'human' },
        };
    } else {
        ctx.pullRequest = undefined;
    }
    if (over.riskAssessment !== undefined) {
        ctx.riskAssessment = over.riskAssessment;
    }
    if (over.approvalDecision !== undefined) {
        ctx.approvalDecision = over.approvalDecision;
    }
    return ctx as CodeReviewPipelineContext;
}

function buildStage(reconcile: jest.Mock = jest.fn()): {
    stage: PrDecisionReconcilerStage;
    reconcile: jest.Mock;
} {
    const reconciler = {
        reconcile,
    } as unknown as PrDecisionReconcilerService;
    const stage = new PrDecisionReconcilerStage(reconciler);
    return { stage, reconcile };
}

describe('PrDecisionReconcilerStage', () => {
    const ORIGINAL_ENV = process.env.PR_DECISION_RECONCILER_ENABLED;

    afterEach(() => {
        if (ORIGINAL_ENV === undefined) {
            delete process.env.PR_DECISION_RECONCILER_ENABLED;
        } else {
            process.env.PR_DECISION_RECONCILER_ENABLED = ORIGINAL_ENV;
        }
    });

    it('passes through untouched when PR_DECISION_RECONCILER_ENABLED is unset', async () => {
        delete process.env.PR_DECISION_RECONCILER_ENABLED;
        const reconcile = jest.fn();
        const { stage } = buildStage(reconcile);
        const ctx = buildContext();
        const result = await stage.executeStage(ctx);

        expect(reconcile).not.toHaveBeenCalled();
        expect(result).toBe(ctx);
    });

    it('runs the reconciler when PR_DECISION_RECONCILER_ENABLED=true', async () => {
        process.env.PR_DECISION_RECONCILER_ENABLED = 'true';
        const reconcile = jest.fn().mockResolvedValue({
            record: { organizationId: 'org-1' },
            desired: {
                kind: 'APPROVE',
                reason: 'matched',
                policyId: 'docs/**',
                vetoSources: [],
            },
            apply: { status: 'applied' as const },
            recordedAt: '2026-11-20T13:50:00.000Z',
        });
        const { stage } = buildStage(reconcile);
        const ctx = buildContext();
        const result = await stage.executeStage(ctx);

        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(reconcile).toHaveBeenCalledWith(
            expect.objectContaining({
                headSha: 'a1b2c3d4e5f6',
                baseSha: 'e5f6a7b8c9d0',
                kind: 'commit-pushed',
            }),
        );
        expect(
            (
                result as CodeReviewPipelineContext & {
                    prDecisionReconcileOutcome?: unknown;
                }
            ).prDecisionReconcileOutcome,
        ).toEqual({
            record: { organizationId: 'org-1' },
            desired: {
                kind: 'APPROVE',
                reason: 'matched',
                policyId: 'docs/**',
                vetoSources: [],
            },
            apply: { status: 'applied' },
            recordedAt: '2026-11-20T13:50:00.000Z',
        });
    });

    it('skips when no PR trigger context is attached', async () => {
        process.env.PR_DECISION_RECONCILER_ENABLED = 'true';
        const reconcile = jest.fn();
        const { stage } = buildStage(reconcile);
        const ctx = buildContext({ hasPullRequest: false });
        await stage.executeStage(ctx);
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('attaches the outcome to a FROZEN context', async () => {
        // The pipeline context is frozen (immer's `produce` freezes the
        // base). Assigning onto it throws "Cannot add property
        // prDecisionReconcileOutcome, object is not extensible" — the stage
        // must go through `updateContext`.
        process.env.PR_DECISION_RECONCILER_ENABLED = 'true';
        const reconcile = jest.fn().mockResolvedValue({
            record: { organizationId: 'org-1' },
            desired: {
                kind: 'APPROVE',
                reason: 'matched',
                policyId: 'docs/**',
                vetoSources: [],
            },
            apply: { status: 'applied' as const },
            recordedAt: '2026-11-20T13:50:00.000Z',
        });
        const { stage } = buildStage(reconcile);
        const ctx = Object.freeze(buildContext());

        const result = await stage.executeStage(ctx);

        expect(
            (result as CodeReviewPipelineContext).prDecisionReconcileOutcome,
        ).toBeDefined();
        expect(result).not.toBe(ctx);
    });

    it('declares correct stage metadata', () => {
        const reconcile = jest.fn();
        const { stage } = buildStage(reconcile);
        expect(stage.stageName).toBe('PrDecisionReconcilerStage');
    });

    describe('snapshot key', () => {
        it('is stable for the same configuration and head', async () => {
            process.env.PR_DECISION_RECONCILER_ENABLED = 'true';
            const reconcile = jest.fn().mockResolvedValue({});
            const { stage } = buildStage(reconcile);

            await stage.executeStage(buildContext());
            await stage.executeStage(buildContext());

            const first = reconcile.mock.calls[0][0].snapshotKey;
            const second = reconcile.mock.calls[1][0].snapshotKey;
            expect(first).toBe(second);
            expect(first).toMatch(/^cfg=[0-9a-f]+;head=a1b2c3d/);
        });

        it('changes when the head SHA changes', async () => {
            process.env.PR_DECISION_RECONCILER_ENABLED = 'true';
            const reconcile = jest.fn().mockResolvedValue({});
            const { stage } = buildStage(reconcile);

            await stage.executeStage(buildContext({ headSha: 'a1b2c3d4e5f6' }));
            await stage.executeStage(buildContext({ headSha: 'f6e5d4c3b2a1' }));

            const first = reconcile.mock.calls[0][0].snapshotKey;
            const second = reconcile.mock.calls[1][0].snapshotKey;
            expect(first).not.toBe(second);
        });
    });

    describe('concurrent stages', () => {
        it("each stage passes ITS PR's gate inputs on its own trigger", async () => {
            process.env.PR_DECISION_RECONCILER_ENABLED = 'true';
            const reconcile = jest.fn().mockResolvedValue({});
            const { stage } = buildStage(reconcile);

            // Two reviews in flight at once — the worker\'s code-review
            // channel has prefetchCount 20, so this is the normal case.
            const ctxA = buildContext({
                prNumber: 101,
                headSha: 'head-a',
                riskAssessment: {
                    status: 'assessed',
                    riskIdentified: false,
                    reason: 'risk-A',
                    snapshot: { organizationId: 'org-1' } as any,
                },
                approvalDecision: {
                    kind: 'approve',
                    reason: 'decision-A',
                    matchedPolicy: { id: 'docs-a/**', name: 'a' },
                },
            });
            const ctxB = buildContext({
                prNumber: 202,
                headSha: 'head-b',
                riskAssessment: {
                    status: 'assessed',
                    riskIdentified: false,
                    reason: 'risk-B',
                    snapshot: { organizationId: 'org-1' } as any,
                },
                approvalDecision: {
                    kind: 'approve',
                    reason: 'decision-B',
                    matchedPolicy: { id: 'docs-b/**', name: 'b' },
                },
            });

            await Promise.all([
                stage.executeStage(ctxA),
                stage.executeStage(ctxB),
            ]);

            // Both fixtures use repositoryId 'repo-1', so the PR number is
            // what distinguishes the two triggers.
            const triggers = reconcile.mock.calls.map((c) => c[0]);
            expect(triggers).toHaveLength(2);

            const byPr = new Map(triggers.map((t) => [t.prNumber, t]));
            const triggerA = byPr.get(101);
            const triggerB = byPr.get(202);

            expect(triggerA.gates.riskAssessment).toEqual(ctxA.riskAssessment);
            expect(triggerA.gates.approvalDecision).toEqual(
                ctxA.approvalDecision,
            );
            expect(triggerB.gates.riskAssessment).toEqual(ctxB.riskAssessment);
            expect(triggerB.gates.approvalDecision).toEqual(
                ctxB.approvalDecision,
            );
        });

        it('the trigger carries the host context and the sandbox', async () => {
            process.env.PR_DECISION_RECONCILER_ENABLED = 'true';
            const reconcile = jest.fn().mockResolvedValue({});
            const { stage } = buildStage(reconcile);

            const ctx = buildContext();
            const sandbox = { repoDir: '/repo' } as any;
            (ctx as any).sandboxHandle = sandbox;

            await stage.executeStage(ctx);

            const trigger = reconcile.mock.calls[0][0];
            expect(trigger.gates.sandbox).toBe(sandbox);
            expect(trigger.gates.host.organizationAndTeamData).toBe(
                ctx.organizationAndTeamData,
            );
            expect(trigger.gates.host.repository).toEqual({
                id: 'repo-1',
                name: 'repo',
            });
        });
    });
});
