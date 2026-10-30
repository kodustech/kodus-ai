/**
 * CONTRACT tests for the LLM.run boundary of BaseCodeReviewAgentProvider.
 *
 * The provider does not call `LLM.run` directly — it assembles the request
 * (`loopParams` built field-by-field + `byokConfig` threaded through
 * `loopSecrets`), delegates to the harness engine `runAgentLoopViaCore`
 * (THE LLM.run boundary here — declared output schema D = `AgentLoopOutput`
 * with `findings.suggestions`), then parses the envelope through the pure
 * `mapAgentFindings` and fails safe through `providerErrorFromResult` + a
 * try/catch. The guaranteed return shape is `ReviewAgentOutput`.
 *
 * SCOPE = the DETERMINISTIC layer only: request assembly (exact args /
 * byokConfig threading), envelope parsing (`mapAgentFindings`), fail-safe
 * (harness throw / error-result / abort → classify + re-throw, never a silent
 * empty review), and the always-returned declared shape. We DO NOT test the
 * model's decision quality.
 *
 * The raw text→JSON envelope cases (wrapper keys, stringified/markdown/prose,
 * truncated/malformed JSON) are owned by the harness parse layer / structured-
 * output gate (`libs/llm/structured-output-gate.spec.ts`,
 * `verifier.agent.contract.spec.ts`); per-finding mapping is owned by
 * `finding-mapper.spec.ts`. This boundary consumes the fixed `AgentLoopOutput`
 * envelope.
 */

