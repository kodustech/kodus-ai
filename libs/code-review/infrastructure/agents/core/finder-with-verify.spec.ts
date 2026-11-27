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
import { ContextWindowCompressor } from '@libs/agent-harness/infrastructure/compression/context-window-compressor';
import { estimateTextTokens } from '@libs/llm/token-estimate';

import {
    buildFinderAgentSpec,
    runFinderWithVerify,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';

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
function model() {
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
            tc = { id: 'f', name: 'submitResult', input: findings };
        } else {
            tc = { id: 'f2', name: 'submitResult', input: findings };
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

    it('reports how long the verify step took', async () => {
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

        expect(typeof r.verifyMs).toBe('number');
        expect(r.verifyMs).toBeGreaterThanOrEqual(0);
    });

    it('runs the verify pass on its own runner when one is given', async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
        });
        const runner = new AiSdkAgentRunner(undefined);
        const verifyRunner = new AiSdkAgentRunner(undefined);
        const finderRun = jest.spyOn(runner, 'run');
        const verifyRun = jest.spyOn(verifyRunner, 'run');

        const r = await runFinderWithVerify(
            {
                runner,
                finderSpec,
                modelId: 'mock',
                tools,
                skipHeavyPasses: true,
                verifyRunner,
                verifyModelId: 'check-model',
            },
            { prompt: 'review' },
            ctx,
        );

        expect(r.kept.map((f) => f.relevantFile)).toEqual(['a.ts']);
        expect(finderRun).toHaveBeenCalledTimes(1);
        // Two candidates, then the evidence gate re-checks the kept one
        // (its file was never read): every verify run is on the check runner.
        expect(verifyRun).toHaveBeenCalledTimes(3);
        expect(
            verifyRun.mock.calls.every(([spec]) => spec.phase === 'verify'),
        ).toBe(true);
    });
});

describe("runFinderWithVerify within the model's window (#2233)", () => {
    // The verify run reads files on up to ten steps with each read re-sent:
    // without the finder's compressor it sent 2.4M tokens to 1M-token models.
    it("shortens what each verify run re-sends to the finder's window", async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
            compressor: new ContextWindowCompressor(16_000),
        });
        const runner = new AiSdkAgentRunner(undefined);
        const run = jest.spyOn(runner, 'run');

        await runFinderWithVerify(
            {
                runner,
                finderSpec,
                modelId: 'mock',
                tools,
                skipHeavyPasses: true,
            },
            { prompt: 'review' },
            ctx,
        );

        const verifyRuns = run.mock.calls.filter(
            ([spec]) => spec.phase === 'verify',
        );
        expect(verifyRuns.length).toBeGreaterThan(0);
        const read = (i: number) => [
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: `r${i}`,
                        toolName: 'readFile',
                        input: { path: `src/f${i}.ts` },
                    },
                ],
            },
            {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: `r${i}`,
                        toolName: 'readFile',
                        output: {
                            type: 'text',
                            value: Array.from(
                                { length: 400 },
                                (_, line) =>
                                    `${line + 1}: export const v${line} = load('${i}-${line}');`,
                            ).join('\n'),
                        },
                    },
                ],
            },
        ];
        const messages = [
            { role: 'user', content: 'verify the finding' },
            ...Array.from({ length: 8 }, (_, i) => read(i)).flat(),
        ];
        expect(estimateTextTokens(JSON.stringify(messages))).toBeGreaterThan(
            16_000,
        );
        for (const [spec] of verifyRuns) {
            const directives = await Promise.all(
                spec.policies.map((p) =>
                    p.prepareStep?.({ messages, stepNumber: 8 } as any),
                ),
            );
            const sent = directives.find((d) => d?.messages)?.messages;
            expect(sent).toBeDefined();
            expect(
                estimateTextTokens(JSON.stringify(sent)),
            ).toBeLessThanOrEqual(16_000);
        }
    });
});

