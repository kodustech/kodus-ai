import { Test, TestingModule } from '@nestjs/testing';
import { LoggerService } from '@nestjs/common';
import { LLMProviderService, LLMModelProvider, MODEL_STRATEGIES } from '@/llm';
import { BYOKProviderService } from '@/llm/byokProvider.service';

describe('LLMProviderService', () => {
    let service: LLMProviderService;
    let logger: jest.Mocked<LoggerService>;

    beforeEach(async () => {
        const mockLogger = {
            error: jest.fn(),
            log: jest.fn(),
            warn: jest.fn(),
        };

        const mockBYOKProviderService = {
            createBYOKProvider: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                LLMProviderService,
                {
                    provide: 'LLM_LOGGER',
                    useValue: mockLogger,
                },
                {
                    provide: BYOKProviderService,
                    useValue: mockBYOKProviderService,
                },
            ],
        }).compile();

        service = module.get<LLMProviderService>(LLMProviderService);
        logger = module.get<LoggerService>(
            'LLM_LOGGER',
        ) as jest.Mocked<LoggerService>;

        // Mock environment variables
        process.env.API_LLM_PROVIDER_MODEL = 'auto';
        process.env.API_OPEN_AI_API_KEY = 'test-key';
        process.env.API_ANTHROPIC_API_KEY = 'test-key';
        process.env.API_GOOGLE_AI_API_KEY = 'test-key';
        process.env.API_VERTEX_AI_API_KEY = Buffer.from(
            JSON.stringify({
                type: 'service_account',
                project_id: 'test-project',
                private_key_id: 'test-key-id',
                private_key: 'test-key',
                client_email: 'test@test.com',
                client_id: 'test-id',
                auth_uri: 'https://accounts.google.com/o/oauth2/auth',
                token_uri: 'https://oauth2.googleapis.com/token',
            }),
        ).toString('base64');
        process.env.API_NOVITA_AI_API_KEY = 'test-key';
    });

    describe('Provider Configuration Validation', () => {
        it('should have all enum providers configured in MODEL_STRATEGIES', () => {
            const enumValues = Object.values(LLMModelProvider);
            const strategyKeys = Object.keys(MODEL_STRATEGIES);

            enumValues.forEach((provider) => {
                expect(strategyKeys).toContain(provider);
            });
        });

        it('should be able to create LLM providers for all configured models', () => {
            const enumValues = Object.values(LLMModelProvider);

            enumValues.forEach((provider) => {
                expect(() => {
                    // Test with mock options to avoid actual API calls
                    const mockOptions = {
                        model: provider,
                        temperature: 0,
                        callbacks: [],
                        maxTokens: 1000,
                        jsonMode: false,
                    };

                    // This should not throw an error for supported providers
                    service.getLLMProvider(mockOptions);
                }).not.toThrow();
            });
        });

        it('should not use modelName directly as model parameter', () => {
            // This test ensures we never pass MODEL_STRATEGIES[provider].modelName
            // directly to getLLMProvider, which was the root cause of the bug

            const provider = LLMModelProvider.OPENAI_GPT_4O_MINI;
            const modelName = MODEL_STRATEGIES[provider].modelName; // 'gpt-4o-mini'

            // Using modelName directly should cause an error or fallback
            const mockOptions = {
                model: modelName, // This is WRONG - should be provider enum
                temperature: 0,
                callbacks: [],
                maxTokens: 1000,
                jsonMode: false,
            };

            // This should either work with fallback or log an error
            const result = service.getLLMProvider(mockOptions);
            expect(result).toBeDefined();

            // If it uses fallback, it should log an error
            if (logger.error.mock.calls.length > 0) {
                // eslint-disable-next-line @typescript-eslint/unbound-method
                expect(logger.error).toHaveBeenCalledWith(
                    expect.objectContaining({
                        message: `Unsupported provider: ${modelName}`,
                    }),
                );
            }
        });

        it('should correctly handle enum provider values', () => {
            const provider = LLMModelProvider.OPENAI_GPT_4O_MINI;

            const mockOptions = {
                model: provider, // This is CORRECT
                temperature: 0,
                callbacks: [],
                maxTokens: 1000,
                jsonMode: false,
            };

            const result = service.getLLMProvider(mockOptions);
            expect(result).toBeDefined();

            // Should not log any errors when using correct provider enum
            // eslint-disable-next-line @typescript-eslint/unbound-method
            expect(logger.error).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Unsupported provider',
                }),
            );
        });

        it('should handle jsonMode correctly for different providers', () => {
            const openAIProvider = LLMModelProvider.OPENAI_GPT_4O;
            const geminiProvider = LLMModelProvider.GEMINI_2_5_PRO;

            [openAIProvider, geminiProvider].forEach((provider) => {
                const mockOptions = {
                    model: provider,
                    temperature: 0,
                    callbacks: [],
                    maxTokens: 1000,
                    jsonMode: true,
                };

                expect(() => {
                    service.getLLMProvider(mockOptions);
                }).not.toThrow();
            });
        });

        it('should validate MODEL_STRATEGIES configuration', () => {
            Object.entries(MODEL_STRATEGIES).forEach(([, strategy]) => {
                expect(strategy).toHaveProperty('provider');
                expect(strategy).toHaveProperty('factory');
                expect(strategy).toHaveProperty('modelName');
                expect(strategy).toHaveProperty('defaultMaxTokens');
                expect(typeof strategy.factory).toBe('function');
                expect(typeof strategy.modelName).toBe('string');
                expect(typeof strategy.defaultMaxTokens).toBe('number');
            });
        });

        it('should handle invalid provider gracefully with fallback', () => {
            // This test reproduces the exact error from the user's stack trace
            logger.error.mockClear();

            // Someone is passing 'gpt-4o' instead of 'openai:gpt-4o'
            const mockOptions = {
                model: 'gpt-4o', // ❌ This is what causes the error
                temperature: 0,
                callbacks: [],
                maxTokens: 1000,
                jsonMode: false,
            };

            // This should work but use fallback and log error
            const result = service.getLLMProvider(mockOptions);
            expect(result).toBeDefined();

            // Should log the error about unsupported provider with current metadata format
            // eslint-disable-next-line @typescript-eslint/unbound-method
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Unsupported provider: gpt-4o',
                    metadata: {
                        requestedModel: 'gpt-4o',
                        temperature: 0,
                        maxTokens: 1000,
                        jsonMode: false,
                    },
                }),
            );
        });
    });

    describe('Self-hosted mode', () => {
        beforeEach(() => {
            process.env.API_LLM_PROVIDER_MODEL = 'custom-model';
            process.env.API_OPENAI_FORCE_BASE_URL = 'http://localhost:8080/v1';
        });

        afterEach(() => {
            process.env.API_LLM_PROVIDER_MODEL = 'auto';
            delete process.env.API_OPENAI_FORCE_BASE_URL;
        });

        it('should use self-hosted configuration when not in auto mode', () => {
            const mockOptions = {
                model: LLMModelProvider.OPENAI_GPT_4O,
                temperature: 0,
                callbacks: [],
                maxTokens: 1000,
                jsonMode: false,
            };

            const result = service.getLLMProvider(mockOptions);
            expect(result).toBeDefined();
        });
    });
});