// ── Mock the collaborators around the boundary (same specifiers the SUT uses) ──
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/model-factory',
    () => ({ resolveReviewAgentModel: jest.fn() }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter',
    () => ({ runAgentLoopViaCore: jest.fn() }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/review-observability',
    () => ({ runAgentWithTrace: jest.fn() }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/batch-runner',
    () => ({ runChunkedReview: jest.fn() }),
);

import { BaseCodeReviewAgentProvider } from './base-code-review-agent.provider';
import { mapAgentFindings } from '@libs/code-review/infrastructure/agents/collaborators/finding-mapper';
import { resolveReviewAgentModel } from '@libs/code-review/infrastructure/agents/collaborators/model-factory';
import { runAgentLoopViaCore } from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';
import { runAgentWithTrace } from '@libs/code-review/infrastructure/agents/collaborators/review-observability';
import { runChunkedReview } from '@libs/code-review/infrastructure/agents/collaborators/batch-runner';
import { getClassification } from '@libs/llm/error-classifier';
import type {
    ReviewAgentInput,
    AgentProgressEvent,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';

const resolveModelMock = resolveReviewAgentModel as jest.Mock;
const runLoopMock = runAgentLoopViaCore as jest.Mock;
const runTraceMock = runAgentWithTrace as jest.Mock;
const runChunkedMock = runChunkedReview as jest.Mock;

// ── Concrete subclass under test (abstract base) ─────────────────────────────
class TestReviewAgent extends BaseCodeReviewAgentProvider {
    protected getIdentity() {
        return {
            name: 'kodus-bug-review-agent',
            description: 'finds bugs',
            goal: 'find bugs',
            expertise: ['bugs'],
        };
    }
    protected getCategoryPrompt(): string {
        return 'Find bugs in the diff.';
    }
    protected getCategoryLabel(): string {
        return 'bug';
    }
}

// A generalist-style subclass that emits per-finding labels (supportsMixed).
class MixedReviewAgent extends BaseCodeReviewAgentProvider {
    protected getIdentity() {
        return {
            name: 'kodus-generalist',
            description: 'g',
            goal: 'g',
            expertise: ['x'],
        };
    }
    protected getCategoryPrompt(): string {
        return 'Review.';
    }
    protected getCategoryLabel(): string {
        return 'generalist';
    }
    protected supportsMixedLabels(): boolean {
        return true;
    }
    protected getAllowedSuggestionLabels() {
        return ['bug', 'security', 'performance'] as Array<
            'bug' | 'security' | 'performance'
        >;
    }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CHANGED_FILE = {
    filename: 'src/a.ts',
    patch: '@@ -1,2 +1,3 @@\n+const x = 1;',
    patchWithLinesStr: '@@ -1,2 +1,3 @@\n+const x = 1;',
} as any;

function makeInput(
    overrides: Partial<ReviewAgentInput> = {},
): ReviewAgentInput {
    return {
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        },
        changedFiles: [CHANGED_FILE],
        prNumber: 42,
        repositoryId: 'repo-1',
        repositoryFullName: 'acme/repo',
        prTitle: 'Add feature',
        prBody: 'body',
        baseBranch: 'main',
        languageResultPrompt: 'en-US',
        remoteCommands: undefined,
        ...overrides,
    } as ReviewAgentInput;
}

function makeModel(overrides: any = {}) {
    return {
        byokConfig: { provider: 'openai', model: 'gpt-4o' },
        main: {
            role: 'main',
            modelName: 'openai:gpt-4o',
            maxInputTokens: 1_000_000,
            reasoningEffort: undefined,
            byokProvider: 'openai',
            ...overrides.main,
        },
        ...(overrides.byokConfig !== undefined && {
            byokConfig: overrides.byokConfig,
        }),
    };
}

function makeHarnessResult(overrides: any = {}): any {
    return {
        findings: {
            reasoning: 'looked at it',
            suggestions: [
                {
                    suggestionContent: 'Null deref on x',
                    relevantFile: 'src/a.ts',
                    oneSentenceSummary: 'null deref',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 2,
                    severity: 'high',
                    existingCode: 'const x',
                    improvedCode: 'const x = 1',
                    language: 'typescript',
                },
            ],
        },
        text: 'looked at it',
        steps: 5,
        toolCalls: [
            {
                tool: 'readFile',
                toolName: 'readFile',
                args: { path: 'src/a.ts' },
            },
        ],
        finishReason: 'stop',
        source: 'json-parse',
        usage: {
            inputTokens: 1000,
            cacheReadTokens: 100,
            cacheWriteTokens: 0,
            outputTokens: 200,
            reasoningTokens: 50,
            totalTokens: 1200,
        },
        discardedBySeverity: [],
        droppedByVerify: [],
        coverage: { covered: 1, total: 1 },
        verification: null,
        anomalies: {
            stepsLe2: false,
            zeroToolCalls: false,
            zeroStrongEvidenceFiles: false,
            zeroCoverage: false,
            lowCoverage: false,
            lowStrongEvidenceFiles: false,
        },
        warnings: [],
        ...overrides,
    };
}

function mapperCtx(overrides: any = {}) {
    return {
        changedFiles: [{ filename: 'src/a.ts' }] as any,
        kodyRules: [],
        prNumber: 1,
        isKodyRules: false,
        identityName: 'test',
        labelPolicy: {
            categoryLabel: 'bug',
            allowedLabels: ['bug'] as Array<'bug' | 'security' | 'performance'>,
            supportsMixed: false,
        },
        logger: { warn: jest.fn() },
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    resolveModelMock.mockResolvedValue(makeModel());
    runLoopMock.mockResolvedValue(makeHarnessResult());
    // runAgentWithTrace is a transparent passthrough here (Langfuse tracing is
    // exercised separately); it must invoke the real fn so the loop mock runs.
    runTraceMock.mockImplementation(
        (_meta: any, _spanInput: any, fn: () => any) => fn(),
    );
    runChunkedMock.mockResolvedValue({
        suggestions: [],
        agentName: 'kodus-bug-review-agent',
        agentCategory: 'bug',
        turnsUsed: 0,
        durationMs: 1,
    });
});

function newAgent(byokErrorCounter?: any, docSearch?: any) {
    return new TestReviewAgent(
        {} as any,
        {} as any,
        docSearch,
        byokErrorCounter,
    );
}

// ════════════════════════════════════════════════════════════════════════════
// A. Output-shape zoo — how the boundary consumes the AgentLoopOutput envelope
//    and its findings.suggestions payload.
// ════════════════════════════════════════════════════════════════════════════
describe('a built-in agent that answered in prose', () => {
    // Prose recovery owns a built-in agent's run without submitResult (#2171);
    // only a custom agent reads it as stopped early.
    it('is not marked as stopped early', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { reasoning: 'nothing to report', suggestions: [] },
                submittedResult: false,
            }),
        );

        const out = await newAgent().execute(makeInput());

        expect(out.hitHardLimit).toBe(false);
        expect(out.finishReason).toBe('stop');
    });
});

