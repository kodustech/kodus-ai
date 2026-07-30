/**
 * runAgentLoopViaCore e2e — the harness+agent integration boundary, mocked model,
 * zero real LLM. Drives the FULL path the review pipeline uses:
 *   wrapByokModel -> AiSdkAgentRunner -> finder -> recall passes -> verify (HV2)
 *   -> map RunState -> AgentLoopOutput.
 *
 * Validates what only the adapter does (the wiring + the output mapping) and that
 * the recall passes actually fire through it (skipped in fast mode).
 */
import { MockLanguageModelV3 } from 'ai/test';

import { runAgentLoopViaCore } from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';

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

/** One mock model drives every model call (finder, recall passes, verifier).
 *  Returns a shared call counter so a test can prove recall passes ran. */
function makeModel() {
    const calls = { count: 0 };
    const doGenerate = (async (opts: any) => {
        calls.count++;
        const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
        const isVerifier =
            sys.includes('REFUTE') ||
            sys.includes('verdict') ||
            sys.includes('verify');
        let tc: any;
        if (isVerifier) {
            const refute = sys.includes('false positive');
            tc = {
                id: 'v',
                name: 'submitVerdict',
                input: { keep: !refute, rationale: refute ? 'refuted' : 'ok' },
            };
        } else {
            tc = { id: 'f', name: 'submitResult', input: findings };
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
    return { model: new MockLanguageModelV3({ doGenerate }), calls };
}

const fakeRemoteCommands = {
    grep: jest.fn(async () => ''),
    read: jest.fn(async () => ''),
    listDir: jest.fn(async () => ''),
    exec: jest.fn(async () => ({ stdout: '', exitCode: 0 })),
};

function makeInput(model: any, over: Record<string, unknown> = {}): any {
    return {
        model,
        systemPrompt: 'find bugs',
        userPrompt: 'review this PR',
        agentName: 'finder',
        telemetryMetadata: {
            organizationId: 'org',
            teamId: 'team',
            pullRequestId: 1,
            repositoryId: 'repo',
            provider: 'mock',
        },
        changedFiles: [
            { filename: 'a.ts', patch: '@@ -1,1 +1,2 @@\n+const x=1;' },
            { filename: 'b.ts', patch: '@@ -1,1 +1,2 @@\n+const y=2;' },
        ],
        prNumber: 1,
        repositoryFullName: 'org/repo',
        reviewMode: 'fast',
        maxSteps: 3,
        contextWindowTokens: 200_000,
        ...over,
    };
}

const secrets: any = {
    remoteCommands: fakeRemoteCommands,
    byokConfig: undefined,
    byokQueueTimeoutMs: undefined,
};

describe('runAgentLoopViaCore (harness + agent integration)', () => {
    it('runs finder + verify end-to-end and maps RunState -> AgentLoopOutput', async () => {
        const { model } = makeModel();
        const out = await runAgentLoopViaCore(makeInput(model), secrets);

        // verify funnel: 2 found, FP refuted -> 1 kept, 1 dropped
        expect(out.findings.suggestions.map((s: any) => s.relevantFile)).toEqual(
            ['a.ts'],
        );
        expect(
            out.droppedByVerify.map((s: any) => s.relevantFile),
        ).toEqual(['b.ts']);
        expect(out.verification?.beforeCount).toBe(2);
        expect(out.verification?.afterCount).toBe(1);
        expect(out.verification?.droppedByVerifier).toBe(1);

        // mapping basics (usage is summed fu+vu+ru; exact token counts depend on
        // real model usage — the mock doesn't propagate it, so assert the shape)
        expect(out.source).toBe('json-parse');
        expect(typeof out.usage.totalTokens).toBe('number');
        expect(out.usage).toMatchObject({
            inputTokens: expect.any(Number),
            outputTokens: expect.any(Number),
            cacheReadTokens: expect.any(Number),
        });
        expect(Array.isArray(out.toolCalls)).toBe(true);
        expect(out.coverage).toBeDefined();
        expect(out.anomalies).toBeDefined();
        expect(out.verificationUsage).toBeDefined();
    });

    it('skips recall passes in fast mode but runs them otherwise (more model calls)', async () => {
        const fast = makeModel();
        await runAgentLoopViaCore(
            makeInput(fast.model, { reviewMode: 'fast' }),
            secrets,
        );

        const normal = makeModel();
        await runAgentLoopViaCore(
            makeInput(normal.model, { reviewMode: 'normal' }),
            secrets,
        );

        // normal mode adds at least the synthesis-rescue pass -> more calls.
        expect(normal.calls.count).toBeGreaterThan(fast.calls.count);
    });

    it('self-contained (no remoteCommands) still produces output', async () => {
        const { model } = makeModel();
        const out = await runAgentLoopViaCore(makeInput(model), {
            ...secrets,
            remoteCommands: undefined,
        });
        expect(out.findings).toBeDefined();
        expect(out.usage).toBeDefined();
    });

    it('reports coverage from the ledger mutated during the run', async () => {
        const calls = { count: 0 };
        const doGenerate = (async (opts: any) => {
            calls.count++;
            const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
            const isVerifier =
                sys.includes('REFUTE') ||
                sys.includes('verdict') ||
                sys.includes('verify');

            if (isVerifier) {
                return {
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: 'v',
                            toolName: 'submitVerdict',
                            input: JSON.stringify({
                                keep: true,
                                rationale: 'ok',
                            }),
                        },
                    ],
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 5, outputTokens: 5 },
                    warnings: [],
                };
            }

            if (calls.count === 1) {
                return {
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: 'r',
                            toolName: 'readFile',
                            input: JSON.stringify({
                                path: 'a.ts',
                                startLine: 1,
                                endLine: 2,
                            }),
                        },
                    ],
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 5, outputTokens: 5 },
                    warnings: [],
                };
            }

            return {
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'f',
                        toolName: 'submitResult',
                        input: JSON.stringify({
                            reasoning: 'done',
                            suggestions: [],
                        }),
                    },
                ],
                finishReason: 'tool-calls',
                usage: { inputTokens: 5, outputTokens: 5 },
                warnings: [],
            };
        }) as any;

        const out = await runAgentLoopViaCore(
            makeInput(new MockLanguageModelV3({ doGenerate }), {
                reviewMode: 'fast',
                maxSteps: 4,
            }),
            secrets,
        );

        expect(out.coverage.totalTargets).toBe(2);
        expect(out.coverage.touchedTargets).toBe(1);
        expect(out.coverage.pendingTargets).toBe(1);
        expect(out.coverage.touchedFiles).toEqual(['a.ts']);
    });
});