describe('runFinderWithVerify on a check model of its own (#2233)', () => {
    it("shortens each verify run to the check model's window, not the finder's", async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
            compressor: new ContextWindowCompressor(64_000),
        });
        const verifyRunner = new AiSdkAgentRunner(undefined);
        const verifyRun = jest.spyOn(verifyRunner, 'run');

        await runFinderWithVerify(
            {
                runner: new AiSdkAgentRunner(undefined),
                finderSpec,
                modelId: 'mock',
                tools,
                skipHeavyPasses: true,
                verifyRunner,
                verifyModelId: 'small-check-model',
                verifyCompressor: new ContextWindowCompressor(8_000),
            },
            { prompt: 'review' },
            ctx,
        );

        expect(verifyRun).toHaveBeenCalled();
        const messages = [
            { role: 'user', content: 'verify the finding' },
            ...Array.from({ length: 6 }, (_, i) => [
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool-call',
                            toolCallId: `r${i}`,
                            toolName: 'readFile',
                            input: { path: `src/f${i}.ts` },
                        },
                    ],
                },
                {
                    role: 'tool',
                    content: [
                        {
                            type: 'tool-result',
                            toolCallId: `r${i}`,
                            toolName: 'readFile',
                            output: {
                                type: 'text',
                                value: Array.from(
                                    { length: 300 },
                                    (_, line) =>
                                        `${line + 1}: export const v${line} = load('${i}-${line}');`,
                                ).join('\n'),
                            },
                        },
                    ],
                },
            ]).flat(),
        ];
        const before = estimateTextTokens(JSON.stringify(messages));
        expect(before).toBeGreaterThan(8_000);
        expect(before).toBeLessThan(64_000 * 0.7);
        for (const [spec] of verifyRun.mock.calls) {
            const directives = await Promise.all(
                spec.policies.map((p) =>
                    p.prepareStep?.({ messages, stepNumber: 6 } as any),
                ),
            );
            const sent = directives.find((d) => d?.messages)?.messages;
            expect(sent).toBeDefined();
            expect(
                estimateTextTokens(JSON.stringify(sent)),
            ).toBeLessThanOrEqual(8_000);
        }
    });
});

describe('runFinderWithVerify on a check runner with no window guard of its own', () => {
    it("keeps the finder's compression on every verify run", async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
            compressor: new ContextWindowCompressor(16_000),
        });
        const verifyRunner = new AiSdkAgentRunner(undefined);
        const verifyRun = jest.spyOn(verifyRunner, 'run');

        await runFinderWithVerify(
            {
                runner: new AiSdkAgentRunner(undefined),
                finderSpec,
                modelId: 'mock',
                tools,
                skipHeavyPasses: true,
                verifyRunner,
            },
            { prompt: 'review' },
            ctx,
        );

        expect(verifyRun).toHaveBeenCalled();
        for (const [spec] of verifyRun.mock.calls) {
            expect(spec.policies.some((p) => p.name === 'compression')).toBe(
                true,
            );
        }
    });
});

describe('runFinderWithVerify — repo_instruction findings', () => {
    // The verifier is told to drop a quote it cannot find, and did not always:
    // a PR that adds an instruction to CLAUDE.md is not checked against it.
    it('drops a kept finding whose quote is not in the target-branch instructions', async () => {
        const findings = {
            reasoning: 'two convention breaks',
            suggestions: [
                {
                    relevantFile: 'a.ts',
                    label: 'repo_instruction',
                    suggestionContent:
                        'CLAUDE.md says "Amounts are integer cents."',
                    existingCode: 'x',
                    improvedCode: 'y',
                    severity: 'medium',
                },
                {
                    relevantFile: 'b.ts',
                    label: 'repo_instruction',
                    suggestionContent:
                        'CLAUDE.md says "Use isinstance() instead of getattr on unions."',
                    existingCode: 'p',
                    improvedCode: 'q',
                    severity: 'medium',
                },
            ],
        };
        mockResolve.mockImplementation(() => ({
            model: new MockLanguageModelV3({
                doGenerate: (async (opts: any) => {
                    const sys = JSON.stringify(opts?.prompt ?? '');
                    const tc = sys.includes('REFUTE')
                        ? {
                              id: 'v',
                              name: 'submitVerdict',
                              input: { keep: true, rationale: 'ok' },
                          }
                        : { id: 'f', name: 'submitResult', input: findings };
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
                }) as any,
            }),
            callOptions: {},
            providerOptions: {},
            modelName: 'mock',
            usageIdentity: {},
        }));
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
        });

        const r = await runFinderWithVerify(
            {
                runner: new AiSdkAgentRunner(undefined),
                finderSpec,
                modelId: 'mock',
                tools,
                repoInstructions: {
                    files: [
                        {
                            path: 'CLAUDE.md',
                            content: 'Amounts are integer cents.',
                            appliesTo: '**',
                            truncated: false,
                        },
                    ],
                    otherFiles: [],
                    dropped: [],
                    truncated: false,
                    indexedCount: 1,
                },
            },
            { prompt: 'review' },
            ctx,
        );

        expect(r.kept.map((f) => f.relevantFile)).toEqual(['a.ts']);
        expect(r.droppedByVerify.map((d) => d.finding.relevantFile)).toEqual([
            'b.ts',
        ]);
        expect(r.droppedByVerify[0].evidence).toMatch(
            /not in the target-branch/,
        );
    });
});

