/**
 * #2171 — a review that did not finish its checks must not read as finished.
 *
 * Two engine paths turned an unfinished review into a clean-looking one:
 *   1. a finder run that ends without submitting a result (it kept
 *      investigating past its budget, or the provider truncated its output)
 *      reached the provider as a normal run with zero findings;
 *   2. a verify run whose model call failed kept the candidate as if the
 *      verifier had confirmed it.
 *
 * Mocked model, zero real LLM: the reproductions from the issue, at the
 * adapter boundary the review pipeline uses.
 */
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import { MockLanguageModelV3 } from 'ai/test';
import { resolveModelConfig } from '@libs/llm/model-invocation';

import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { runAgentLoopViaCore } from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';
import { extractVerdict } from '@libs/code-review/infrastructure/agents/core/verifier.agent';

const mockResolve = resolveModelConfig as jest.Mock;

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

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

function toolCall(name: string, input: unknown, finishReason: unknown) {
    return {
        content: [
            {
                type: 'tool-call',
                toolCallId: `${name}-${Math.random()}`,
                toolName: name,
                input: JSON.stringify(input),
            },
        ],
        finishReason,
        usage,
        warnings: [],
    };
}

const SAFE = { unified: 'tool-calls', raw: 'tool_calls' };

function useModel(doGenerate: (opts: any) => Promise<unknown>) {
    const model = new MockLanguageModelV3({ doGenerate: doGenerate as any });
    mockResolve.mockReturnValue({
        model,
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    });
}

const isVerifierCall = (opts: any) => {
    const s = JSON.stringify(opts?.prompt ?? '');
    return s.includes('REFUTE') || s.includes('verdict');
};

function makeInput(over: Record<string, unknown> = {}): any {
    return {
        systemPrompt: 'find bugs',
        userPrompt: 'review this PR',
        agentName: 'finder',
        telemetryMetadata: { organizationId: 'org', pullRequestId: 1 },
        changedFiles: [
            { filename: 'a.ts', patch: '@@ -1,1 +1,2 @@\n+const x=1;' },
            { filename: 'b.ts', patch: '@@ -1,1 +1,2 @@\n+const y=2;' },
        ],
        prNumber: 1,
        repositoryFullName: 'org/repo',
        reviewMode: 'fast',
        maxSteps: 4,
        contextWindowTokens: 200_000,
        ...over,
    };
}

const secrets: any = {
    remoteCommands: {
        grep: jest.fn(async () => ''),
        read: jest.fn(async () => 'code'),
        listDir: jest.fn(async () => ''),
        exec: jest.fn(async () => ({ stdout: '', exitCode: 0 })),
    },
    byokConfig: undefined,
};

beforeEach(() => mockResolve.mockReset());

describe('#2171 — finder run that ends without a submitted result', () => {
    it('reports budget-exhausted when the model keeps investigating past its steps', async () => {
        useModel(async () => toolCall('readFile', { path: 'a.ts' }, SAFE));

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.finishReason).toBe('budget-exhausted');
        expect(out.incompleteReason).toBe('budget-exhausted');
    });

    it('reports truncated when the provider cut the turn and the tool never ran', async () => {
        useModel(async () =>
            toolCall(
                'readFile',
                { path: 'a.ts' },
                { unified: 'length', raw: 'max_tokens' },
            ),
        );

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.incompleteReason).toBe('truncated');
    });

    it('a finder that submits its result is not incomplete', async () => {
        useModel(async (opts) =>
            isVerifierCall(opts)
                ? toolCall(
                      'submitVerdict',
                      { keep: true, rationale: 'ok' },
                      SAFE,
                  )
                : toolCall('submitResult', findings, SAFE),
        );

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.incompleteReason).toBeUndefined();
    });

    // PR #2173 review: the runner turns every REQUESTED result call into an
    // artifact, executed or not. A turn cut while writing submitResult leaves
    // its input as unparseable JSON; that artifact must not count as a
    // submitted result.
    it('reports truncated when the provider cut the turn inside submitResult', async () => {
        const cut = JSON.stringify(findings).slice(0, 60);
        useModel(async () => ({
            content: [
                {
                    type: 'tool-call',
                    toolCallId: `submitResult-${Math.random()}`,
                    toolName: 'submitResult',
                    input: cut,
                },
            ],
            finishReason: { unified: 'length', raw: 'max_tokens' },
            usage,
            warnings: [],
        }));

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.incompleteReason).toBe('truncated');
    });

    // PR #2173 review: `{}` parses as an object but is not a findings result
    // (sanitizeFindingsResult rejects it), so it is not a submission either.
    it('reports truncated when the cut submitResult holds no findings result', async () => {
        useModel(async () =>
            toolCall(
                'submitResult',
                {},
                { unified: 'length', raw: 'max_tokens' },
            ),
        );

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.incompleteReason).toBe('truncated');
    });

    // PR #2173 review: partial recovery drops every invalid item, so a
    // non-empty list that lost them all comes back as `suggestions: []`.
    it('reports truncated when recovery dropped every item of a cut submitResult', async () => {
        useModel(async () =>
            toolCall(
                'submitResult',
                { reasoning: 'one candidate', suggestions: [{}] },
                { unified: 'length', raw: 'max_tokens' },
            ),
        );

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.incompleteReason).toBe('truncated');
    });

    it('a complete submitResult on a cut turn is a submitted result', async () => {
        useModel(async (opts) =>
            isVerifierCall(opts)
                ? toolCall(
                      'submitVerdict',
                      { keep: true, rationale: 'ok' },
                      SAFE,
                  )
                : toolCall('submitResult', findings, {
                      unified: 'length',
                      raw: 'max_tokens',
                  }),
        );

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.incompleteReason).toBeUndefined();
    });

    it('a finder that ends with prose and no tool call is not incomplete (prose recovery owns it)', async () => {
        useModel(async () => ({
            content: [
                { type: 'text', text: 'No issues found in this change.' },
            ],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage,
            warnings: [],
        }));

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.incompleteReason).toBeUndefined();
    });
});

