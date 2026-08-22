/**
 * ClassifySessionUseCase — comprehensive spec (single source of truth).
 *
 * Phase 3 (plan 03-01) migrated extractWithLLM off the legacy
 * BYOKPromptRunner LangChain path onto the AI SDK path (runStructuredReviewCall).
 * The LLM response is therefore stubbed at the `tracedGenerateText` seam (the same
 * seam structured-review-call.spec.ts and the former parity spec used) — NOT via a
 * MockLanguageModelV4, which hangs on the structured-output path. runStructuredReviewCall
 * itself runs for real (real schema conversion + model-builder sentinels + span),
 * so the mapping this spec exercises is the migration's actual behavior.
 *
 * Coverage: skip logic, LLM success + byte-for-byte mapping, single-span routing,
 * heuristic fallback, auto-promote, event aggregation, large-session slicing, and
 * duplicate session_end. This file absorbs the former small parity spec
 * (classify-session.use-case.spec.ts) — see the "extractWithLLM mapping parity"
 * block at the bottom.
 */

// Model builders return sentinels — no real model/network is touched.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
    buildModelFromSlot: jest.fn(() => ({ __model: 'managed-default' })),
    getModelName: jest.fn(() => 'managed-default'),
}));
jest.mock('@libs/llm/byok-model-wrapper', () => ({
    wrapByokModel: jest.fn((model: any) => model),
}));
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: jest.fn(),
    timeoutSignal: jest.fn(() => undefined),
    LLM_CALL_TIMEOUT_MS: 600000,
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => ({ isEnabled: false })),
    toAiSdkTelemetryArgs: jest.fn(() => ({ telemetry: { isEnabled: false } })),
}));

import { ClassifySessionUseCase } from '../classify-session.use-case';
import { setLlmObservability } from '@libs/llm/llm-observability';
import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';
import { SessionEventModel } from '@libs/cli-review/infrastructure/repositories/schemas/session-event.model';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

/** Stub the LLM to resolve a structured `{ decisions }` payload. */
function mockLLMDecisions(decisions: unknown[]): void {
    mockGenerate.mockResolvedValue({
        experimental_output: { decisions },
    });
}

