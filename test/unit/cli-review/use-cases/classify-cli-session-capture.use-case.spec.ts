import { LLMModelProvider, PromptRunnerService } from '@kodus/kodus-common/llm';
import { ClassifyCliSessionCaptureUseCase } from '@libs/cli-review/application/use-cases/classify-cli-session-capture.use-case';
import { CliSessionCaptureRepository } from '@libs/cli-review/infrastructure/repositories/cli-session-capture.repository';

type MockBuilder = {
    setProviders: jest.Mock;
    setParser: jest.Mock;
    setLLMJsonMode: jest.Mock;
    setTemperature: jest.Mock;
    setPayload: jest.Mock;
    addPrompt: jest.Mock;
    setRunName: jest.Mock;
    execute: jest.Mock;
};

const createMockBuilder = (): MockBuilder => ({
    setProviders: jest.fn().mockReturnThis(),
    setParser: jest.fn().mockReturnThis(),
    setLLMJsonMode: jest.fn().mockReturnThis(),
    setTemperature: jest.fn().mockReturnThis(),
    setPayload: jest.fn().mockReturnThis(),
    addPrompt: jest.fn().mockReturnThis(),
    setRunName: jest.fn().mockReturnThis(),
    execute: jest.fn(),
});

const makeCapture = (
    overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
    const base = {
        captureId: 'cap_123',
        event: 'stop',
        summary: 'Refactored auth module',
        signals: {
            prompt: 'Refactor auth to use JWT middleware',
            assistantMessage:
                'I decided to move validation to middleware because it centralizes auth checks.',
            modifiedFiles: ['src/auth/middleware.ts'],
            toolUses: [
                {
                    tool: 'Edit',
                    filePath: 'src/auth/middleware.ts',
                    summary: 'Added JWT validation',
                },
            ],
        },
    };

    const overrideSignals = (overrides.signals || {}) as Record<
        string,
        unknown
    >;

    return {
        ...base,
        ...overrides,
        signals: {
            ...base.signals,
            ...overrideSignals,
        },
    };
};

