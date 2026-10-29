/**
 * Dispatch rules of the review orchestrator — which agents run for which
 * review mode / enabled categories — and how it collects their outcomes.
 */
import { AgentDegradedError } from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import { ReviewOrchestratorService } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import type { ReviewOptions } from '@libs/core/infrastructure/config/types/general/codeReview.type';

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
    const service = new ReviewOrchestratorService(
        bug,
        security,
        performance,
        generalist,
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
    it('runs only the generalist in normal mode, with every enabled category', async () => {
        const { service, bug, security, performance, generalist, calls } =
            setup();

        const out = await service.execute(inputFor(ALL_ON));

        expect(generalist.execute).toHaveBeenCalledTimes(1);
        expect(bug.execute).not.toHaveBeenCalled();
        expect(security.execute).not.toHaveBeenCalled();
        expect(performance.execute).not.toHaveBeenCalled();
        expect(calls.get('generalist')?.requestedCategories).toEqual([
            'bug',
            'security',
            'performance',
        ]);
        expect(out.agentResults).toHaveLength(1);
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

    it("collects every agent's suggestions, overlapping ones included", async () => {
        const { service, bug, security, performance } = setup();
        // Same file and lines from two agents: both are kept here, the LLM
        // dedup downstream owns merging them.
        const finding = (label: string) => ({
            relevantFile: 'src/auth.ts',
            relevantLinesStart: 10,
            relevantLinesEnd: 15,
            label,
        });
        bug.execute.mockResolvedValue({ suggestions: [finding('bug')], durationMs: 1 });
        security.execute.mockResolvedValue({ suggestions: [finding('security')], durationMs: 1 });
        performance.execute.mockResolvedValue({ suggestions: [finding('performance')], durationMs: 1 });

        const out = await service.execute(inputFor(ALL_ON, 'deep'));

        expect(out.suggestions.map((s: any) => s.label)).toEqual([
            'bug',
            'security',
            'performance',
        ]);
        expect(out.agentResults).toHaveLength(3);
    });

    it('skips disabled categories in deep mode', async () => {
        const { service, bug, security, performance } = setup();

        await service.execute(
            inputFor({ bug: true, security: false, performance: false }, 'deep'),
        );

        expect(bug.execute).toHaveBeenCalledTimes(1);
        expect(security.execute).not.toHaveBeenCalled();
        expect(performance.execute).not.toHaveBeenCalled();
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

    it('keeps the other agents when one fails', async () => {
        const { service, security } = setup();
        security.execute.mockRejectedValue(new Error('LLM timeout'));

        const out = await service.execute(inputFor(ALL_ON, 'deep'));

        expect(out.agentResults).toHaveLength(2);
        expect(out.failures).toEqual([
            expect.objectContaining({ agentName: 'security' }),
        ]);
    });
});

// An agent that runs out of time or steps is NOT a failure — it returns,
// possibly with findings. But it stopped looking, so an empty result from it
// means "couldn't tell", not "clean". The orchestrator has to report that
// separately or the pipeline auto-approves an unfinished review (#1568).
describe('ReviewOrchestratorService — incomplete agents (budget/step ceiling)', () => {
    // A turn the provider truncated is the other way an agent returns
    // without finishing (#2171).
    it('reports a truncated agent as incomplete, not as a failure', async () => {
        const { service, generalist } = setup();
        generalist.execute.mockResolvedValue({
            suggestions: [],
            durationMs: 1,
            hitHardLimit: true,
            finishReason: 'truncated',
        });

        const result = await service.execute(inputFor(ALL_ON));

        expect(result.failures).toHaveLength(0);
        expect(result.incomplete).toEqual([
            expect.objectContaining({
                agentName: 'generalist',
                finishReason: 'truncated',
                suggestionsFound: 0,
            }),
        ]);
    });

    it('reports an agent that left findings unverified (#2171)', async () => {
        const { service, generalist } = setup();
        generalist.execute.mockResolvedValue({
            suggestions: [],
            durationMs: 1,
            discardedByVerifyError: [
                { relevantFile: 'src/index.ts' },
                { relevantFile: 'src/other.ts' },
            ],
        });

        const result = await service.execute(inputFor(ALL_ON));

        expect(result.failures).toHaveLength(0);
        expect(result.unverified).toEqual([
            expect.objectContaining({
                agentName: 'generalist',
                unverifiedCount: 2,
            }),
        ]);
    });

    it('reports a max-steps agent as incomplete even when it found something', async () => {
        const { service, generalist } = setup();
        generalist.execute.mockResolvedValue({
            suggestions: [{ relevantFile: 'src/index.ts', label: 'bug' }],
            durationMs: 1,
            hitHardLimit: true,
            finishReason: 'max-steps',
        });

        const result = await service.execute(inputFor(ALL_ON));

        expect(result.suggestions).toHaveLength(1);
        expect(result.incomplete[0]).toMatchObject({
            agentName: 'generalist',
            finishReason: 'max-steps',
            suggestionsFound: 1,
        });
    });

    it('leaves incomplete empty when every agent ran to completion', async () => {
        const { service } = setup();

        const result = await service.execute(inputFor(ALL_ON));

        expect(result.incomplete).toEqual([]);
    });
});

describe('ReviewOrchestratorService — warnings from an agent that threw', () => {
    // allSettled keeps only a fulfilled agent's `warnings`, so an agent that
    // degrades hard enough to throw used to lose whatever it wanted the PR to
    // say. Kody Rules hits this: when every rule is skipped for missing
    // repository context it escalates, and its message names the skipped rules
    // — but that message renders only for a FAILED review, and kody-rules is
    // not critical, so the review is partial and the names never surfaced
    // (Verifier round 2, gap 2).
    it('harvests the warnings an AgentDegradedError carried', async () => {
        const { service, generalist } = setup();
        const carried = {
            kind: 'RULE_CONTEXT_UNAVAILABLE',
            reason: 'lookup_unavailable',
            contextWindowTokens: 0,
            modelName: 'test-model',
            detail: '2 rules not evaluated: No unused imports, Shared logger',
        } as any;
        generalist.execute = jest.fn(async () => {
            throw new AgentDegradedError('every rule skipped', [carried]);
        });

        const result = await service.execute(inputFor(ALL_ON));

        expect(result.warnings).toContainEqual(carried);
    });

    it('leaves warnings untouched when a thrown error carries none', async () => {
        const { service, generalist } = setup();
        generalist.execute = jest.fn(async () => {
            throw new Error('plain failure');
        });

        const result = await service.execute(inputFor(ALL_ON));

        expect(result.warnings).toEqual([]);
    });
});

// Production 2026-09-30: "[AGENT] kody-rules failed: Kody Rules could not be
// evaluated" logged 582 times a day with empty metadata — no org, no PR — so
// finding who was affected meant joining shard warnings by correlationId.
describe('ReviewOrchestratorService — a failed agent names its review', () => {
    it('logs the organization and the PR with the failure', async () => {
        const { service, generalist } = setup();
        generalist.execute.mockRejectedValue(new Error('all 2 rule check(s) failed to run'));
        const logger = (service as any).logger;
        const logged: any[] = [];
        for (const level of ['error', 'warn', 'log']) {
            jest.spyOn(logger, level).mockImplementation((entry: any) => {
                logged.push(entry);
            });
        }

        await service
            .execute({
                ...inputFor({ bug: true }),
                prNumber: 42,
                organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
            })
            .catch(() => undefined);

        const failures = logged.filter((e) => /\[AGENT\] generalist (agent )?failed/.test(e.message));
        expect(failures.length).toBeGreaterThan(0);
        for (const entry of failures) {
            expect(entry.metadata).toEqual(
                expect.objectContaining({
                    prNumber: 42,
                    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
                }),
            );
        }
    });
});
