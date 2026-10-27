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

describe('runFinderWithVerify — repo_instruction findings', () => {
    it('hands the verifier the repository instructions', async () => {
        const instructionFindings = {
            reasoning: 'one convention break',
            suggestions: [
                {
                    relevantFile: 'a.ts',
                    label: 'repo_instruction',
                    suggestionContent: 'CLAUDE.md says "Amounts are integer cents."',
                    existingCode: 'x',
                    improvedCode: 'y',
                    severity: 'medium',
                },
            ],
        };
        const verifierPrompts: string[] = [];
        mockResolve.mockImplementation(() => ({
            model: new MockLanguageModelV3({
                doGenerate: (async (opts: any) => {
                    const sys = JSON.stringify(opts?.prompt ?? '');
                    const isVerifier = sys.includes('REFUTE');
                    if (isVerifier) verifierPrompts.push(sys);
                    const tc = isVerifier
                        ? { id: 'v', name: 'submitVerdict', input: { keep: true, rationale: 'ok' } }
                        : { id: 'f', name: 'submitResult', input: instructionFindings };
                    return {
                        content: [{ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: JSON.stringify(tc.input) }],
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

        await runFinderWithVerify(
            {
                runner: new AiSdkAgentRunner(undefined),
                finderSpec,
                modelId: 'mock',
                tools,
                repoInstructions: {
                    files: [{ path: 'CLAUDE.md', content: 'Amounts are integer cents.', appliesTo: '**', truncated: false }],
                    otherFiles: [],
                    dropped: [],
                    truncated: false,
                    indexedCount: 1,
                },
            },
            { prompt: 'review' },
            ctx,
        );

        expect(verifierPrompts.length).toBeGreaterThan(0);
        expect(verifierPrompts.every((p) => p.includes('<RepositoryInstructions>'))).toBe(true);
    });

    // The verifier is told to drop a quote it cannot find, and did not always:
    // a PR that adds an instruction to CLAUDE.md is not checked against it.
    it('drops a kept finding whose quote is not in the target-branch instructions', async () => {
        const findings = {
            reasoning: 'two convention breaks',
            suggestions: [
                {
                    relevantFile: 'a.ts',
                    label: 'repo_instruction',
                    suggestionContent: 'CLAUDE.md says "Amounts are integer cents."',
                    existingCode: 'x',
                    improvedCode: 'y',
                    severity: 'medium',
                },
                {
                    relevantFile: 'b.ts',
                    label: 'repo_instruction',
                    suggestionContent: 'CLAUDE.md says "Use isinstance() instead of getattr on unions."',
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
                        ? { id: 'v', name: 'submitVerdict', input: { keep: true, rationale: 'ok' } }
                        : { id: 'f', name: 'submitResult', input: findings };
                    return {
                        content: [{ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: JSON.stringify(tc.input) }],
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
                    files: [{ path: 'CLAUDE.md', content: 'Amounts are integer cents.', appliesTo: '**', truncated: false }],
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
        expect(r.droppedByVerify.map((d) => d.finding.relevantFile)).toEqual(['b.ts']);
        expect(r.droppedByVerify[0].evidence).toMatch(/not in the target-branch/);
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

    const run = async (
        suggestions: unknown[],
        repoInstructions?: typeof instructions,
        extra: Record<string, unknown> = {},
    ) => {
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
