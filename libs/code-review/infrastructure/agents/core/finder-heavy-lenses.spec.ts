/**
 * Heavy mode in the finder — mocked model, zero LLM. The lenses start with
 * the generalist, their findings take the lens's label, and every finding of
 * both goes through the same verify.
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
import { HEAVY_LENS_SYSTEM_PROMPT } from '@libs/code-review/infrastructure/agents/core/heavy-lenses';

const generalistFindings = {
    reasoning: 'generalist',
    suggestions: [
        {
            label: 'bug',
            relevantFile: 'a.ts',
            relevantLinesStart: 1,
            relevantLinesEnd: 1,
            suggestionContent: 'generalist bug',
        },
    ],
};

const lensFindings = {
    reasoning: 'lens',
    suggestions: [
        {
            // A label of the model's own: the lens's label replaces it.
            label: 'criticism',
            relevantFile: 'b.ts',
            relevantLinesStart: 2,
            relevantLinesEnd: 2,
            suggestionContent: 'lens leak',
        },
        {
            label: 'security',
            relevantFile: 'c.ts',
            relevantLinesStart: 3,
            relevantLinesEnd: 3,
            suggestionContent: 'lens false positive',
        },
    ],
};

/** The generalist's first call waits until a lens has started: the test only
 *  finishes when the lenses run next to the generalist, not after it. */
function model(lensStarted: Promise<void>, markLensStarted: () => void) {
    const doGenerate = (async (opts: any) => {
        const text = JSON.stringify(opts?.prompt ?? '');
        let tc: any;
        if (text.includes(HEAVY_LENS_SYSTEM_PROMPT.slice(0, 40))) {
            markLensStarted();
            tc = { id: 'l', name: 'submitResult', input: lensFindings };
        } else if (
            text.includes('verifier') ||
            text.includes('REFUTE') ||
            text.includes('verdict')
        ) {
            const refute = text.includes('false positive');
            tc = {
                id: 'v',
                name: 'submitVerdict',
                input: { keep: !refute, rationale: refute ? 'refuted' : 'ok' },
            };
        } else {
            await lensStarted;
            tc = { id: 'g', name: 'submitResult', input: generalistFindings };
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

const ledger = (): ProgressLedger => ({
    markFromToolCall: () => undefined,
    summary: () => ({
        totalTargets: 0,
        pendingTargets: 0,
        criticalTotal: 0,
        criticalPending: 0,
    }),
    debtNote: () => null,
});

const ctx: ToolContext = { runId: 'heavy' };

describe('runFinderWithVerify in heavy mode', () => {
    let markLensStarted: () => void;
    let lensStarted: Promise<void>;
    beforeEach(() => {
        lensStarted = new Promise((r) => (markLensStarted = r));
        const shared = model(lensStarted, () => markLensStarted());
        (resolveModelConfig as jest.Mock).mockReset();
        (resolveModelConfig as jest.Mock).mockImplementation(() => ({
            model: shared,
            callOptions: {},
            providerOptions: {},
            modelName: 'mock',
            usageIdentity: {},
        }));
    });

    const run = (runner = new AiSdkAgentRunner(undefined)) => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: ledger(),
        });
        return runFinderWithVerify(
            {
                runner,
                finderSpec,
                modelId: 'mock',
                tools,
                skipSynthesisRescue: true,
                lensPasses: [
                    {
                        label: 'lens-data-exposure',
                        findingLabel: 'security',
                        prompt: 'look for data exposure',
                        spec: buildFinderAgentSpec({
                            systemPrompt: HEAVY_LENS_SYSTEM_PROMPT,
                            modelId: 'mock',
                            tools,
                            labels: ['security'],
                            coverageLedger: ledger(),
                            maxSteps: 3,
                        }),
                    },
                ],
            },
            { prompt: 'review' },
            ctx,
        );
    };

    it('verifies the lenses findings with the generalist, under the lens label', async () => {
        const r = await run();

        expect(
            r.kept.map((f) => [
                f.relevantFile,
                f.label,
                (f as { producedBy?: string }).producedBy,
            ]),
        ).toEqual([
            ['a.ts', 'bug', undefined],
            ['b.ts', 'security', 'lens-data-exposure'],
        ]);
        expect(r.droppedByVerify.map((d) => d.finding.relevantFile)).toEqual([
            'c.ts',
        ]);
        expect(r.passStats.map((p) => [p.label, p.added])).toEqual([
            ['generalist-base', 1],
            ['lens-data-exposure', 2],
        ]);
    });

    it('goes on without a lens that fails', async () => {
        markLensStarted();
        const real = new AiSdkAgentRunner(undefined);
        const runner = {
            run: (spec: any, input: any, c: ToolContext) =>
                spec.systemPrompt === HEAVY_LENS_SYSTEM_PROMPT
                    ? Promise.reject(new Error('lens down'))
                    : real.run(spec, input, c),
        } as unknown as AiSdkAgentRunner;

        const r = await run(runner);

        expect(r.kept.map((f) => f.relevantFile)).toEqual(['a.ts']);
        expect(r.passStats.map((p) => p.label)).toEqual(['generalist-base']);
    });
});