// A convention break reported under another label (a `bug` quoting
// apps/billing/CLAUDE.md) gets the same check as a repo_instruction finding:
// it must quote the target branch, or it is dropped.
describe('runFinderWithVerify — findings that cite an instruction file under another label', () => {
    const instructions = {
        files: [
            {
                path: 'CLAUDE.md',
                content: 'Amounts are integer cents.',
                appliesTo: '**',
                truncated: false,
            },
            {
                path: 'docs/shared-guide.md',
                content: 'Every thrown error must be a DomainError.',
                appliesTo: '**',
                truncated: false,
            },
        ],
        otherFiles: [],
        dropped: [],
        truncated: false,
        indexedCount: 2,
    };
    const finding = (relevantFile: string, suggestionContent: string) => ({
        relevantFile,
        label: 'bug',
        suggestionContent,
        existingCode: 'x',
        improvedCode: 'y',
        severity: 'high',
    });

    let verifierPrompts: string[] = [];
    const run = async (
        suggestions: unknown[],
        repoInstructions?: typeof instructions,
        extra: Record<string, unknown> = {},
    ) => {
        verifierPrompts = [];
        mockResolve.mockImplementation(() => ({
            model: new MockLanguageModelV3({
                doGenerate: (async (opts: any) => {
                    const sys = JSON.stringify(opts?.prompt ?? '');
                    if (sys.includes('REFUTE')) verifierPrompts.push(sys);
                    const tc = sys.includes('REFUTE')
                        ? {
                              id: 'v',
                              name: 'submitVerdict',
                              input: { keep: true, rationale: 'ok' },
                          }
                        : {
                              id: 'f',
                              name: 'submitResult',
                              input: { reasoning: 'r', suggestions },
                          };
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
                }) as any,
            }),
            callOptions: {},
            providerOptions: {},
            modelName: 'mock',
            usageIdentity: {},
        }));
        const tools = new InMemoryToolRegistry([]);
        return runFinderWithVerify(
            {
                runner: new AiSdkAgentRunner(undefined),
                finderSpec: buildFinderAgentSpec({
                    systemPrompt: 'find bugs',
                    modelId: 'mock',
                    tools,
                    coverageLedger: noCriticalLedger,
                }),
                modelId: 'mock',
                tools,
                ...(repoInstructions ? { repoInstructions } : {}),
                ...extra,
            },
            { prompt: 'review' },
            ctx,
        );
    };

    it('relabels one that quotes the target branch as repo_instruction', async () => {
        const r = await run(
            [
                finding(
                    'a.ts',
                    'docs/shared-guide.md says "Every thrown error must be a DomainError." This throws a bare Error.',
                ),
            ],
            instructions,
        );

        expect(r.kept.map((f) => [f.relevantFile, f.label])).toEqual([
            ['a.ts', 'repo_instruction'],
        ]);
    });

    // Relabeled before verify, so the verifier judges it as an instruction
    // finding: against the file's text, its appliesTo and the changed line.
    it('verifies a relabeled finding as repo_instruction, with the instructions', async () => {
        await run(
            [
                finding(
                    'a.ts',
                    'docs/shared-guide.md says "Every thrown error must be a DomainError." This throws a bare Error.',
                ),
            ],
            instructions,
        );

        expect(verifierPrompts.length).toBeGreaterThan(0);
        expect(
            verifierPrompts.every(
                (p) =>
                    p.includes('Label: repo_instruction') &&
                    p.includes('RepositoryInstructions'),
            ),
        ).toBe(true);
    });

    it('drops one that does not quote the target branch before verify', async () => {
        await run(
            [
                finding(
                    'a.ts',
                    'CLAUDE.md, added in this PR, says "Never use let."',
                ),
            ],
            instructions,
        );

        expect(verifierPrompts).toEqual([]);
    });

    it('drops one whose quote is not on the target branch', async () => {
        const r = await run(
            [
                finding(
                    'a.ts',
                    'CLAUDE.md, added in this PR, says "Never use let." This uses let.',
                ),
            ],
            instructions,
        );

        expect(r.kept).toEqual([]);
        expect(r.droppedByVerify[0].evidence).toMatch(/instruction file/);
    });

    it('drops one when the setting is off', async () => {
        const r = await run([
            finding(
                'a.ts',
                'apps/billing/CLAUDE.md requires integer cents: "Amounts are integer cents."',
            ),
        ]);

        expect(r.kept).toEqual([]);
        expect(r.droppedByVerify.map((d) => d.finding.relevantFile)).toEqual([
            'a.ts',
        ]);
    });

    // A custom agent's guides can be the same files; its findings take the
    // convention check instead.
    it('leaves a custom agent finding alone', async () => {
        const r = await run(
            [
                finding(
                    'a.ts',
                    'AGENTS.md, linked to this agent, asks for the logger here.',
                ),
            ],
            undefined,
            { checksInstructionCitations: false },
        );

        expect(r.kept.map((f) => [f.relevantFile, f.label])).toEqual([
            ['a.ts', 'bug'],
        ]);
    });

    // Code that handles these files names them; a bug there is a bug, with
    // the setting on or off.
    it.each([
        ['off', undefined],
        ['on', instructions],
    ])(
        'keeps a bug about code that handles instruction files (setting %s)',
        async (_label, repoInstructions) => {
            const r = await run(
                [
                    {
                        ...finding(
                            'loader.ts',
                            'The glob `**/AGENTS.md` misses nested AGENTS.md files, so loadInstructions() returns [] for apps/*.',
                        ),
                        existingCode: "glob.sync('**/AGENTS.md', { deep: 1 })",
                    },
                    {
                        ...finding(
                            'config.ts',
                            "readFileSync('CLAUDE.md') throws ENOENT when the repo has no CLAUDE.md; wrap it in existsSync.",
                        ),
                        existingCode: "readFileSync('CLAUDE.md', 'utf8')",
                    },
                    finding(
                        'parser.ts',
                        'The parser drops .cursor/rules/api.mdc frontmatter when globs is unquoted.',
                    ),
                ],
                repoInstructions,
            );

            expect(r.kept.map((f) => [f.relevantFile, f.label])).toEqual([
                ['loader.ts', 'bug'],
                ['config.ts', 'bug'],
                ['parser.ts', 'bug'],
            ]);
        },
    );

    it('leaves alone a finding on the instruction file itself, and one that cites none', async () => {
        const r = await run([
            finding(
                'CLAUDE.md',
                'CLAUDE.md links to docs/missing.md, which does not exist.',
            ),
            finding('b.ts', 'The loop reads past the end of the array.'),
        ]);

        expect(r.kept.map((f) => [f.relevantFile, f.label])).toEqual([
            ['CLAUDE.md', 'bug'],
            ['b.ts', 'bug'],
        ]);
    });
});

