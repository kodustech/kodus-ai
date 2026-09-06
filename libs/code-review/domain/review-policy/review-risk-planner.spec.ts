import { DEFAULT_REVIEW_POLICY, resolveReviewPolicy } from './review-policy';
import { ReviewRiskPlanner } from './review-risk-planner';

const planner = new ReviewRiskPlanner();

describe('ReviewRiskPlanner', () => {
    it('is deterministic for the same diff and policy', () => {
        const input = {
            reviewMode: 'normal' as const,
            reviewOptions: { bug: true, security: true, performance: true },
            changedFiles: [
                { filename: 'src/auth/token.service.ts', changes: 80 },
                { filename: 'src/database/user.repository.ts', changes: 50 },
            ],
            hasKodyRules: true,
            policy: DEFAULT_REVIEW_POLICY,
        };

        expect(planner.plan(input)).toEqual(planner.plan(input));
    });

    it('uses policy overrides for budgets without changing code', () => {
        const policy = resolveReviewPolicy({
            version: '1',
            modes: {
                normal: {
                    agents: { security: { maxSteps: 31 } },
                },
            },
        });

        const plan = planner.plan({
            reviewMode: 'normal',
            reviewOptions: { bug: false, security: true, performance: false },
            changedFiles: [
                { filename: 'src/auth/permission.guard.ts', changes: 20 },
            ],
            hasKodyRules: false,
            policy,
        });

        expect(plan.agents).toEqual([
            expect.objectContaining({ agentId: 'security', maxSteps: 31 }),
        ]);
    });

    it('rejects unsupported policy versions', () => {
        expect(() => resolveReviewPolicy({ version: '2' })).toThrow(
            'Unsupported review policy version: 2',
        );
    });

    it('rejects unknown planner strategies instead of silently changing behavior', () => {
        expect(() =>
            resolveReviewPolicy({
                planner: { strategy: 'random' },
            } as any),
        ).toThrow('Unsupported review planner strategy: random');
    });
});
