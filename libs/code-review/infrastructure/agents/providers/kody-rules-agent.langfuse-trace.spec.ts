import { KodyRulesAgentProvider } from '@libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import * as reviewObs from '@libs/code-review/infrastructure/agents/collaborators/review-observability';

// The sharded judge runs the LLM at this boundary — mock it so the test never
// hits a real model, and so we can prove the judge executed INSIDE the trace.
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: jest.fn(),
}));

// Spy on runAgentWithTrace but keep executing `fn` so the rest of execute()
// (the judge + merge) still runs. This is the seam that opens the Langfuse
// root observation every OTHER review agent uses (base provider). The sharded
// kody-rules execute() override must go through it too, or its Vercel AI SDK
// generateText spans emit detached — no named trace, no org/PR/session tags —
// which is exactly why the agent shows ZERO traces in Langfuse today.
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/review-observability',
    () => {
        const actual = jest.requireActual(
            '@libs/code-review/infrastructure/agents/collaborators/review-observability',
        );
        return {
            ...actual,
            runAgentWithTrace: jest.fn((_meta: any, _input: any, fn: any) =>
                fn(),
            ),
        };
    },
);

const mockJudge = runStructuredReviewCall as jest.Mock;
const mockRunAgentWithTrace = reviewObs.runAgentWithTrace as jest.Mock;

describe('KodyRulesAgentProvider.execute — Langfuse trace wrapping (#sharded-no-trace)', () => {
    function makeProvider(responses: any[]) {
        let i = 0;
        mockJudge.mockReset();
        mockJudge.mockImplementation(
            async () => responses[i++] ?? { violations: [] },
        );
        mockRunAgentWithTrace.mockClear();
        return new KodyRulesAgentProvider(
            {
                getBYOKConfig: jest.fn(async () => null),
                // resolveReviewAgentModel routes through this — return the
                // system/env default (the judge LLM call is mocked anyway).
                resolveTaskModel: jest.fn(async () => ({
                    model: {} as any,
                    modelName: 'system:default',
                    slot: null,
                    verdict: null,
                })),
            } as any, // permissionValidationService
            {} as any, // observability (judge mocked)
        );
    }

    const input = (over: any = {}) => ({
        prNumber: 4242,
        organizationAndTeamData: {
            organizationId: 'org-abc',
            teamId: 'team-xyz',
        },
        repositoryId: 'repo-123',
        changedFiles: [
            {
                filename: 'src/a.ts',
                patchWithLinesStr: '11 +const x: any = 2',
                patch: '11 +const x: any = 2',
            },
        ],
        prTitle: 'test',
        prBody: '',
        kodyRules: [
            {
                uuid: 'no-any',
                title: 'no any',
                rule: 'do not use any',
                status: 'active',
                severity: 'high',
                path: '**/*.ts',
            },
        ],
        ...over,
    });

    it('runs the semantic judge INSIDE runAgentWithTrace, tagged with the agent identity + org/team/PR/repo', async () => {
        const provider = makeProvider([
            {
                violations: [
                    {
                        ruleId: 1,
                        relevantLinesStart: 11,
                        relevantLinesEnd: 11,
                        existingCode: 'const x: any = 2',
                        suggestionContent: 'avoid any',
                        oneSentenceSummary: 'no any',
                    },
                ],
            },
        ]);

        const out = await provider.execute(input() as any);

        // The judge produced its finding — proves the wrapped `fn` actually ran.
        expect(out.suggestions).toHaveLength(1);

        // The LLM shards ran inside a Langfuse trace, not detached.
        expect(mockRunAgentWithTrace).toHaveBeenCalledTimes(1);

        // Trace is identifiable and filterable the same way every other agent is.
        const meta = mockRunAgentWithTrace.mock.calls[0][0];
        expect(meta).toMatchObject({
            traceName: 'kodus-rules-review-agent',
            organizationId: 'org-abc',
            teamId: 'team-xyz',
            prNumber: 4242,
            repositoryId: 'repo-123',
        });

        // The shard LLM call happened within the trace wrapper (order proof).
        const traceOrder = mockRunAgentWithTrace.mock.invocationCallOrder[0];
        const judgeOrder = mockJudge.mock.invocationCallOrder[0];
        expect(traceOrder).toBeLessThan(judgeOrder);
    });
});
