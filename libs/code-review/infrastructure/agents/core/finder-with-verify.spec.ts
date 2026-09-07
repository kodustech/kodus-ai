/**
 * runFinderWithVerify e2e — mocked model, zero LLM.
 * Proves parity path: finder produces 2 findings, verifier keeps the real one
 * and refutes the false positive — all on the SAME runner (no second loop).
 */
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import { MockLanguageModelV3 } from 'ai/test';
import { resolveModelConfig } from '@libs/llm/model-invocation';

import type { ProgressLedger } from '@libs/agent-harness/domain/contracts/progress.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import {
    buildFinderAgentSpec,
    runFinderWithVerify,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';
import {
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_SOURCE,
    formatReviewContext,
} from '@libs/cli-review/domain/types/review-context.types';
import { collectReviewTelemetry } from '@libs/llm/review-telemetry';

const findings = {
    reasoning: 'two candidates',
    suggestions: [
        {
            relevantFile: 'a.ts',
            suggestionContent: 'real bug',
            existingCode: 'x',
            improvedCode: 'y',
            severity: 'high',
        },
        {
            relevantFile: 'b.ts',
            suggestionContent: 'false positive',
            existingCode: 'p',
            improvedCode: 'q',
            severity: 'low',
        },
    ],
};

/** One model drives BOTH the finder run and the verifier runs (same runner).
 *  - finder: step1 submitResult(findings)
 *  - verifier: submitVerdict(keep) unless the prompt mentions "false positive"
 */
function model(finderFindings = findings) {
    let finderDone = false;
    const doGenerate = (async (opts: any) => {
        const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
        const isVerifier =
            sys.includes('verifier') ||
            sys.includes('REFUTE') ||
            sys.includes('verdict');
        let tc: any;
        if (isVerifier) {
            const refute = sys.includes('false positive');
            tc = {
                id: 'v',
                name: 'submitVerdict',
                input: {
                    keep: !refute,
                    rationale: refute ? 'refuted' : 'confirmed',
                },
            };
        } else if (!finderDone) {
            finderDone = true;
            tc = { id: 'f', name: 'submitResult', input: finderFindings };
        } else {
            tc = { id: 'f2', name: 'submitResult', input: finderFindings };
        }
        return {
            content: [
                {
                    type: 'tool-call',
                    toolCallId: tc.id,
                    toolName: tc.name,
                    input: JSON.stringify(tc.input),
                },
            ],
            finishReason: 'tool-calls',
            usage: { inputTokens: 5, outputTokens: 5 },
            warnings: [],
        };
    }) as any;
    return new MockLanguageModelV3({ doGenerate });
}

const mockResolve = resolveModelConfig as jest.Mock;
beforeEach(() => {
    mockResolve.mockReset();
    mockResolve.mockImplementation(() => ({
        model: model(),
        callOptions: {},
        providerOptions: {},
        provider: 'mock-provider',
        modelName: 'mock',
        usageIdentity: {},
    }));
});

const noCriticalLedger: ProgressLedger = {
    markFromToolCall: () => undefined,
    summary: () => ({
        totalTargets: 0,
        pendingTargets: 0,
        criticalTotal: 0,
        criticalPending: 0,
    }),
    debtNote: () => null,
};

const ctx: ToolContext = { runId: 'fwv' };