describe('A. output-shape zoo', () => {
    // Row 1 — exact D, happy path. Side effect (mapping) must be exact.
    it('row 1: exact D → maps the suggestion faithfully and returns declared shape', async () => {
        const out = await newAgent().execute(makeInput());
        expect(out.suggestions).toHaveLength(1);
        expect(out.suggestions[0]).toMatchObject({
            relevantFile: 'src/a.ts',
            suggestionContent: 'Null deref on x',
            label: 'bug',
            severity: 'high',
            relevantLinesStart: 1,
            relevantLinesEnd: 2,
        });
        // Guaranteed return shape.
        expect(out).toMatchObject({
            agentName: 'kodus-bug-review-agent',
            agentCategory: 'bug',
            finishReason: 'stop',
            hitHardLimit: false,
        });
        expect(typeof out.turnsUsed).toBe('number');
        expect(typeof out.durationMs).toBe('number');
        expect(Array.isArray(out.warnings)).toBe(true);
    });

    it('row 3 (execute): single-object suggestions → execute fails explicitly', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { suggestions: { suggestionContent: 'x' } },
            }),
        );
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();
    });

    // Row 13 — extra unknown keys tolerated (not crash, not leaked verbatim).
    it('row 13: extra unknown keys tolerated', () => {
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        {
                            suggestionContent: 'x',
                            relevantFile: 'src/a.ts',
                            bogusKey: 'ignore me',
                            another: { nested: true },
                        } as any,
                    ],
                },
            } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions).toHaveLength(1);
        expect((mapped.suggestions[0] as any).bogusKey).toBeUndefined();
    });

    // Row 25 — dangling reference: relevantFile not in the PR → dropped WITH a
    // warn (explicit signal), never silently kept against a wrong file.
    it('row 25: relevantFile not in changedFiles → dropped and a @@PATH_MISMATCH@@ warn is logged', () => {
        const warn = jest.fn();
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        {
                            suggestionContent: 'x',
                            relevantFile: 'src/GHOST.ts',
                        } as any,
                    ],
                },
            } as any,
            mapperCtx({ logger: { warn } }) as any,
        );
        expect(mapped.suggestions).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('@@PATH_MISMATCH@@'),
            }),
        );
    });

    // Row 17 — null / undefined return from the boundary.
    it('row 17: null/undefined harness result → execute fails explicitly (never silent success)', async () => {
        runLoopMock.mockResolvedValue(null as any);
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();

        runLoopMock.mockResolvedValue(undefined as any);
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Unparseable / transport — the fail-safe layer. Never throw a bare crash
//    past classification; never mask a provider failure as a clean empty review.
// ════════════════════════════════════════════════════════════════════════════
describe('C. transport / fail-safe', () => {
    // Row 30 — LLM.run (the harness) throws → classify + emit progress error +
    // re-throw. It must NOT be swallowed into a clean empty review.
    it('row 30: harness throws → execute re-throws with a classification attached and emits an error progress event', async () => {
        const events: AgentProgressEvent[] = [];
        runLoopMock.mockRejectedValue(new Error('ECONNRESET socket hang up'));
        await expect(
            newAgent().execute(
                makeInput({ onAgentProgress: (e) => events.push(e) }),
            ),
        ).rejects.toThrow('ECONNRESET socket hang up');

        const errEvent = events.find((e) => e.status === 'error');
        expect(errEvent).toBeDefined();
        expect(errEvent?.errorFriendlyMessage).toBeTruthy();
    });

    it('row 30: the thrown error carries a classification (getClassification is truthy)', async () => {
        runLoopMock.mockRejectedValue(new Error('network down'));
        let thrown: unknown;
        try {
            await newAgent().execute(makeInput());
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(getClassification(thrown)).toBeDefined();
    });

    // Row 31 — error object returned instead of a throw: the harness swallows a
    // provider throw into finishReason:'error'. providerErrorFromResult must
    // reconstruct a throwable so the run fails LOUDLY (with status/body threaded
    // for classification — #1568).
    it('row 31: finishReason "error" result → reconstructed throw carries message + statusCode + responseBody', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                finishReason: 'error',
                errorMessage: 'model not found',
                errorName: 'NotFoundError',
                errorStatus: 404,
                errorResponseBody: '{"error":"unknown model"}',
            }),
        );
        let thrown: any;
        try {
            await newAgent().execute(makeInput());
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.message).toBe('model not found');
        expect(thrown.statusCode).toBe(404);
        expect(thrown.responseBody).toBe('{"error":"unknown model"}');
    });

    // Row 32 — empty success (a finder that finished and found nothing) is a
    // legitimate empty review; a finder that ended without submitting is a
    // cut-short and must be flagged. The loop result carries the harness
    // RunStatus, as the adapter emits it — these rows used to mock 'tool-calls'
    // and 'timeout', values the adapter never produces (#2171).
    it('row 32: empty-success stop → typed-empty, hitHardLimit false, finishReason stop', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { suggestions: [] },
                source: 'empty',
                finishReason: 'stopped',
            }),
        );
        const out = await newAgent().execute(makeInput());
        expect(out.suggestions).toEqual([]);
        expect(out.hitHardLimit).toBe(false);
        expect(out.finishReason).toBe('stop');
    });

    it('row 32: aborted by the per-agent timeout → the agent fails, it does not read as cut short', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { suggestions: [] },
                source: 'empty',
                finishReason: 'error',
                errorMessage: 'This operation was aborted',
                errorName: 'AbortError',
            }),
        );
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();
    });

    // Row 34 — the parentSignal must be threaded to the loop so the per-agent
    // timeout can abort it.
    it('row 34: parentSignal is threaded into loopParams', async () => {
        const controller = new AbortController();
        await newAgent().execute(
            makeInput({ parentSignal: controller.signal }),
        );
        const [loopParams] = runLoopMock.mock.calls[0];
        expect(loopParams.parentSignal).toBe(controller.signal);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// D. Input variants — feed the boundary with a happy harness mock and assert
//    the invariant holds.
// ════════════════════════════════════════════════════════════════════════════
describe('D. input variants', () => {
    // Row 35 — empty input (0 changed files).
    it('row 35: empty changedFiles → runs a single batch and returns declared shape', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({ findings: { suggestions: [] } }),
        );
        const out = await newAgent().execute(makeInput({ changedFiles: [] }));
        expect(runLoopMock).toHaveBeenCalledTimes(1);
        expect(runChunkedMock).not.toHaveBeenCalled();
        expect(out.suggestions).toEqual([]);
    });

    it('row 39: changedFile with null filename does not crash the mapper', () => {
        expect(() =>
            mapAgentFindings(
                { findings: { suggestions: [] } } as any,
                mapperCtx({
                    changedFiles: [
                        { filename: null },
                        { filename: 'src/a.ts' },
                    ],
                }) as any,
            ),
        ).not.toThrow();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Request assembly + byokConfig threading — the deterministic wire-out contract.
// ════════════════════════════════════════════════════════════════════════════
describe('request assembly + byokConfig threading', () => {
    it('threads byokConfig from the resolved model into loopSecrets unchanged', async () => {
        const byokConfig = { provider: 'anthropic', model: 'claude-x' };
        resolveModelMock.mockResolvedValue(
            makeModel({ byokConfig, main: { byokProvider: 'anthropic' } }),
        );
        await newAgent().execute(makeInput());
        const [, loopSecrets] = runLoopMock.mock.calls[0];
        expect(loopSecrets.byokConfig).toBe(byokConfig);
        expect(loopSecrets.documentationSearchOptions.byokConfig).toBe(
            byokConfig,
        );
    });

    it('assembles the request with the system + user prompts and category usageRunName', async () => {
        await newAgent().execute(makeInput());
        const [loopParams] = runLoopMock.mock.calls[0];
        expect(typeof loopParams.systemPrompt).toBe('string');
        expect(loopParams.systemPrompt.length).toBeGreaterThan(0);
        expect(typeof loopParams.userPrompt).toBe('string');
        expect(loopParams.userPrompt.length).toBeGreaterThan(0);
        expect(loopParams.usageRunName).toBe('code-review-bug');
        expect(loopParams.agentName).toBe('kodus-bug-review-agent');
    });

    it('forwards model params (modelName, byokProvider, reasoning, contextWindow) onto the wire', async () => {
        resolveModelMock.mockResolvedValue(
            makeModel({
                main: {
                    modelName: 'openai:gpt-4o',
                    byokProvider: 'openai',
                    reasoningEffort: 'high',
                    maxInputTokens: 200_000,
                },
            }),
        );
        await newAgent().execute(makeInput());
        const [loopParams] = runLoopMock.mock.calls[0];
        expect(loopParams.modelName).toBe('openai:gpt-4o');
        expect(loopParams.byokProvider).toBe('openai');
        expect(loopParams.reasoningEffort).toBe('high');
        expect(loopParams.byokRole).toBe('main');
        expect(loopParams.contextWindowTokens).toBe(200_000);
    });

    it('wires byokErrorReporter → ByokErrorCounter.record when the counter is injected', async () => {
        const counter = { record: jest.fn() };
        await newAgent(counter).execute(makeInput());
        const [, loopSecrets] = runLoopMock.mock.calls[0];
        expect(typeof loopSecrets.byokErrorReporter).toBe('function');
        loopSecrets.byokErrorReporter({
            organizationId: 'org-1',
            provider: 'openai',
            errorMessage: 'boom',
        });
        expect(counter.record).toHaveBeenCalledTimes(1);
    });

    it('forwards heavy-pass / synthesis-rescue flags explicitly', async () => {
        await newAgent().execute(
            makeInput({
                skipHeavyPasses: true,
                skipSynthesisRescue: true,
                maxSteps: 33,
            }),
        );
        const [loopParams] = runLoopMock.mock.calls[0];
        expect(loopParams.skipHeavyPasses).toBe(true);
        expect(loopParams.skipSynthesisRescue).toBe(true);
        expect(loopParams.maxSteps).toBe(33);
    });

    it('forwards previousDecisions onto loopParams explicitly (issue #1313)', async () => {
        const previousDecisions = [
            {
                suggestionId: 'sug-1',
                relevantFile: 'a.ts',
                suggestionContent: 'Use const instead of let.',
                label: 'bug',
                outcome: 'implemented' as const,
                decidedAt: '2026-01-01T00:00:00.000Z',
            },
        ];

        await newAgent().execute(makeInput({ previousDecisions }));
        const [loopParams] = runLoopMock.mock.calls[0];
        expect(loopParams.previousDecisions).toBe(previousDecisions);
    });

    describe('listsRepoInstructions', () => {
        const repoInstructions = {
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
        };

        class InstructionsAgent extends BaseCodeReviewAgentProvider {
            protected getIdentity() {
                return {
                    name: 'kodus-generalist',
                    description: 'g',
                    goal: 'g',
                    expertise: ['x'],
                };
            }
            protected getCategoryPrompt(): string {
                return 'Review.';
            }
            protected getCategoryLabel(): string {
                return 'generalist';
            }
            protected supportsMixedLabels(): boolean {
                return true;
            }
            protected getAllowedSuggestionLabels() {
                return ['bug', 'repo_instruction'] as Array<
                    'bug' | 'repo_instruction'
                >;
            }
        }

        it('is set when the agent may report repo_instruction, so its prompt lists the files', async () => {
            await new InstructionsAgent({} as any, {} as any).execute(
                makeInput({ repoInstructions }),
            );
            const [loopParams] = runLoopMock.mock.calls[0];
            expect(loopParams.listsRepoInstructions).toBe(true);
            expect(loopParams.repoInstructions).toBe(repoInstructions);
        });

        // The finder's output schema offers the same labels as its prompt.
        it('hands the agent loop the labels the agent may report', async () => {
            await new InstructionsAgent({} as any, {} as any).execute(
                makeInput({ repoInstructions }),
            );
            const [loopParams] = runLoopMock.mock.calls[0];
            expect(loopParams.allowedLabels).toEqual([
                'bug',
                'repo_instruction',
            ]);
        });

        it('is not set for an agent that may not report repo_instruction', async () => {
            await newAgent().execute(makeInput({ repoInstructions }));
            const [loopParams] = runLoopMock.mock.calls[0];
            expect(loopParams.listsRepoInstructions).toBe(false);
            expect(loopParams.repoInstructions).toBe(repoInstructions);
        });

        it('is not set when no instructions were collected', async () => {
            await new InstructionsAgent({} as any, {} as any).execute(
                makeInput(),
            );
            const [loopParams] = runLoopMock.mock.calls[0];
            expect(loopParams.listsRepoInstructions).toBe(false);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Mixed-label policy (generalist) — label routing lives at the parse layer too.
// ════════════════════════════════════════════════════════════════════════════
describe('mixed-label reviewer', () => {
    it('honors an allowed per-finding label and returns declared shape', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: {
                    suggestions: [
                        {
                            suggestionContent: 'sql injection',
                            relevantFile: 'src/a.ts',
                            label: 'security',
                            severity: 'critical',
                        },
                    ],
                },
            }),
        );
        const agent = new MixedReviewAgent({} as any, {} as any);
        const out = await agent.execute(makeInput());
        expect(out.suggestions[0].label).toBe('security');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Losses the run records (#2066): the review still succeeds, so without a
// warning they read exactly like a full review.
// ════════════════════════════════════════════════════════════════════════════
describe('losses the run records (#2066)', () => {
    it('records findings dropped because the file they named is not in the PR', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: {
                    reasoning: 'r',
                    suggestions: [
                        {
                            suggestionContent: 'Null deref',
                            relevantFile: 'src/not-in-this-pr.ts',
                            oneSentenceSummary: 'null deref',
                            relevantLinesStart: 1,
                            relevantLinesEnd: 2,
                            severity: 'high',
                        },
                    ],
                },
            }),
        );

        const out = await newAgent().execute(makeInput());

        expect(out.suggestions).toHaveLength(0);
        expect(out.warnings).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'SUGGESTIONS_DROPPED_PATH_MISMATCH',
                    reason: 'path_mismatch',
                }),
            ]),
        );
    });

    it('records low-signal files dropped to fit a large PR on a full-size model', async () => {
        resolveModelMock.mockResolvedValue(
            makeModel({ main: { maxInputTokens: 200_000 } }),
        );
        const hugeTest = 'x'.repeat(600_000);

        const out = await newAgent().execute(
            makeInput({
                changedFiles: [
                    CHANGED_FILE,
                    {
                        filename: 'src/a.spec.ts',
                        patch: hugeTest,
                        patchWithLinesStr: hugeTest,
                    } as any,
                ],
            }),
        );

        const dropped = (out.warnings ?? []).find(
            (w) => w.kind === 'LOW_SIGNAL_FILES_DROPPED',
        );
        expect(dropped).toMatchObject({ reason: 'large_pr' });
        expect(dropped?.detail).toContain('1 files dropped');
    });

    it('records nothing for a PR that fits', async () => {
        const out = await newAgent().execute(makeInput());

        expect(out.warnings ?? []).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// #2171 — an agent that did not finish its checks reaches the orchestrator as
// such: incomplete runs carry hitHardLimit, unverified findings are kept apart.
// The loop result carries the harness RunStatus, as the real adapter emits it.
// ════════════════════════════════════════════════════════════════════════════
describe('#2171 incomplete and unverified', () => {
    it('a finder run that ran out of steps reaches the orchestrator as incomplete', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { reasoning: '', suggestions: [] },
                source: 'empty',
                finishReason: 'budget-exhausted',
                incompleteReason: 'budget-exhausted',
            }),
        );

        const out = await newAgent().execute(makeInput());

        expect(out.hitHardLimit).toBe(true);
        expect(out.finishReason).toBe('max-steps');
    });

    it('a finder run the provider truncated reaches the orchestrator as incomplete', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { reasoning: '', suggestions: [] },
                source: 'empty',
                finishReason: 'completed',
                incompleteReason: 'truncated',
            }),
        );

        const out = await newAgent().execute(makeInput());

        expect(out.hitHardLimit).toBe(true);
        expect(out.finishReason).toBe('truncated');
    });

    it('unverified findings come out apart, with a VERIFY_UNAVAILABLE warning', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                finishReason: 'stopped',
                unverifiedByVerify: [
                    {
                        suggestionContent: 'Unchecked claim',
                        relevantFile: 'src/a.ts',
                        oneSentenceSummary: 'unchecked',
                        severity: 'high',
                    },
                ],
            }),
        );

        const out = await newAgent().execute(makeInput());

        expect(out.discardedByVerifyError).toHaveLength(1);
        expect(out.discardedByVerifyError?.[0].relevantFile).toBe('src/a.ts');
        expect(out.suggestions.map((s) => s.suggestionContent)).not.toContain(
            'Unchecked claim',
        );
        expect(out.warnings?.map((w) => w.kind)).toContain(
            'VERIFY_UNAVAILABLE',
        );
    });
});