describe('ClassifyCliSessionCaptureUseCase', () => {
    let useCase: ClassifyCliSessionCaptureUseCase;
    let mockRepository: {
        findByCaptureId: jest.Mock;
        markSkipped: jest.Mock;
        markProcessing: jest.Mock;
        markCompleted: jest.Mock;
        markFailed: jest.Mock;
    };
    let mockBuilder: MockBuilder;
    let mockPromptRunnerService: { builder: jest.Mock };

    beforeEach(() => {
        mockRepository = {
            findByCaptureId: jest.fn(),
            markSkipped: jest.fn(),
            markProcessing: jest.fn(),
            markCompleted: jest.fn(),
            markFailed: jest.fn(),
        };

        mockBuilder = createMockBuilder();
        mockPromptRunnerService = {
            builder: jest.fn().mockReturnValue(mockBuilder),
        };

        useCase = new ClassifyCliSessionCaptureUseCase(
            mockRepository as unknown as CliSessionCaptureRepository,
            mockPromptRunnerService as unknown as PromptRunnerService,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('returns early when capture does not exist', async () => {
        mockRepository.findByCaptureId.mockResolvedValue(null);

        await useCase.execute('cap_missing');

        expect(mockRepository.markSkipped).not.toHaveBeenCalled();
        expect(mockRepository.markProcessing).not.toHaveBeenCalled();
        expect(mockRepository.markCompleted).not.toHaveBeenCalled();
        expect(mockRepository.markFailed).not.toHaveBeenCalled();
    });

    it('marks capture as skipped when event is unsupported', async () => {
        mockRepository.findByCaptureId.mockResolvedValue(
            makeCapture({ event: 'start' }),
        );

        await useCase.execute('cap_unsupported');

        expect(mockRepository.markSkipped).toHaveBeenCalledWith(
            'cap_unsupported',
            'Unsupported event: start',
        );
        expect(mockRepository.markProcessing).not.toHaveBeenCalled();
    });

    it('marks capture as skipped when no textual context is available', async () => {
        mockRepository.findByCaptureId.mockResolvedValue(
            makeCapture({
                summary: '',
                signals: {
                    prompt: '',
                    assistantMessage: '',
                },
            }),
        );

        await useCase.execute('cap_empty');

        expect(mockRepository.markSkipped).toHaveBeenCalledWith(
            'cap_empty',
            'No textual context for classification',
        );
        expect(mockRepository.markProcessing).not.toHaveBeenCalled();
    });

    it('stores normalized LLM decisions when model returns valid output', async () => {
        mockRepository.findByCaptureId.mockResolvedValue(makeCapture());
        mockBuilder.execute.mockResolvedValue({
            decisions: [
                {
                    type: 'architectural_decision',
                    decision: 'D'.repeat(520),
                    rationale: 'R'.repeat(1010),
                    confidence: 1.6,
                    evidence: [
                        'E'.repeat(350),
                        'file:src/auth/middleware.ts',
                        'tool:Edit',
                        'jwt',
                        'middleware',
                        'extra-should-be-cut',
                    ],
                },
            ],
        });

        await useCase.execute('cap_llm');

        expect(mockBuilder.setProviders).toHaveBeenCalledWith(
            expect.objectContaining({
                main: LLMModelProvider.CEREBRAS_GLM_47,
            }),
        );
        expect(mockBuilder.setRunName).toHaveBeenCalledWith(
            'classifyCliSessionCapture',
        );
        expect(mockRepository.markProcessing).toHaveBeenCalledWith('cap_llm');
        expect(mockRepository.markCompleted).toHaveBeenCalledTimes(1);

        const [captureId, decisions, source] =
            mockRepository.markCompleted.mock.calls[0];

        expect(captureId).toBe('cap_llm');
        expect(source).toBe('llm');
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({
            type: 'architectural_decision',
            confidence: 1,
            autoPromoteCandidate: true,
        });
        expect(decisions[0].decision.length).toBeLessThanOrEqual(500);
        expect(decisions[0].rationale.length).toBeLessThanOrEqual(1000);
        expect(decisions[0].evidence).toHaveLength(5);
        expect(decisions[0].evidence[0].length).toBeLessThanOrEqual(300);
    });

    it('uses heuristic classifier when LLM returns empty decisions', async () => {
        mockRepository.findByCaptureId.mockResolvedValue(makeCapture());
        mockBuilder.execute.mockResolvedValue({
            decisions: [],
        });

        await useCase.execute('cap_heuristic');

        expect(mockRepository.markProcessing).toHaveBeenCalledWith(
            'cap_heuristic',
        );
        expect(mockRepository.markCompleted).toHaveBeenCalledTimes(1);

        const [captureId, decisions, source] =
            mockRepository.markCompleted.mock.calls[0];
        expect(captureId).toBe('cap_heuristic');
        expect(source).toBe('heuristic');
        expect(decisions.length).toBeGreaterThan(0);
    });

    it('uses heuristic fallback when LLM execution fails', async () => {
        mockRepository.findByCaptureId.mockResolvedValue(makeCapture());
        mockBuilder.execute.mockRejectedValue(new Error('llm unavailable'));

        await useCase.execute('cap_fallback');

        expect(mockRepository.markCompleted).toHaveBeenCalledTimes(1);
        const [captureId, decisions, source] =
            mockRepository.markCompleted.mock.calls[0];
        expect(captureId).toBe('cap_fallback');
        expect(source).toBe('heuristic-fallback');
        expect(decisions.length).toBeGreaterThan(0);
        expect(mockRepository.markFailed).not.toHaveBeenCalled();
    });

    it('marks capture as failed when both LLM and fallback extraction fail', async () => {
        mockRepository.findByCaptureId.mockResolvedValue(makeCapture());
        mockBuilder.execute.mockRejectedValue(new Error('llm failure'));
        jest.spyOn(useCase as any, 'extractWithHeuristics').mockImplementation(
            () => {
                throw new Error('fallback failed');
            },
        );

        await useCase.execute('cap_failed');

        expect(mockRepository.markFailed).toHaveBeenCalledWith(
            'cap_failed',
            'fallback failed',
        );
    });
});
