import { ClassifySessionUseCase } from '../classify-session.use-case';
import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';
import { SessionEventModel } from '@libs/cli-review/infrastructure/repositories/schemas/session-event.model';
import { PromptRunnerService } from '@kodus/kodus-common/llm';

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

describe('ClassifySessionUseCase', () => {
    let useCase: ClassifySessionUseCase;
    let repo: jest.Mocked<SessionEventRepository>;
    let promptRunner: jest.Mocked<PromptRunnerService>;

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

        promptRunner = {
            builder: jest.fn(),
        } as any;

        useCase = new ClassifySessionUseCase(repo, promptRunner);
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

        const mockExecute = jest.fn().mockResolvedValue({
            decisions: [
                {
                    type: 'implementation_detail',
                    decision: 'Use JWT for API authentication',
                    confidence: 0.85,
                },
            ],
        });

        promptRunner.builder.mockReturnValue({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            execute: mockExecute,
        } as any);

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

        const mockExecute = jest.fn().mockResolvedValue({
            decisions: [],
        });

        promptRunner.builder.mockReturnValue({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            execute: mockExecute,
        } as any);

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

        const mockExecute = jest
            .fn()
            .mockRejectedValue(new Error('LLM timeout'));

        promptRunner.builder.mockReturnValue({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            execute: mockExecute,
        } as any);

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

        const mockExecute = jest.fn().mockRejectedValue(new Error('LLM down'));
        promptRunner.builder.mockReturnValue({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            execute: mockExecute,
        } as any);

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
        const mockExecute = jest
            .fn()
            .mockRejectedValue(new Error('LLM unavailable'));
        promptRunner.builder.mockReturnValue({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            execute: mockExecute,
        } as any);
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

            const mockExecute = jest.fn().mockResolvedValue({
                decisions: [
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
                ],
            });

            promptRunner.builder.mockReturnValue({
                setProviders: jest.fn().mockReturnThis(),
                setParser: jest.fn().mockReturnThis(),
                setLLMJsonMode: jest.fn().mockReturnThis(),
                setTemperature: jest.fn().mockReturnThis(),
                setPayload: jest.fn().mockReturnThis(),
                addPrompt: jest.fn().mockReturnThis(),
                setRunName: jest.fn().mockReturnThis(),
                setBYOKConfig: jest.fn().mockReturnThis(),
                setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                execute: mockExecute,
            } as any);

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

            const mockExecute = jest.fn().mockResolvedValue({
                decisions: [
                    {
                        type: 'architectural_decision',
                        decision: 'Maybe use microservices',
                        confidence: 0.5,
                    },
                ],
            });

            promptRunner.builder.mockReturnValue({
                setProviders: jest.fn().mockReturnThis(),
                setParser: jest.fn().mockReturnThis(),
                setLLMJsonMode: jest.fn().mockReturnThis(),
                setTemperature: jest.fn().mockReturnThis(),
                setPayload: jest.fn().mockReturnThis(),
                addPrompt: jest.fn().mockReturnThis(),
                setRunName: jest.fn().mockReturnThis(),
                setBYOKConfig: jest.fn().mockReturnThis(),
                setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                execute: mockExecute,
            } as any);

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

            const mockExecute = jest.fn().mockResolvedValue({
                decisions: [
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
                ],
            });

            promptRunner.builder.mockReturnValue({
                setProviders: jest.fn().mockReturnThis(),
                setParser: jest.fn().mockReturnThis(),
                setLLMJsonMode: jest.fn().mockReturnThis(),
                setTemperature: jest.fn().mockReturnThis(),
                setPayload: jest.fn().mockReturnThis(),
                addPrompt: jest.fn().mockReturnThis(),
                setRunName: jest.fn().mockReturnThis(),
                setBYOKConfig: jest.fn().mockReturnThis(),
                setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                execute: mockExecute,
            } as any);

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

            // Subagents count as useful content, so it should proceed to LLM
            const mockExecute = jest.fn().mockResolvedValue({ decisions: [] });
            promptRunner.builder.mockReturnValue({
                setProviders: jest.fn().mockReturnThis(),
                setParser: jest.fn().mockReturnThis(),
                setLLMJsonMode: jest.fn().mockReturnThis(),
                setTemperature: jest.fn().mockReturnThis(),
                setPayload: jest.fn().mockReturnThis(),
                addPrompt: jest.fn().mockReturnThis(),
                setRunName: jest.fn().mockReturnThis(),
                setBYOKConfig: jest.fn().mockReturnThis(),
                setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                execute: mockExecute,
            } as any);

            await useCase.execute('end-sub');

            // Should NOT be skipped — subagents are useful content
            expect(repo.markClassificationSkipped).not.toHaveBeenCalled();
            expect(repo.markClassificationProcessing).toHaveBeenCalledWith(
                'end-sub',
            );

            // Verify subagent data was passed to LLM via setPayload
            const builderMock = promptRunner.builder.mock.results[0].value;
            const payloadArg = builderMock.setPayload.mock.calls[0][0];
            expect(payloadArg.subagents).toEqual([
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

            const mockSetPayload = jest.fn().mockReturnThis();
            const mockExecute = jest.fn().mockResolvedValue({
                decisions: [
                    {
                        type: 'implementation_detail',
                        decision: 'Refactored all modules',
                        confidence: 0.6,
                    },
                ],
            });

            promptRunner.builder.mockReturnValue({
                setProviders: jest.fn().mockReturnThis(),
                setParser: jest.fn().mockReturnThis(),
                setLLMJsonMode: jest.fn().mockReturnThis(),
                setTemperature: jest.fn().mockReturnThis(),
                setPayload: mockSetPayload,
                addPrompt: jest.fn().mockReturnThis(),
                setRunName: jest.fn().mockReturnThis(),
                setBYOKConfig: jest.fn().mockReturnThis(),
                setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                execute: mockExecute,
            } as any);

            await useCase.execute('end-large');

            // Should not crash and should complete
            expect(repo.markClassificationCompleted).toHaveBeenCalledWith(
                'end-large',
                expect.any(Array),
                'llm',
            );

            // Verify context was sliced for the LLM payload
            const payload = mockSetPayload.mock.calls[0][0];
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
});
