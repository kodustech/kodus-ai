import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { DocumentationSearchCacheService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-cache.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { ConfigService } from '@nestjs/config';

const exaSearchMock = jest.fn();

jest.mock('exa-js', () => {
    return jest.fn().mockImplementation(() => ({
        search: exaSearchMock,
    }));
});

function buildObservabilityMock(): ObservabilityService {
    return {
        runLLMInSpan: jest.fn(async ({ exec }) => {
            const result = await exec([]);
            return { result };
        }),
    } as unknown as ObservabilityService;
}

describe('DocumentationSearchExaService', () => {
    function buildCacheServiceMock(params?: { cachedItem?: any }) {
        return {
            get: jest.fn().mockResolvedValue(params?.cachedItem || null),
            set: jest.fn().mockResolvedValue(undefined),
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    function buildPromptRunnerServiceMock(params?: {
        formattedResult?: string;
    }) {
        const builder = {
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({
                result:
                    params?.formattedResult ||
                    '## Summary\n- formatted doc snippet',
            }),
        };

        return {
            builder: jest.fn().mockReturnValue(builder),
        } as unknown as PromptRunnerService;
    }

    it('should skip search when API key is missing', async () => {
        const configService = {
            get: jest.fn().mockReturnValue(undefined),
        } as unknown as ConfigService;

        const cacheService = buildCacheServiceMock();
        const promptRunnerService = buildPromptRunnerServiceMock();
        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
            promptRunnerService,
            buildObservabilityMock(),
        );

        const result = await service.searchByFilePlan({
            'src/a.ts': {
                queryTasks: [
                    {
                        packageName: 'react',
                        query: 'hooks',
                    },
                ],
            },
        });

        expect(result).toEqual({});
        expect(exaSearchMock).not.toHaveBeenCalled();
    });

    it('should return documentation from Exa and persist in cache', async () => {
        const configService = {
            get: jest.fn((key: string) =>
                key === 'API_EXA_KEY' ? 'exa_test_key' : undefined,
            ),
        } as unknown as ConfigService;

        exaSearchMock.mockResolvedValue({
            results: [
                {
                    title: 'NestJS Controllers',
                    url: 'https://docs.nestjs.com/controllers',
                    text: 'Use official docs and controller decorators.',
                },
            ],
            citations: [{ url: 'https://docs.nestjs.com/controllers' }],
        });

        const cacheService = buildCacheServiceMock();
        const promptRunnerService = buildPromptRunnerServiceMock({
            formattedResult:
                '## Summary\n- Use @Controller decorators correctly.',
        });
        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
            promptRunnerService,
            buildObservabilityMock(),
        );

        const result = await service.searchByFilePlan({
            'src/a.ts': {
                queryTasks: [
                    {
                        packageName: '@nestjs/common',
                        query: 'Language: TypeScript. Package: @nestjs/common. nestjs controllers',
                    },
                ],
            },
        });

        expect(exaSearchMock).toHaveBeenCalledTimes(1);
        const exaQuery = exaSearchMock.mock.calls[0][0] as string;
        expect(exaQuery).toContain('Package: @nestjs/common');
        expect(exaQuery).toContain('Language context: TypeScript');
        expect(exaQuery.toLowerCase()).toContain('official');
        expect(result['src/a.ts']).toHaveLength(1);
        expect(result['src/a.ts'][0]).toEqual(
            expect.objectContaining({
                source: 'exa-search',
                url: 'https://docs.nestjs.com/controllers',
                snippet: expect.stringContaining('Controller'),
            }),
        );
        expect(cacheService.set).toHaveBeenCalledTimes(1);
    });

    it('should return cached docs and avoid Exa calls', async () => {
        const configService = {
            get: jest.fn((key: string) =>
                key === 'API_EXA_KEY' ? 'exa_test_key' : undefined,
            ),
        } as unknown as ConfigService;

        const cacheService = buildCacheServiceMock({
            cachedItem: {
                query: 'Package: @nestjs/common. Query: nestjs controllers',
                title: 'Documentation for @nestjs/common',
                url: 'https://docs.nestjs.com/controllers',
                snippet: 'cached snippet',
                source: 'exa-search',
            },
        });

        const promptRunnerService = buildPromptRunnerServiceMock();

        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
            promptRunnerService,
            buildObservabilityMock(),
        );

        const result = await service.searchByFilePlan({
            'src/a.ts': {
                queryTasks: [
                    {
                        packageName: '@nestjs/common',
                        query: 'nestjs controllers',
                    },
                ],
            },
        });

        expect(result['src/a.ts']).toHaveLength(1);
        expect(result['src/a.ts'][0].snippet).toBe('cached snippet');
        expect(exaSearchMock).not.toHaveBeenCalled();
    });

    it('should not cap the number of query tasks processed', async () => {
        const configService = {
            get: jest.fn((key: string) =>
                key === 'API_EXA_KEY' ? 'exa_test_key' : undefined,
            ),
        } as unknown as ConfigService;

        exaSearchMock.mockResolvedValue({
            results: [
                {
                    title: 'Official Doc',
                    url: 'https://docs.example.com',
                    text: 'documentation content',
                },
            ],
            citations: [{ url: 'https://docs.example.com' }],
        });

        const cacheService = buildCacheServiceMock();
        const promptRunnerService = buildPromptRunnerServiceMock();
        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
            promptRunnerService,
            buildObservabilityMock(),
        );

        const queryTasks = Array.from({ length: 7 }).map((_, index) => ({
            packageName: `pkg-${index}`,
            query: `Language: TypeScript. Package: pkg-${index}. official docs`,
        }));

        const result = await service.searchByFilePlan({
            'src/a.ts': {
                queryTasks,
            },
        });

        expect(exaSearchMock).toHaveBeenCalledTimes(7);
        expect(result['src/a.ts']).toHaveLength(7);
    });
});
