import { DocumentationSearchCacheService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-cache.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { LLM } from '@libs/llm/llm';
import { ConfigService } from '@nestjs/config';

const exaSearchMock = jest.fn();

jest.mock('exa-js', () => {
    return jest.fn().mockImplementation(() => ({
        search: exaSearchMock,
    }));
});

// The doc formatter was migrated onto the AI SDK `LLM.run` seam, which resolves
// observability via the app singleton — NOT the injected ObservabilityService the
// buildObservabilityMock below stubs. Mock `LLM.run` directly so these tests stay
// deterministic and never make a real per-query network call (otherwise a valid
// LLM key in the env turns each query task into a live call and the suite times
// out). The service unwraps `response.markdown`.
jest.mock('@libs/llm/llm', () => ({
    LLM: { run: jest.fn() },
}));
const mockLLMRun = LLM.run as jest.Mock;
const DEFAULT_FORMATTED = '## Summary\n- formatted doc snippet';

function buildObservabilityMock(params?: {
    formattedResult?: string;
}): ObservabilityService {
    return {
        // The service formats docs via runAiSdkLLMInSpan. Return the text
        // directly instead of running exec (which would hit the real LLM).
        runAiSdkLLMInSpan: jest.fn(async () => ({
            text:
                params?.formattedResult ??
                '## Summary\n- formatted doc snippet',
        })),
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
        // Default doc-formatter output for every test; a test that asserts on the
        // snippet content overrides this per-case.
        mockLLMRun.mockResolvedValue({ markdown: DEFAULT_FORMATTED });
    });

    it('should skip search when API key is missing', async () => {
        const configService = {
            get: jest.fn().mockReturnValue(undefined),
        } as unknown as ConfigService;

        const cacheService = buildCacheServiceMock();
        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
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

        // A sentinel that appears ONLY in the LLM-formatted markdown, never in the
        // raw Exa title/text — so the assertion below distinguishes "the formatted
        // snippet flowed through" from "fell back to the raw Exa content" (the
        // earlier `Controller` assertion passed either way, since the Exa title is
        // "NestJS Controllers").
        mockLLMRun.mockResolvedValue({
            markdown: '## Summary\n- LLM_FORMATTED_SENTINEL: use @Controller decorators.',
        });

        const cacheService = buildCacheServiceMock();
        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
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
                // Must be the LLM-FORMATTED snippet, not the raw Exa fallback.
                snippet: expect.stringContaining('LLM_FORMATTED_SENTINEL'),
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

        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
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
        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
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
