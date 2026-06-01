export const DOCUMENTATION_SEARCH_EXA_SERVICE_TOKEN = Symbol.for(
    'DocumentationSearchExaService',
);

import { createLogger } from '@kodus/flow';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { DocumentationSearchCacheService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-cache.service';
import {
    DocumentationItem,
    DocumentationQueryPlanByFile,
    DocumentationQueryTask,
} from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Exa from 'exa-js';
import pLimit from 'p-limit';
import {
    prompt_code_review_documentation_formatter_system,
    prompt_code_review_documentation_formatter_user,
} from '../../../../common/utils/langchainCommon/prompts/codeReviewDocumentationFormatter';

const CACHE_PROVIDER = 'exa';
type ExaSearchResponse = Awaited<ReturnType<Exa['search']>>;

type CitationLike = {
    title?: string;
    url?: string;
};

type ResultLike = {
    title?: string;
    url?: string;
    text?: string;
};

/**
 * Concurrency cap for outbound Exa API calls.
 *
 * Exa free tier: 10 requests/second. Cap at 5 concurrent in-flight calls
 * leaves headroom for:
 *   - typical Exa latency (1-3s) → effective ~2-5 RPS, well below the limit
 *   - SDK-level retries on transient failures
 *   - parallel pipelines in the same worker process
 *
 * Module-level singleton so it is shared across all PRs running in the
 * same Node process. Multi-worker setups still need a distributed limiter
 * (e.g. Redis token bucket) to coordinate across processes.
 */
const EXA_CONCURRENCY = 5;
const exaCallLimiter = pLimit(EXA_CONCURRENCY);

@Injectable()
export class DocumentationSearchExaService {
    private readonly logger = createLogger(DocumentationSearchExaService.name);
    private readonly exaClient: Exa | null;
    private readonly inFlightRequests = new Map<
        string,
        Promise<DocumentationItem | null>
    >();

    constructor(
        private readonly configService: ConfigService,
        private readonly documentationSearchCacheService: DocumentationSearchCacheService,
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
    ) {
        const apiKey = this.configService.get<string>('API_EXA_KEY');
        this.exaClient = apiKey ? new Exa(apiKey) : null;
    }

    async searchByFilePlan(
        planByFile: Record<string, DocumentationQueryPlanByFile>,
        options?: {
            organizationAndTeamData?: OrganizationAndTeamData;
            prNumber?: number;
            byokConfig?: BYOKConfig;
        },
    ): Promise<Record<string, DocumentationItem[]>> {
        if (!this.exaClient) {
            this.logger.warn({
                message:
                    'API_EXA_KEY is not configured, skipping documentation search stage',
                context: DocumentationSearchExaService.name,
                metadata: {
                    filesPlanned: Object.keys(planByFile || {}).length,
                    organizationAndTeamData: options?.organizationAndTeamData,
                    prNumber: options?.prNumber,
                },
            });

            return {};
        }

        const fileResults = await Promise.all(
            Object.entries(planByFile).map(async ([filePath, plan]) => {
                const docs = await this.searchForPlan(plan, options);
                return [filePath, docs] as const;
            }),
        );

        return Object.fromEntries(fileResults);
    }

    private async searchForPlan(
        plan: DocumentationQueryPlanByFile,
        options?: {
            organizationAndTeamData?: OrganizationAndTeamData;
            prNumber?: number;
            byokConfig?: BYOKConfig;
        },
    ): Promise<DocumentationItem[]> {
        const queryTasks = this.normalizeQueryTasks(plan.queryTasks);

        if (!queryTasks.length || !this.exaClient) {
            return [];
        }

        const queryResults = await Promise.allSettled(
            queryTasks.map((task) => this.searchQuery(task, options)),
        );

        const items: DocumentationItem[] = [];

        for (const queryResult of queryResults) {
            if (queryResult.status === 'fulfilled' && queryResult.value) {
                items.push(queryResult.value);
            }
        }

        return this.deduplicateByQuery(items);
    }

    private async searchQuery(
        task: {
            query: string;
            packageName: string;
        },
        options?: {
            organizationAndTeamData?: OrganizationAndTeamData;
            prNumber?: number;
            byokConfig?: BYOKConfig;
        },
    ): Promise<DocumentationItem | null> {
        const queryNormalized = this.normalizeCacheSegment(task.query);
        const packageNameNormalized = this.normalizeCacheSegment(
            task.packageName,
        );
        const inFlightKey = this.buildInFlightKey(
            packageNameNormalized,
            queryNormalized,
        );

        const existingInFlight = this.inFlightRequests.get(inFlightKey);
        if (existingInFlight) {
            return existingInFlight;
        }

        const request = this.searchQueryWithCache(
            task,
            packageNameNormalized,
            queryNormalized,
            options,
        ).finally(() => {
            this.inFlightRequests.delete(inFlightKey);
        });

        this.inFlightRequests.set(inFlightKey, request);
        return request;
    }

    private async searchQueryWithCache(
        task: {
            query: string;
            packageName: string;
        },
        packageNameNormalized: string,
        queryNormalized: string,
        options?: {
            organizationAndTeamData?: OrganizationAndTeamData;
            prNumber?: number;
            byokConfig?: BYOKConfig;
        },
    ): Promise<DocumentationItem | null> {
        if (!this.exaClient) {
            return null;
        }

        const cached = await this.documentationSearchCacheService.get({
            provider: CACHE_PROVIDER,
            packageNameNormalized,
            queryNormalized,
        });

        if (cached) {
            this.logger.log({
                message: 'Documentation query served from cache',
                context: DocumentationSearchExaService.name,
                metadata: {
                    provider: CACHE_PROVIDER,
                    packageName: task.packageName,
                    query: task.query,
                    organizationAndTeamData: options?.organizationAndTeamData,
                    prNumber: options?.prNumber,
                },
            });
            return cached;
        }

        try {
            const packageScopedQuery = this.buildPackageScopedQuery(
                task.packageName,
                task.query,
            );

            const response = await exaCallLimiter(() =>
                this.exaClient!.search(packageScopedQuery, {
                    category: 'company',
                    type: 'auto',
                }),
            );

            const formattedSnippet = await this.formatDocumentationForPrompt({
                packageName: task.packageName,
                query: task.query,
                rawSearchContent: this.buildRawSearchContent(response),
                organizationAndTeamData: options?.organizationAndTeamData,
                prNumber: options?.prNumber,
                byokConfig: options?.byokConfig,
            });

            const item: DocumentationItem = {
                url: response.results?.[0]?.url || 'unknown',
                title:
                    response.results?.[0]?.title ||
                    `Documentation for ${task.packageName}`,
                source: 'exa-search',
                snippet:
                    formattedSnippet ||
                    this.buildSnippet(
                        this.buildRawSearchContent(response),
                        task.query,
                    ),
                query: packageScopedQuery,
            };

            await this.documentationSearchCacheService.set({
                provider: CACHE_PROVIDER,
                packageNameNormalized,
                queryNormalized,
                documentationItem: item,
            });

            return item;
        } catch (error) {
            this.logger.warn({
                message: `Exa search failed for query: ${task.query}`,
                context: DocumentationSearchExaService.name,
                metadata: {
                    provider: CACHE_PROVIDER,
                    packageName: task.packageName,
                    query: task.query,
                    organizationAndTeamData: options?.organizationAndTeamData,
                    prNumber: options?.prNumber,
                },
                error,
            });

            return null;
        }
    }

    private normalizeQueryTasks(
        tasks: DocumentationQueryTask[],
    ): DocumentationQueryTask[] {
        const seen = new Set<string>();
        const normalizedTasks: DocumentationQueryTask[] = [];

        for (const task of tasks || []) {
            const packageName = (task?.packageName || '').trim();
            const query = (task?.query || '').trim();

            if (!packageName || !query) {
                continue;
            }

            const key = `${packageName.toLowerCase()}::${query.toLowerCase()}`;
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            normalizedTasks.push({ packageName, query });
        }

        return normalizedTasks;
    }

    private buildPackageScopedQuery(
        packageName: string,
        query: string,
    ): string {
        const language = this.extractLanguageFromQuery(query);

        return `Package: ${packageName}. Language context: ${language}. Query: ${query}. Prefer official vendor/maintainer documentation and API references for this exact package. Use community sources only when official docs are unavailable.`;
    }

    private extractLanguageFromQuery(query: string): string {
        const match = (query || '').match(/language\s*:\s*([^.]+)\.?/i);
        if (!match || !match[1]) {
            return 'Unspecified';
        }

        return match[1].trim();
    }

    private buildSnippet(text: string | undefined, query: string): string {
        const sanitized = (text || '').replace(/\s+/g, ' ').trim();

        if (!sanitized) {
            return `No extract was returned by Exa for query: ${query}`;
        }

        return sanitized;
    }

    private buildRawSearchContent(response: ExaSearchResponse): string {
        const sections: string[] = [];

        const citations = this.extractCitations(response);
        if (citations.length) {
            sections.push(
                `Citations:\n${citations
                    .map((citation, index) => {
                        const url = citation.url || 'unknown';
                        const title = citation.title || '';
                        return `${index + 1}. ${title ? `${title} - ` : ''}${url}`;
                    })
                    .join('\n')}`,
            );
        }

        const results = this.extractResults(response);
        if (results.length) {
            sections.push(
                `Results:\n${results
                    .map((result, index) => {
                        const title = result.title || 'Untitled';
                        const url = result.url || 'unknown';
                        const text = (result.text || '')
                            .toString()
                            .replace(/\s+/g, ' ')
                            .trim();

                        return `${index + 1}. ${title}\nURL: ${url}\nExcerpt: ${text}`;
                    })
                    .join('\n\n')}`,
            );
        }

        return sections.join('\n\n');
    }

    private extractCitations(response: ExaSearchResponse): CitationLike[] {
        if (!('citations' in response)) {
            return [];
        }

        const value = (response as Record<string, unknown>).citations;
        if (!Array.isArray(value)) {
            return [];
        }

        return value
            .filter(
                (entry): entry is Record<string, unknown> =>
                    typeof entry === 'object' && entry !== null,
            )
            .map((entry) => ({
                title:
                    typeof entry.title === 'string' ? entry.title : undefined,
                url: typeof entry.url === 'string' ? entry.url : undefined,
            }));
    }

    private extractResults(response: ExaSearchResponse): ResultLike[] {
        const value = (response as Record<string, unknown>).results;
        if (!Array.isArray(value)) {
            return [];
        }

        return value
            .filter(
                (entry): entry is Record<string, unknown> =>
                    typeof entry === 'object' && entry !== null,
            )
            .map((entry) => ({
                title:
                    typeof entry.title === 'string' ? entry.title : undefined,
                url: typeof entry.url === 'string' ? entry.url : undefined,
                text: typeof entry.text === 'string' ? entry.text : undefined,
            }));
    }

    private async formatDocumentationForPrompt(params: {
        packageName: string;
        query: string;
        rawSearchContent: string;
        organizationAndTeamData?: OrganizationAndTeamData;
        prNumber?: number;
        byokConfig?: BYOKConfig;
    }): Promise<string> {
        if (!params.rawSearchContent.trim()) {
            return '';
        }

        try {
            const runName = 'documentationSearchExaFormat';
            const spanName = `${DocumentationSearchExaService.name}::${runName}`;

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                LLMModelProvider.GEMINI_3_FLASH_PREVIEW,
                LLMModelProvider.GEMINI_3_FLASH_PREVIEW,
                params.byokConfig,
            );

            const { result: response } =
                await this.observabilityService.runLLMInSpan({
                    spanName,
                    runName,
                    byokConfig: params.byokConfig,
                    attrs: {
                        type: promptRunner.executeMode,
                        organizationId:
                            params.organizationAndTeamData?.organizationId,
                        prNumber: params.prNumber,
                        packageName: params.packageName,
                    },
                    exec: (callbacks) =>
                        promptRunner
                            .builder()
                            .setParser(ParserType.STRING)
                            .setPayload(params)
                            .addPrompt({
                                role: PromptRole.SYSTEM,
                                prompt: prompt_code_review_documentation_formatter_system,
                            })
                            .addPrompt({
                                role: PromptRole.USER,
                                prompt: prompt_code_review_documentation_formatter_user,
                            })
                            .addMetadata({
                                context: DocumentationSearchExaService.name,
                                runName,
                                metadata: {
                                    provider: CACHE_PROVIDER,
                                    packageName: params.packageName,
                                    query: params.query,
                                    rawSearchContentLength:
                                        params.rawSearchContent.length,
                                    hasByokConfig: Boolean(params.byokConfig),
                                    organizationAndTeamData:
                                        params.organizationAndTeamData,
                                    prNumber: params.prNumber,
                                },
                            })
                            .setTemperature(0)
                            .setRunName(runName)
                            .addCallbacks(callbacks)
                            .execute(),
                });

            return this.extractPromptExecutionText(response);
        } catch (error) {
            this.logger.warn({
                message:
                    'LLM documentation formatter failed, falling back to raw summary truncation',
                context: DocumentationSearchExaService.name,
                metadata: {
                    provider: CACHE_PROVIDER,
                    packageName: params.packageName,
                    query: params.query,
                    organizationAndTeamData: params.organizationAndTeamData,
                    prNumber: params.prNumber,
                },
                error,
            });

            return '';
        }
    }

    private extractPromptExecutionText(response: unknown): string {
        if (typeof response === 'string') {
            return response.trim();
        }

        if (typeof response === 'object' && response !== null) {
            const resultValue = (response as Record<string, unknown>).result;
            if (typeof resultValue === 'string') {
                return resultValue.trim();
            }

            if (resultValue != null) {
                return String(resultValue).trim();
            }
        }

        return '';
    }

    private deduplicateByQuery(
        items: DocumentationItem[],
    ): DocumentationItem[] {
        const byQuery = new Map<string, DocumentationItem>();

        for (const item of items) {
            if (!byQuery.has(item.query)) {
                byQuery.set(item.query, item);
            }
        }

        return [...byQuery.values()];
    }

    private buildInFlightKey(
        packageNameNormalized: string,
        queryNormalized: string,
    ): string {
        return `${CACHE_PROVIDER}:${packageNameNormalized}:${queryNormalized}`;
    }

    private normalizeCacheSegment(value: string): string {
        return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }
}