describe('buildFinderAgentSpec — label enum', () => {
    const labelEnum = (labels?: string[]) => {
        const spec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools: new InMemoryToolRegistry([]),
            coverageLedger: noCriticalLedger,
            ...(labels ? { labels: labels as any } : {}),
        });
        const submit = spec.tools
            .list()
            .find((t) => t.name === 'submitResult') as any;
        return submit.inputSchema.properties.suggestions.items.properties.label
            .enum;
    };

    it('offers the labels it is given', () => {
        expect(labelEnum(['bug', 'security', 'performance'])).toEqual([
            'bug',
            'security',
            'performance',
        ]);
        expect(labelEnum(['bug', 'repo_instruction'])).toEqual([
            'bug',
            'repo_instruction',
        ]);
    });

    it('offers every label when given none it knows', () => {
        const all = ['bug', 'security', 'performance', 'repo_instruction'];
        expect(labelEnum()).toEqual(all);
        expect(labelEnum(['custom_agent'])).toEqual(all);
    });
});

describe('runFinderWithVerify (generalist failed at the provider)', () => {
    it('stops the lenses and skips verify when the runner returns an error state', async () => {
        // The AI SDK runner reports a provider throw as `status: 'error'`
        // instead of throwing, so the kind of failure #2453 describes never
        // reached the catch that stops the lenses. They kept running, verify
        // spent tokens on their findings, and the caller discarded both with
        // the generalist's error.
        let lensAborted = false;
        let lensStarted = false;
        const run = jest.fn().mockResolvedValue({
            status: 'error',
            steps: [],
            toolCalls: [],
            artifacts: [],
            usage: {
                inputTokens: 10,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheReadTokens: 0,
            },
            error: {
                message: 'The provider refused the request for this model',
            },
        });

        const r = await runFinderWithVerify(
            {
                runner: { run } as any,
                finderSpec: {} as any,
                modelId: 'mock',
                tools: new InMemoryToolRegistry([]),
                heavyLenses: (_params, lensCtx) => {
                    lensStarted = true;
                    return new Promise<any>((resolve) => {
                        lensCtx.signal.addEventListener('abort', () => {
                            lensAborted = true;
                            resolve({
                                suggestions: [],
                                usage: {
                                    inputTokens: 99,
                                    outputTokens: 0,
                                    reasoningTokens: 0,
                                    cacheReadTokens: 0,
                                },
                                passStats: [],
                                investigatedFiles: new Set<string>(),
                                outcomes: [],
                            });
                        });
                    });
                },
            },
            { prompt: 'review' },
            ctx,
        );

        expect(lensStarted).toBe(true);
        expect(lensAborted).toBe(true);
        expect(r.finderState.status).toBe('error');
        expect(r.kept).toEqual([]);
        // Only the generalist ran: no recall pass, no verify.
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('does not verify a settled lens when the generalist failed', async () => {
        // The abort cannot unsend a lens that already answered: without the
        // status gate its findings would reach verify and spend tokens on a
        // review the caller throws away.
        const lensFinding = {
            relevantFile: 'src/lens.ts',
            suggestionContent: 'the lens found this',
            label: 'bug',
        } as any;
        const run = jest.fn().mockResolvedValue({
            status: 'error',
            steps: [],
            toolCalls: [],
            artifacts: [],
            usage: {
                inputTokens: 10,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheReadTokens: 0,
            },
            error: { message: 'the provider refused the request' },
        });

        const r = await runFinderWithVerify(
            {
                runner: { run } as any,
                finderSpec: {} as any,
                modelId: 'mock',
                tools: new InMemoryToolRegistry([]),
                heavyLenses: async () =>
                    ({
                        suggestions: [lensFinding],
                        usage: {
                            inputTokens: 5,
                            outputTokens: 0,
                            reasoningTokens: 0,
                            cacheReadTokens: 0,
                        },
                        passStats: [],
                        investigatedFiles: new Set<string>(),
                        outcomes: [],
                    }) as any,
            },
            { prompt: 'review' },
            ctx,
        );

        expect(r.kept).toEqual([]);
        expect(r.kept).not.toContain(lensFinding);
        // The generalist is the only runner call: no verify was started.
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('keeps what the failed generalist salvaged', async () => {
        // Only the base provider throws on this status; the security scan
        // keeps the partial result, so the prose recovery still has to run.
        const recovered = {
            relevantFile: 'src/recovered.ts',
            suggestionContent: 'recovered from the reasoning prose',
            label: 'bug',
        } as any;
        const run = jest.fn().mockResolvedValue({
            status: 'error',
            steps: [],
            toolCalls: [],
            artifacts: [],
            usage: {
                inputTokens: 10,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheReadTokens: 0,
            },
            error: { message: 'the provider refused the request' },
        });

        const r = await runFinderWithVerify(
            {
                runner: { run } as any,
                finderSpec: {} as any,
                modelId: 'mock',
                tools: new InMemoryToolRegistry([]),
                recoverProse: async () => [recovered],
            },
            { prompt: 'review' },
            ctx,
        );

        expect(r.kept).toEqual([recovered]);
        expect(r.keptParseMode).toEqual(['default-keep']);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('rethrows a lens failure that is not the abort', async () => {
        const run = jest.fn().mockResolvedValue({
            status: 'success',
            steps: [],
            toolCalls: [],
            artifacts: [],
            usage: {
                inputTokens: 1,
                outputTokens: 1,
                reasoningTokens: 0,
                cacheReadTokens: 0,
            },
        });

        await expect(
            runFinderWithVerify(
                {
                    runner: { run } as any,
                    finderSpec: {} as any,
                    modelId: 'mock',
                    tools: new InMemoryToolRegistry([]),
                    heavyLenses: async () => {
                        // Reject once the pipeline is awaiting it: an already
                        // rejected promise would be reported as unhandled.
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        throw new Error('sandbox lease superseded');
                    },
                },
                { prompt: 'review' },
                ctx,
            ),
        ).rejects.toThrow('sandbox lease superseded');
    });
});