function makeEvent(overrides: Partial<SessionEventModel>): SessionEventModel {
    return {
        uuid: 'evt-1',
        organizationId: 'org-1',
        teamId: 'team-1',
        sessionId: 'sess-1',
        type: 'session_start',
        branch: 'main',
        eventTimestamp: new Date(),
        payload: {},
        classificationStatus: null,
        decisions: null,
        classificationSource: null,
        classificationError: null,
        classifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as SessionEventModel;
}

/** The JSON userPayload the source hands to tracedGenerateText via `prompt`. */
function llmPayload(): any {
    return JSON.parse(mockGenerate.mock.calls[0][0].prompt);
}

describe('ClassifySessionUseCase', () => {
    let useCase: ClassifySessionUseCase;
    let repo: jest.Mocked<SessionEventRepository>;

    beforeEach(() => {
        repo = {
            findByUuid: jest.fn(),
            findBySessionId: jest.fn(),
            markClassificationProcessing: jest.fn(),
            markClassificationCompleted: jest.fn(),
            markClassificationFailed: jest.fn(),
            markClassificationSkipped: jest.fn(),
            create: jest.fn(),
        } as any;

        mockGenerate.mockReset();
        // Safe default: an empty structured result. LLM-path tests override this.
        mockGenerate.mockResolvedValue({
            experimental_output: { decisions: [] },
        });
        observabilityService.runAiSdkLLMInSpan.mockClear();
        // LLM.run records its span through the observability port — register the mock.
        setLlmObservability(observabilityService);

        useCase = new ClassifySessionUseCase(repo, observabilityService);
    });

    it('should skip if event not found', async () => {
        repo.findByUuid.mockResolvedValue(null);

        await useCase.execute('missing-uuid');

        expect(repo.markClassificationSkipped).not.toHaveBeenCalled();
        expect(repo.markClassificationProcessing).not.toHaveBeenCalled();
    });

    it('should skip if event type is not session_end', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'evt-1', type: 'turn_start' }),
        );

        await useCase.execute('evt-1');

        expect(repo.markClassificationSkipped).toHaveBeenCalledWith(
            'evt-1',
            expect.stringContaining('Unsupported event type'),
        );
    });

    it('should skip if no useful content in session', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        repo.findBySessionId.mockResolvedValue([
            makeEvent({ type: 'session_start', payload: {} }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        await useCase.execute('end-1');

        expect(repo.markClassificationSkipped).toHaveBeenCalledWith(
            'end-1',
            'No textual context for classification',
        );
    });

    it('should call LLM and mark completed on success', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        repo.findBySessionId.mockResolvedValue([
            makeEvent({
                type: 'session_start',
                payload: { agentType: 'claude-code' },
            }),
            makeEvent({
                type: 'turn_start',
                payload: { prompt: 'Add authentication to the API' },
            }),
            makeEvent({
                type: 'turn_end',
                payload: {
                    toolCalls: [{ tool: 'Edit', summary: 'edited auth.ts' }],
                    filesModified: ['src/auth.ts'],
                },
            }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        mockLLMDecisions([
            {
                type: 'implementation_detail',
                decision: 'Use JWT for API authentication',
                confidence: 0.85,
            },
        ]);

        await useCase.execute('end-1');

        expect(repo.markClassificationProcessing).toHaveBeenCalledWith('end-1');
        expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
            'end-1',
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'implementation_detail',
                    decision: 'Use JWT for API authentication',
                }),
            ]),
            'llm',
        );
    });

    it('should fallback to heuristics when LLM returns empty', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        repo.findBySessionId.mockResolvedValue([
            makeEvent({
                type: 'turn_start',
                payload: {
                    prompt: 'We decided to use Redis for caching instead of Memcached',
                },
            }),
            makeEvent({
                type: 'turn_end',
                payload: { filesModified: ['src/cache.ts'] },
            }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        mockLLMDecisions([]);

        await useCase.execute('end-1');

        expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
            'end-1',
            expect.arrayContaining([
                expect.objectContaining({ type: expect.any(String) }),
            ]),
            'heuristic',
        );
    });

    it('should fallback to heuristics when LLM throws', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        repo.findBySessionId.mockResolvedValue([
            makeEvent({
                type: 'turn_start',
                payload: {
                    prompt: 'Adopt convention: always use snake_case for DB columns',
                },
            }),
            makeEvent({
                type: 'turn_end',
                payload: { filesModified: ['src/db.ts'] },
            }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        mockGenerate.mockRejectedValue(new Error('LLM timeout'));

        await useCase.execute('end-1');

        expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
            'end-1',
            expect.any(Array),
            'heuristic-fallback',
        );
    });

    it('should mark failed when both LLM and heuristics throw', async () => {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-1', type: 'session_end' }),
        );
        // Return session with content so it doesn't skip
        repo.findBySessionId.mockResolvedValue([
            makeEvent({
                type: 'turn_start',
                payload: { prompt: 'do something' },
            }),
            makeEvent({ type: 'session_end', uuid: 'end-1', payload: {} }),
        ]);

        mockGenerate.mockRejectedValue(new Error('LLM down'));

        // Make markCompleted throw to simulate heuristic persistence failure
        repo.markClassificationCompleted.mockRejectedValue(
            new Error('DB write failed'),
        );

        await useCase.execute('end-1');

        expect(repo.markClassificationFailed).toHaveBeenCalledWith(
            'end-1',
            'DB write failed',
        );
    });

    // ---------------------------------------------------------------
    // Heuristic type inference tests
    // ---------------------------------------------------------------

    function setupLLMFailure() {
        mockGenerate.mockRejectedValue(new Error('LLM unavailable'));
    }

    function setupSessionWithPrompt(prompt: string) {
        repo.findByUuid.mockResolvedValue(
            makeEvent({ uuid: 'end-h', type: 'session_end' }),
        );
        repo.findBySessionId.mockResolvedValue([
            makeEvent({ type: 'session_start', payload: {} }),
            makeEvent({
                type: 'turn_start',
                payload: { prompt },
            }),
            makeEvent({
                type: 'turn_end',
                payload: { filesModified: ['src/file.ts'] },
            }),
            makeEvent({ type: 'session_end', uuid: 'end-h', payload: {} }),
        ]);
    }

    describe('heuristic type inference', () => {
        it.each([
            [
                'We decided to use a microservice architecture',
                'architectural_decision',
            ],
            ['Convention: always use snake_case for DB columns', 'convention'],
            [
                'Used Redis instead of Memcached because of better pub/sub',
                'tradeoff',
            ],
            ['Added express framework as dependency', 'tooling'],
            ['Implemented JWT validation middleware', 'implementation_detail'],
        ])(
            'prompt "%s" should map to type "%s"',
            async (prompt, expectedType) => {
                setupSessionWithPrompt(prompt);
                setupLLMFailure();

                await useCase.execute('end-h');

                expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
                    'end-h',
                    expect.arrayContaining([
                        expect.objectContaining({ type: expectedType }),
                    ]),
                    'heuristic-fallback',
                );
            },
        );
    });

    // ---------------------------------------------------------------
    // Auto-promote logic
    // ---------------------------------------------------------------

    describe('auto-promote logic', () => {
        it('should set autoPromoteCandidate=true for high-confidence promotable types via LLM', async () => {
            repo.findByUuid.mockResolvedValue(
                makeEvent({ uuid: 'end-ap', type: 'session_end' }),
            );
            repo.findBySessionId.mockResolvedValue([
                makeEvent({
                    type: 'turn_start',
                    payload: { prompt: 'Set up the architecture' },
                }),
                makeEvent({
                    type: 'turn_end',
                    payload: { filesModified: ['src/arch.ts'] },
                }),
                makeEvent({ type: 'session_end', uuid: 'end-ap', payload: {} }),
            ]);

            mockLLMDecisions([
                {
                    type: 'architectural_decision',
                    decision: 'Use event-driven architecture',
                    confidence: 0.9,
                },
                {
                    type: 'convention',
                    decision: 'Always use camelCase',
                    confidence: 0.75,
                },
                {
                    type: 'tradeoff',
                    decision: 'Chose SQL over NoSQL',
                    confidence: 0.7,
                },
            ]);

            await useCase.execute('end-ap');

            const decisions = repo.markClassificationCompleted.mock.calls[0][1];
            expect(decisions).toHaveLength(3);
            expect(decisions[0].autoPromoteCandidate).toBe(true);
            expect(decisions[1].autoPromoteCandidate).toBe(true);
            expect(decisions[2].autoPromoteCandidate).toBe(true);
        });

        it('should set autoPromoteCandidate=false for low-confidence promotable types', async () => {
            repo.findByUuid.mockResolvedValue(
                makeEvent({ uuid: 'end-ap2', type: 'session_end' }),
            );
            repo.findBySessionId.mockResolvedValue([
                makeEvent({
                    type: 'turn_start',
                    payload: { prompt: 'Some architecture work' },
                }),
                makeEvent({
                    type: 'turn_end',
                    payload: { filesModified: ['src/x.ts'] },
                }),
                makeEvent({
                    type: 'session_end',
                    uuid: 'end-ap2',
                    payload: {},
                }),
            ]);

            mockLLMDecisions([
                {
                    type: 'architectural_decision',
                    decision: 'Maybe use microservices',
                    confidence: 0.5,
                },
            ]);

            await useCase.execute('end-ap2');

            const decisions = repo.markClassificationCompleted.mock.calls[0][1];
            expect(decisions[0].autoPromoteCandidate).toBe(false);
        });

        it('should set autoPromoteCandidate=false for non-promotable types even with high confidence', async () => {
            repo.findByUuid.mockResolvedValue(
                makeEvent({ uuid: 'end-ap3', type: 'session_end' }),
            );
            repo.findBySessionId.mockResolvedValue([
                makeEvent({
                    type: 'turn_start',
                    payload: { prompt: 'Implement feature' },
                }),
                makeEvent({
                    type: 'turn_end',
                    payload: { filesModified: ['src/y.ts'] },
                }),
                makeEvent({
                    type: 'session_end',
                    uuid: 'end-ap3',
                    payload: {},
                }),
            ]);

            mockLLMDecisions([
                {
                    type: 'implementation_detail',
                    decision: 'Use singleton pattern',
                    confidence: 0.95,
                },
                {
                    type: 'tooling',
                    decision: 'Use webpack',
                    confidence: 0.8,
                },
                {
                    type: 'other',
                    decision: 'Some other choice',
                    confidence: 0.9,
                },
            ]);

            await useCase.execute('end-ap3');

            const decisions = repo.markClassificationCompleted.mock.calls[0][1];
            expect(decisions[0].autoPromoteCandidate).toBe(false);
            expect(decisions[1].autoPromoteCandidate).toBe(false);
            expect(decisions[2].autoPromoteCandidate).toBe(false);
        });

        it('heuristic fallback decisions always have autoPromoteCandidate=false (confidence too low)', async () => {
            setupSessionWithPrompt(
                'We decided to use a microservice architecture',
            );
            setupLLMFailure();

            await useCase.execute('end-h');

            const decisions = repo.markClassificationCompleted.mock.calls[0][1];
            for (const d of decisions) {
                expect(d.autoPromoteCandidate).toBe(false);
            }
        });
    });

    // ---------------------------------------------------------------
    // aggregateEvents edge cases
    // ---------------------------------------------------------------

    describe('aggregateEvents edge cases', () => {
        it('should SKIP session with only session_start and session_end (no turns)', async () => {
            repo.findByUuid.mockResolvedValue(
                makeEvent({ uuid: 'end-empty', type: 'session_end' }),
            );
            repo.findBySessionId.mockResolvedValue([
                makeEvent({
                    type: 'session_start',
                    payload: {
                        agentType: 'claude-code',
                        gitRemote: 'github.com/org/repo',
                    },
                }),
                makeEvent({
                    type: 'session_end',
                    uuid: 'end-empty',
                    payload: {},
                }),
            ]);

            await useCase.execute('end-empty');

            expect(repo.markClassificationSkipped).toHaveBeenCalledWith(
                'end-empty',
                'No textual context for classification',
            );
            expect(repo.markClassificationProcessing).not.toHaveBeenCalled();
        });

        it('should SKIP session with empty prompts and no tool calls', async () => {
            repo.findByUuid.mockResolvedValue(
                makeEvent({ uuid: 'end-blank', type: 'session_end' }),
            );
            repo.findBySessionId.mockResolvedValue([
                makeEvent({ type: 'session_start', payload: {} }),
                makeEvent({
                    type: 'turn_start',
                    payload: { prompt: '' },
                }),
                makeEvent({
                    type: 'turn_start',
                    payload: { prompt: '   ' },
                }),
                makeEvent({
                    type: 'turn_end',
                    payload: { toolCalls: [], filesModified: [], commands: [] },
                }),
                makeEvent({
                    type: 'session_end',
                    uuid: 'end-blank',
                    payload: {},
                }),
            ]);

            await useCase.execute('end-blank');

            expect(repo.markClassificationSkipped).toHaveBeenCalledWith(
                'end-blank',
                'No textual context for classification',
            );
        });

        it('should include subagent info in aggregation', async () => {
            repo.findByUuid.mockResolvedValue(
                makeEvent({ uuid: 'end-sub', type: 'session_end' }),
            );
            repo.findBySessionId.mockResolvedValue([
                makeEvent({ type: 'session_start', payload: {} }),
                makeEvent({
                    type: 'subagent_start',
                    payload: {
                        subagentType: 'code-review',
                        taskDescription: 'Review auth module',
                    },
                }),
                makeEvent({
                    type: 'session_end',
                    uuid: 'end-sub',
                    payload: {},
                }),
            ]);

            // Subagents count as useful content, so it should proceed to LLM.
            mockLLMDecisions([]);

            await useCase.execute('end-sub');

            // Should NOT be skipped — subagents are useful content
            expect(repo.markClassificationSkipped).not.toHaveBeenCalled();
            expect(repo.markClassificationProcessing).toHaveBeenCalledWith(
                'end-sub',
            );

            // Verify subagent data was passed to the LLM via the userPayload.
            const payload = llmPayload();
            expect(payload.subagents).toEqual([
                { type: 'code-review', task: 'Review auth module' },
            ]);
        });
    });

    // ---------------------------------------------------------------
    // Large session handling
    // ---------------------------------------------------------------

    describe('large session handling', () => {
        it('should handle session with 100+ turn events without crashing and slice context', async () => {
            repo.findByUuid.mockResolvedValue(
                makeEvent({ uuid: 'end-large', type: 'session_end' }),
            );

            const events: SessionEventModel[] = [
                makeEvent({
                    type: 'session_start',
                    payload: { agentType: 'claude-code' },
                }),
            ];

            for (let i = 0; i < 120; i++) {
                events.push(
                    makeEvent({
                        type: 'turn_start',
                        payload: { prompt: `Task ${i}: refactor module ${i}` },
                    }),
                );
                events.push(
                    makeEvent({
                        type: 'turn_end',
                        payload: {
                            response: `Done with task ${i}`,
                            toolCalls: [
                                { tool: 'Edit', summary: `edited file${i}.ts` },
                            ],
                            filesModified: [`src/module${i}.ts`],
                            filesRead: [`src/module${i}.ts`],
                            commands: [`yarn test module${i}`],
                        },
                    }),
                );
            }

            events.push(
                makeEvent({
                    type: 'session_end',
                    uuid: 'end-large',
                    payload: {},
                }),
            );

            repo.findBySessionId.mockResolvedValue(events);

            mockLLMDecisions([
                {
                    type: 'implementation_detail',
                    decision: 'Refactored all modules',
                    confidence: 0.6,
                },
            ]);

            await useCase.execute('end-large');

            // Should not crash and should complete
            expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
                'end-large',
                expect.any(Array),
                'llm',
            );

            // Verify context was sliced for the LLM payload
            const payload = llmPayload();
            expect(payload.turns.length).toBeLessThanOrEqual(20);
            for (const turn of payload.turns) {
                expect(turn.toolCalls.length).toBeLessThanOrEqual(5);
                expect(turn.filesModified.length).toBeLessThanOrEqual(5);
            }
            expect(payload.filesModified.length).toBeLessThanOrEqual(30);
            expect(payload.filesRead.length).toBeLessThanOrEqual(20);
            expect(payload.commands.length).toBeLessThanOrEqual(20);
        });
    });

    // ---------------------------------------------------------------
    // Duplicate session_end
    // ---------------------------------------------------------------

    describe('duplicate session_end events', () => {
        it('should classify two session_end events for the same session independently', async () => {
            const sharedEvents = [
                makeEvent({ type: 'session_start', payload: {} }),
                makeEvent({
                    type: 'turn_start',
                    payload: {
                        prompt: 'We decided to adopt a monorepo convention',
                    },
                }),
                makeEvent({
                    type: 'turn_end',
                    payload: { filesModified: ['nx.json'] },
                }),
                makeEvent({
                    type: 'session_end',
                    uuid: 'end-dup-1',
                    payload: {},
                }),
                makeEvent({
                    type: 'session_end',
                    uuid: 'end-dup-2',
                    payload: {},
                }),
            ];

            // First call
            repo.findByUuid.mockResolvedValue(
                makeEvent({ uuid: 'end-dup-1', type: 'session_end' }),
            );
            repo.findBySessionId.mockResolvedValue(sharedEvents);
            setupLLMFailure();

            await useCase.execute('end-dup-1');

            expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
                'end-dup-1',
                expect.any(Array),
                'heuristic-fallback',
            );

            // Reset mocks for second call
            jest.clearAllMocks();

            // Second call with the other session_end uuid
            repo.findByUuid.mockResolvedValue(
                makeEvent({ uuid: 'end-dup-2', type: 'session_end' }),
            );
            repo.findBySessionId.mockResolvedValue(sharedEvents);
            setupLLMFailure();

            await useCase.execute('end-dup-2');

            expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
                'end-dup-2',
                expect.any(Array),
                'heuristic-fallback',
            );
        });
    });

    // ---------------------------------------------------------------
    // extractWithLLM mapping parity (absorbed from the former parity spec)
    //
    // Proves "no behavior change on the happy path" after migrating
    // extractWithLLM onto runStructuredReviewCall: a fixed { decisions: [...] }
    // result, returned through the REAL runStructuredReviewCall (real schema
    // conversion + model resolution + span), maps byte-for-byte to the same
    // CliSessionClassifiedDecision[] the pre-migration mapping produced.
    // ---------------------------------------------------------------

    describe('extractWithLLM mapping parity (AI SDK path)', () => {
        const MODEL_DECISIONS = [
            {
                type: 'architectural_decision',
                origin: 'human',
                decision: 'Use event sourcing for the audit log',
                rationale: 'Full auditability of every state change',
                confidence: 0.9,
                evidence: ['src/audit/store.ts', 'src/audit/replay.ts'],
            },
            {
                type: 'tooling',
                decision: 'Adopt pnpm as the package manager',
                confidence: 0.4,
            },
        ];

        const aggregated = {
            agentType: 'claude-code',
            gitRemote: 'git@github.com:kodus/example.git',
            turns: [
                {
                    prompt: 'Design the audit log',
                    response: 'I chose event sourcing.',
                    toolCalls: ['Edit'],
                    filesModified: ['src/audit/store.ts'],
                },
            ],
            prompts: ['Design the audit log'],
            responses: ['I chose event sourcing.'],
            toolCalls: ['Edit'],
            filesModified: ['src/audit/store.ts', 'src/audit/replay.ts'],
            filesRead: [],
            commands: [],
            subagents: [],
        };

        it('maps the model decisions[] byte-for-byte to CliSessionClassifiedDecision[]', async () => {
            mockLLMDecisions(MODEL_DECISIONS);

            const decisions = await (useCase as any).extractWithLLM(
                aggregated,
                'org-123',
            );

            expect(decisions).toEqual([
                {
                    type: 'architectural_decision',
                    origin: 'human',
                    decision: 'Use event sourcing for the audit log',
                    rationale: 'Full auditability of every state change',
                    confidence: 0.9,
                    evidence: ['src/audit/store.ts', 'src/audit/replay.ts'],
                    // No model-provided scope → falls back to the session's
                    // filesModified (normalizeScope), so the decision can reach
                    // a review.
                    scope: ['src/audit/store.ts', 'src/audit/replay.ts'],
                    // 0.9 >= 0.7 and architectural_decision is auto-promotable.
                    autoPromoteCandidate: true,
                },
                {
                    type: 'tooling',
                    origin: undefined,
                    decision: 'Adopt pnpm as the package manager',
                    rationale: undefined,
                    confidence: 0.4,
                    evidence: [],
                    // Same fallback to filesModified for a scope-less decision.
                    scope: ['src/audit/store.ts', 'src/audit/replay.ts'],
                    // 0.4 < 0.7 → not a candidate.
                    autoPromoteCandidate: false,
                },
            ]);
        });

        it('routes through exactly one AI SDK span path (runAiSdkLLMInSpan), no LangChain wrapper', async () => {
            mockLLMDecisions(MODEL_DECISIONS);

            await (useCase as any).extractWithLLM(aggregated, 'org-123');

            expect(observabilityService.runAiSdkLLMInSpan).toHaveBeenCalledTimes(
                1,
            );
            expect(mockGenerate).toHaveBeenCalledTimes(1);
        });

        it('empty decisions → empty mapping (no throw)', async () => {
            mockLLMDecisions([]);

            const decisions = await (useCase as any).extractWithLLM(
                aggregated,
                'org-123',
            );

            expect(decisions).toEqual([]);
        });
    });
});