describe('#2171 — verify call that fails', () => {
    it('does not keep candidates whose verify run errored, and reports them apart', async () => {
        useModel(async (opts) => {
            if (isVerifierCall(opts)) {
                throw new Error('This operation was aborted');
            }
            return toolCall('submitResult', findings, SAFE);
        });

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.findings.suggestions).toEqual([]);
        expect(out.droppedByVerify).toEqual([]);
        expect(
            (out.unverifiedByVerify ?? []).map((s: any) => s.relevantFile),
        ).toEqual(['a.ts', 'b.ts']);
    });

    // PR #2173 review: a verifier that runs out of steps without a verdict
    // judged nothing either; its candidates must not be published as kept.
    it('does not keep candidates whose verifier ran out of steps without a verdict', async () => {
        useModel(async (opts) =>
            isVerifierCall(opts)
                ? toolCall('readFile', { path: 'a.ts' }, SAFE)
                : toolCall('submitResult', findings, SAFE),
        );

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(out.findings.suggestions).toEqual([]);
        expect(
            (out.unverifiedByVerify ?? []).map((s: any) => s.relevantFile),
        ).toEqual(['a.ts', 'b.ts']);
    });

    it('a refutation still lands in droppedByVerify, not in unverified', async () => {
        useModel(async (opts) => {
            if (isVerifierCall(opts)) {
                const refute = JSON.stringify(opts.prompt).includes(
                    'false positive',
                );
                return toolCall(
                    'submitVerdict',
                    { keep: !refute, rationale: refute ? 'refuted' : 'ok' },
                    SAFE,
                );
            }
            return toolCall('submitResult', findings, SAFE);
        });

        const out = await runAgentLoopViaCore(makeInput(), secrets);

        expect(
            out.findings.suggestions.map((s: any) => s.relevantFile),
        ).toEqual(['a.ts']);
        expect(out.droppedByVerify.map((s: any) => s.relevantFile)).toEqual([
            'b.ts',
        ]);
        expect(out.unverifiedByVerify ?? []).toEqual([]);
    });
});

describe('#2171 — extractVerdict on a failed verify run', () => {
    const errored = (message: string): RunState => ({
        runId: 'r',
        agentId: 'verifier',
        status: 'error',
        steps: [],
        artifacts: [],
        stopReason: 'error',
        usage: {} as any,
        trace: [
            {
                at: 0,
                source: 'runner',
                kind: 'error',
                detail: { message },
            },
        ],
    });

    it('is a verify-error, not a default keep', () => {
        const v = extractVerdict(errored('429 Too Many Requests'));

        expect(v.parseMode).toBe('verify-error');
        // The harness Verifier port fails open (keep); the review decides
        // what an unverified candidate means — see runFinderWithVerify.
        expect(v.keep).toBe(true);
        expect(v.rationale).toContain('429 Too Many Requests');
    });

    const ended = (status: RunState['status']): RunState => ({
        ...errored('unused'),
        status,
        stopReason: status,
        trace: [],
    });

    it.each(['budget-exhausted', 'stopped'] as const)(
        'is a verify-error when the run %s without a verdict',
        (status) => {
            const v = extractVerdict(ended(status));

            expect(v.parseMode).toBe('verify-error');
            expect(v.keep).toBe(true);
            expect(v.rationale).toContain(status);
        },
    );

    it('stays a default keep when the run completed without a verdict', () => {
        expect(extractVerdict(ended('completed')).parseMode).toBe(
            'default-keep',
        );
    });
});