describe('runFinderWithVerify (parity: finder + verify, same runner)', () => {
    it('keeps the real finding and drops the refuted false positive', async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
        });
        const runner = new AiSdkAgentRunner(undefined);

        const r = await runFinderWithVerify(
            { runner, finderSpec, modelId: 'mock', tools },
            { prompt: 'review' },
            ctx,
        );

        expect(r.kept.map((f) => f.relevantFile)).toEqual(['a.ts']);
        expect(r.droppedByVerify.map((d) => d.finding.relevantFile)).toEqual([
            'b.ts',
        ]);
        expect(r.droppedByVerify[0].evidence).toBe('refuted');
    });

    it('reports every context-bearing review phase that actually ran', async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
        });
        const runner = new AiSdkAgentRunner(undefined);
        const onReviewContextPhaseDelivery = jest.fn();
        const reviewContext = {
            source: REVIEW_CONTEXT_SOURCE,
            contentType: REVIEW_CONTEXT_CONTENT_TYPE,
            body: 'CANARY: inspect cleanup',
        };

        const captured = await collectReviewTelemetry(() =>
            runFinderWithVerify(
                {
                    runner,
                    finderSpec,
                    modelId: 'mock',
                    tools,
                    reviewContext,
                    heavy: true,
                    makeResampleSpec: () =>
                        buildFinderAgentSpec({
                            systemPrompt: 'find bugs',
                            modelId: 'mock',
                            tools,
                            coverageLedger: {
                                ...noCriticalLedger,
                            },
                        }),
                    recordTelemetryInputs: false,
                    onReviewContextPhaseDelivery,
                },
                {
                    prompt: `${formatReviewContext(reviewContext)}\n\n<ReviewTask>review</ReviewTask>`,
                },
                ctx,
            ),
        );
        const result = captured.value;

        const expectedPhases = [
            'finder',
            'synthesis-rescue',
            'heavy-resample-1',
            'heavy-resample-2',
            'verifier',
            'evidence-gate-verifier',
        ];
        expect(result.reviewContextPhases).toEqual(expectedPhases);
        expect(onReviewContextPhaseDelivery.mock.calls).toEqual(
            expectedPhases.map((phase) => [phase]),
        );
        expect(
            Array.from(
                new Set(
                    captured.telemetry.contextReceipts.map(
                        (receipt) => receipt.phase,
                    ),
                ),
            ),
        ).toEqual(expectedPhases);
        expect(
            Array.from(
                new Set(
                    captured.telemetry.modelCalls.map((call) => call.phase),
                ),
            ),
        ).toEqual(expectedPhases);
        expect(captured.telemetry.contextReceipts).not.toHaveLength(0);
        expect(JSON.stringify(captured.telemetry)).not.toContain(
            reviewContext.body,
        );
    });

    it('reports finder delivery before a context-bearing invocation rejects', async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
        });
        const runner = {
            run: jest.fn().mockRejectedValue(new Error('provider rejected')),
        } as unknown as AiSdkAgentRunner;
        const onReviewContextPhaseDelivery = jest.fn();
        const reviewContext = {
            source: REVIEW_CONTEXT_SOURCE,
            contentType: REVIEW_CONTEXT_CONTENT_TYPE,
            body: 'CANARY: rejected finder',
        };

        await expect(
            runFinderWithVerify(
                {
                    runner,
                    finderSpec,
                    modelId: 'mock',
                    tools,
                    reviewContext,
                    onReviewContextPhaseDelivery,
                },
                { prompt: formatReviewContext(reviewContext) },
                ctx,
            ),
        ).rejects.toThrow('provider rejected');

        expect(onReviewContextPhaseDelivery).toHaveBeenCalledTimes(1);
        expect(onReviewContextPhaseDelivery).toHaveBeenCalledWith('finder');
    });

    it('omits verifier phases when no candidate suggestions exist', async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
        });
        const runner = new AiSdkAgentRunner(undefined);
        const reviewContext = {
            source: REVIEW_CONTEXT_SOURCE,
            contentType: REVIEW_CONTEXT_CONTENT_TYPE,
            body: 'CANARY: no candidates',
        };
        mockResolve.mockImplementation(() => ({
            model: model({ reasoning: 'none', suggestions: [] }),
            callOptions: {},
            providerOptions: {},
            provider: 'mock-provider',
            modelName: 'mock',
            usageIdentity: {},
        }));

        const result = await runFinderWithVerify(
            {
                runner,
                finderSpec,
                modelId: 'mock',
                tools,
                reviewContext,
                recordTelemetryInputs: false,
            },
            {
                prompt: `${formatReviewContext(reviewContext)}\n\n<ReviewTask>review</ReviewTask>`,
            },
            ctx,
        );

        expect(result.reviewContextPhases).toEqual([
            'finder',
            'synthesis-rescue',
        ]);
    });

    it('omits recall phases when heavy passes are disabled', async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
        });
        const runner = new AiSdkAgentRunner(undefined);
        const reviewContext = {
            source: REVIEW_CONTEXT_SOURCE,
            contentType: REVIEW_CONTEXT_CONTENT_TYPE,
            body: 'CANARY: finder and verifier only',
        };

        const result = await runFinderWithVerify(
            {
                runner,
                finderSpec,
                modelId: 'mock',
                tools,
                reviewContext,
                skipHeavyPasses: true,
                recordTelemetryInputs: false,
            },
            {
                prompt: `${formatReviewContext(reviewContext)}\n\n<ReviewTask>review</ReviewTask>`,
            },
            ctx,
        );

        expect(result.reviewContextPhases).toEqual(['finder']);
    });
});
