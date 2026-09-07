/**
 * Dispatch rules of the review orchestrator — which agents run for which
 * review mode / enabled categories.
 *
 * The case that matters: security must get its OWN agent outside deep mode.
 * It used to be a lens inside the single generalist pass, so a vulnerability
 * competed for attention with bug and performance hunting in the same run.
 */
import { ReviewOrchestratorService } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import type { ReviewOptions } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ReviewAgentCatalog } from './review-agent.catalog';
import { ReviewRiskPlanner } from '../../domain/review-policy/review-risk-planner';

type ExecutedInput = { requestedCategories?: string[] };

function makeAgent(calls: Map<string, ExecutedInput>, name: string) {
    return {
        execute: jest.fn(async (input: ExecutedInput) => {
            calls.set(name, input);
            return {
                suggestions: [],
                durationMs: 1,
                agentCategory: name,
            } as any;
        }),
    } as any;
}

function setup() {
    const calls = new Map<string, ExecutedInput>();
    const bug = makeAgent(calls, 'bug');
    const security = makeAgent(calls, 'security');
    const performance = makeAgent(calls, 'performance');
    const generalist = makeAgent(calls, 'generalist');
    const catalog = new ReviewAgentCatalog(
        bug,
        security,
        performance,
        generalist,
    );
    const service = new ReviewOrchestratorService(
        catalog,
        new ReviewRiskPlanner(),
    );
    return { service, calls, bug, security, performance, generalist };
}

const ALL_ON: ReviewOptions = {
    bug: true,
    security: true,
    performance: true,
};

function inputFor(
    reviewOptions: ReviewOptions,
    reviewMode: 'fast' | 'normal' | 'deep' = 'normal',
) {
    return {
        reviewOptions,
        reviewMode,
        prNumber: 1,
        changedFiles: [],
    } as any;
}

describe('ReviewOrchestratorService dispatch', () => {
    it('runs a dedicated security agent for risky changes in normal mode, alongside the generalist', async () => {
        const { service, security, generalist, calls } = setup();
        const input = inputFor(ALL_ON);
        input.changedFiles = [
            { filename: 'src/auth/token.guard.ts', changes: 30 },
        ];

        await service.execute(input);

        expect(security.execute).toHaveBeenCalledTimes(1);
        expect(generalist.execute).toHaveBeenCalledTimes(1);
        // The generalist no longer claims security — otherwise both agents
        // hunt the same category and the PR gets duplicate comments.
        expect(calls.get('generalist')?.requestedCategories).toEqual([
            'bug',
            'performance',
        ]);
    });

    it('runs the dedicated security agent for risky changes in fast mode too', async () => {
        const { service, security } = setup();
        const input = inputFor(ALL_ON, 'fast');
        input.changedFiles = [
            { filename: 'src/auth/token.guard.ts', changes: 30 },
        ];

        await service.execute(input);

        expect(security.execute).toHaveBeenCalledTimes(1);
    });

    it('skips the generalist when a security specialist covers the only enabled category', async () => {
        const { service, security, generalist } = setup();
        const input = inputFor({
            bug: false,
            performance: false,
            security: true,
        });
        input.changedFiles = [
            { filename: 'src/auth/token.guard.ts', changes: 30 },
        ];

        await service.execute(input);

        expect(security.execute).toHaveBeenCalledTimes(1);
        expect(generalist.execute).not.toHaveBeenCalled();
    });

    it('does not run the security agent when security is disabled', async () => {
        const { service, security, calls } = setup();

        await service.execute(
            inputFor({ bug: true, performance: true, security: false }),
        );

        expect(security.execute).not.toHaveBeenCalled();
        expect(calls.get('generalist')?.requestedCategories).toEqual([
            'bug',
            'performance',
        ]);
    });

    it('keeps deep mode on per-category agents', async () => {
        const { service, bug, security, performance, generalist } = setup();

        await service.execute(inputFor(ALL_ON, 'deep'));

        expect(bug.execute).toHaveBeenCalledTimes(1);
        expect(security.execute).toHaveBeenCalledTimes(1);
        expect(performance.execute).toHaveBeenCalledTimes(1);
        expect(generalist.execute).not.toHaveBeenCalled();
    });

    it('routes security-sensitive changes to a dedicated specialist', async () => {
        const { service, security, generalist, calls } = setup();
        const input = inputFor(ALL_ON);
        input.changedFiles = [
            { filename: 'src/auth/token.guard.ts', changes: 30 },
        ];

        const output = await service.execute(input);

        expect(security.execute).toHaveBeenCalledTimes(1);
        expect(generalist.execute).toHaveBeenCalledTimes(1);
        expect(calls.get('generalist')?.requestedCategories).toEqual([
            'bug',
            'performance',
        ]);
        expect(output.executionPlan.agents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ agentId: 'security' }),
            ]),
        );
    });

    it('dispatches nothing when every category is disabled', async () => {
        const { service, security, generalist } = setup();

        const out = await service.execute(
            inputFor({ bug: false, performance: false, security: false }),
        );

        expect(security.execute).not.toHaveBeenCalled();
        expect(generalist.execute).not.toHaveBeenCalled();
        expect(out.suggestions).toEqual([]);
    });

    it('falls back to the default policy when stored config is unsupported', async () => {
        const { service } = setup();

        const output = await service.execute({
            ...inputFor(ALL_ON),
            reviewPolicy: { version: '2' },
        });

        expect(output.reviewPolicy?.version).toBe('1');
        expect(output.reviewPolicy?.planner.strategy).toBe('risk-based');
    });
});
