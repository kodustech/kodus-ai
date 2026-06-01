import { createLogger } from '@kodus/flow';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
    CrossFileContextPlannerSchema,
    CrossFileContextPlannerSchemaType,
    prompt_cross_file_context_planner,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewCrossFileContextPlanner';
import {
    CrossFileContextSufficiencySchema,
    CrossFileContextSufficiencySchemaType,
    CrossFileContextSufficiencyPayload,
    prompt_cross_file_context_sufficiency,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewCrossFileContextSufficiency';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { TokenChunkingService } from '@libs/core/infrastructure/services/tokenChunking/tokenChunking.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import {
    CODEBASE_SEARCH_SERVICE_TOKEN,
    CodebaseSearchService,
} from './codebaseSearch.service';

/**
 * Remote command executors for sandbox environments.
 * Abstracts shell commands executed in remote sandbox environments (E2B).
 */
export interface RemoteCommands {
    grep: (pattern: string, path: string, glob?: string) => Promise<string>;
    read: (path: string, start: number, end: number) => Promise<string>;
    listDir: (path: string, maxDepth: number) => Promise<string>;
    /** Run an arbitrary read-only shell command in the sandbox. */
    exec?: (command: string) => Promise<{ stdout: string; exitCode: number }>;
}

//#region Constants
const MAX_PLANNER_QUERIES = 16;
const MAX_SUFFICIENCY_QUERIES = 5;
const MAX_TOTAL_CONTEXTS = 60;
const MAX_PER_FILE_CHARS = 8000;
const MAX_TOTAL_CHARS = 200_000;
const CONTEXT_WINDOW_SMALL = 25;
const CONTEXT_WINDOW_SINGLE_LINE = 40;
const MIN_SNIPPET_LINES = 5;
const SEARCH_CONCURRENCY = 10;
//#endregion

//#region Types
export const COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN = Symbol(
    'CollectCrossFileContextsService',
);

export type CrossFileContextSnippet = {
    filePath: string;
    content: string;
    rationale: string;
    relevanceScore: number;
    relatedSymbol?: string;
    relationship: string;
    hop: number;
    riskLevel: 'low' | 'medium' | 'high';
    startLine?: number;
    endLine?: number;
    targetFiles?: string[];
};

export type CollectCrossFileContextsResult = {
    contexts: CrossFileContextSnippet[];
    plannerQueries: CrossFileContextPlannerSchemaType['queries'];
    totalSearches: number;
    totalSnippetsBeforeDedup: number;
};

interface CollectContextsParams {
    remoteCommands: RemoteCommands;
    changedFiles: FileChange[];
    byokConfig?: BYOKConfig;
    organizationAndTeamData: OrganizationAndTeamData;
    prNumber: number;
    language: string;
    repoRoot: string;
}

type PlannerQuery = CrossFileContextPlannerSchemaType['queries'][number];

interface SearchExecutionResult {
    snippets: CrossFileContextSnippet[];
    queryResultMap: Map<string, boolean>;
}
//#endregion

@Injectable()
export class CollectCrossFileContextsService {
    private readonly logger = createLogger(
        CollectCrossFileContextsService.name,
    );

    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
        private readonly tokenChunkingService: TokenChunkingService,
        private readonly configService: ConfigService,
        @Inject(CODEBASE_SEARCH_SERVICE_TOKEN)
        private readonly codebaseSearchService: CodebaseSearchService,
    ) {}

    async collectContexts(
        params: CollectContextsParams,
    ): Promise<CollectCrossFileContextsResult> {
        return this.observabilityService.runInSpan(
            'CollectCrossFileContextsService::collectContexts',
            () => this._collectContextsInner(params),
            {
                organizationId: params.organizationAndTeamData?.organizationId,
                prNumber: params.prNumber,
            },
        );
    }

    private async _collectContextsInner(
        params: CollectContextsParams,
    ): Promise<CollectCrossFileContextsResult> {
        const {
            remoteCommands,
            changedFiles,
            byokConfig,
            organizationAndTeamData,
            prNumber,
            language,
            repoRoot,
        } = params;

        const emptyResult: CollectCrossFileContextsResult = {
            contexts: [],
            plannerQueries: [],
            totalSearches: 0,
            totalSnippetsBeforeDedup: 0,
        };

        // Canary: verify sandbox has files before spending tokens on planner
        const canaryFiles = await remoteCommands.listDir('.', 1);
        this.logger.log({
            message: `[DEBUG] Canary listDir('.', 1) for PR#${prNumber}: ${canaryFiles ? canaryFiles.trim().split('\n').length + ' files' : 'EMPTY'}`,
            context: CollectCrossFileContextsService.name,
            metadata: {
                organizationAndTeamData,
                prNumber,
                canaryOutput: canaryFiles?.slice(0, 500),
                canaryLength: canaryFiles?.length ?? 0,
            },
        });
        if (!canaryFiles || !canaryFiles.trim()) {
            this.logger.warn({
                message: `Sandbox appears empty (listDir returned no files) for PR#${prNumber} — skipping cross-file context`,
                context: CollectCrossFileContextsService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return emptyResult;
        }

        // 1. Run planner to get search queries
        const plannerQueries = await this.runPlanner(
            changedFiles,
            byokConfig,
            organizationAndTeamData,
            prNumber,
            language,
        );

        if (!plannerQueries?.length) {
            this.logger.log({
                message: `No planner queries generated for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return emptyResult;
        }

        this.logger.log({
            message: `Planner generated ${plannerQueries.length} queries for PR#${prNumber}`,
            context: CollectCrossFileContextsService.name,
            metadata: {
                organizationAndTeamData,
                prNumber,
                queries: plannerQueries.map((q) => ({
                    symbol: q.symbolName,
                    pattern: q.pattern,
                    glob: q.fileGlob,
                    risk: q.riskLevel,
                    rationale: q.rationale,
                })),
            },
        });

        // 2. Execute search queries via CodebaseSearchService
        const changedFilePaths = new Set(changedFiles.map((f) => f.filename));

        const searchExecution = await this.executeSearchQueries(
            plannerQueries,
            remoteCommands,
            changedFilePaths,
            repoRoot,
            organizationAndTeamData,
            prNumber,
        );

        if (!searchExecution.snippets.length) {
            this.logger.warn({
                message: `All ${plannerQueries.length} search queries returned 0 results for PR#${prNumber} — possible sandbox issue`,
                context: CollectCrossFileContextsService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return {
                ...emptyResult,
                plannerQueries,
                totalSearches: plannerQueries.length,
            };
        }

        // 3. Expand context windows for small snippets
        const expandedSnippets = await this.expandContextWindows(
            searchExecution.snippets,
            remoteCommands,
        );

        const allSnippets = expandedSnippets;
        const totalSnippetsBeforeDedup = allSnippets.length;

        // 5. Deduplicate and rank
        let finalContexts = await this.deduplicateAndRank(allSnippets);
        let totalSearches = plannerQueries.length;

        // 6. Sufficiency feedback loop (max 1 iteration)
        const sufficiencyResult = await this.runSufficiencyLoop({
            changedFiles,
            plannerQueries,
            currentContexts: finalContexts,
            queryResultMap: searchExecution.queryResultMap,
            remoteCommands,
            changedFilePaths,
            repoRoot,
            byokConfig,
            organizationAndTeamData,
            prNumber,
            language,
        });

        if (sufficiencyResult) {
            finalContexts = sufficiencyResult.mergedContexts;
            totalSearches += sufficiencyResult.additionalSearchCount;
        }

        this.logger.log({
            message: `Cross-file context collection completed for PR#${prNumber}`,
            context: CollectCrossFileContextsService.name,
            metadata: {
                organizationAndTeamData,
                prNumber,
                queriesGenerated: plannerQueries.length,
                plannerSymbols: plannerQueries.map((q) => ({
                    symbol: q.symbolName,
                    risk: q.riskLevel,
                    glob: q.fileGlob,
                })),
                totalSnippetsBeforeDedup,
                finalContexts: finalContexts.length,
                sufficiencyLoopRan: !!sufficiencyResult,
                snippetFiles: finalContexts.map((c) => ({
                    file: c.filePath,
                    symbol: c.relatedSymbol,
                    hop: c.hop,
                    score: c.relevanceScore,
                })),
            },
        });

        return {
            contexts: finalContexts,
            plannerQueries,
            totalSearches,
            totalSnippetsBeforeDedup,
        };
    }

    //#region Planner
    private async runPlanner(
        changedFiles: FileChange[],
        byokConfig: BYOKConfig | undefined,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        language: string,
    ): Promise<CrossFileContextPlannerSchemaType['queries']> {
        try {
            // Prepare per-file diff items (truncated to 2k chars each)
            const fileDiffItems = changedFiles.map((f) => {
                const diff = f.patchWithLinesStr || f.patch || '';
                const truncated =
                    diff.length > 2000
                        ? diff.substring(0, 2000) + '\n... (truncated)'
                        : diff;
                return `### ${f.filename}\n${truncated}`;
            });

            const changedFilenames = changedFiles.map((f) => f.filename);

            // Determine effective model for token counting
            const effectiveModel = byokConfig?.main?.model
                ? byokConfig.main.model
                : LLMModelProvider.CEREBRAS_GPT_OSS_120B;

            // Chunk diff items by token limits
            const byokMaxInputTokens = byokConfig?.main?.maxInputTokens;

            const chunkingResult = this.tokenChunkingService.chunkDataByTokens({
                model: effectiveModel,
                data: fileDiffItems,
                usagePercentage: 50,
                defaultMaxTokens: 64000,
                ...(byokMaxInputTokens && byokMaxInputTokens > 0
                    ? { overrideMaxTokens: byokMaxInputTokens }
                    : {}),
            });

            this.logger.log({
                message: `Planner chunked ${fileDiffItems.length} files into ${chunkingResult.totalChunks} batch(es) for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    totalFiles: fileDiffItems.length,
                    totalChunks: chunkingResult.totalChunks,
                    tokenLimit: chunkingResult.tokenLimit,
                    tokensPerChunk: chunkingResult.tokensPerChunk,
                },
            });

            // Run planner batches with limited concurrency (max 4 at a time)
            const BATCH_CONCURRENCY = 4;
            const allQueries: PlannerQuery[] = [];
            const chunks = chunkingResult.chunks as string[][];

            for (let i = 0; i < chunks.length; i += BATCH_CONCURRENCY) {
                const window = chunks.slice(i, i + BATCH_CONCURRENCY);
                const batchSettled = await Promise.allSettled(
                    window.map((batchItems) => {
                        const batchDiffSummary = batchItems.join('\n\n');
                        return this.buildPlannerPromptRunner(
                            batchDiffSummary,
                            changedFilenames,
                            language,
                            byokConfig,
                            organizationAndTeamData,
                            prNumber,
                        );
                    }),
                );

                for (const settled of batchSettled) {
                    if (settled.status === 'fulfilled') {
                        allQueries.push(...(settled.value ?? []));
                    } else {
                        this.logger.warn({
                            message: `Planner batch failed for PR#${prNumber}`,
                            context: CollectCrossFileContextsService.name,
                            error: settled.reason,
                            metadata: { organizationAndTeamData, prNumber },
                        });
                    }
                }
            }

            if (!allQueries.length) {
                this.logger.warn({
                    message: `Planner returned empty queries for PR#${prNumber}`,
                    context: CollectCrossFileContextsService.name,
                    metadata: { organizationAndTeamData, prNumber },
                });
                return [];
            }

            // Deduplicate across batches, validate, and apply global cap
            const deduped = this.deduplicatePlannerQueries(allQueries);
            const validated = this.validatePlannerQueries(deduped, prNumber);
            return validated.slice(0, MAX_PLANNER_QUERIES);
        } catch (error) {
            this.logger.error({
                message: `Planner LLM failed for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                error,
                metadata: { organizationAndTeamData, prNumber },
            });
            return [];
        }
    }

    private async buildPlannerPromptRunner(
        diffSummary: string,
        changedFilenames: string[],
        language: string,
        byokConfig: BYOKConfig | undefined,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<CrossFileContextPlannerSchemaType['queries']> {
        const payload = { diffSummary, changedFilenames, language };

        const provider = LLMModelProvider.GEMINI_3_FLASH_PREVIEW;
        const fallbackProvider = LLMModelProvider.GEMINI_2_5_FLASH;

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            provider,
            fallbackProvider,
            byokConfig,
        );

        const runName = 'crossFileContextPlanner';
        const spanName = `${CollectCrossFileContextsService.name}::${runName}`;
        const spanAttrs = {
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            type: promptRunner.executeMode,
        };

        const builder = promptRunner
            .builder()
            .setParser(ParserType.ZOD, CrossFileContextPlannerSchema as any)
            .setLLMJsonMode(true)
            .setPayload(payload)
            .addPrompt({
                prompt: prompt_cross_file_context_planner,
                role: PromptRole.SYSTEM,
            })
            .addPrompt({
                prompt: 'Analyze the diff and generate search queries. Return the response in the specified JSON format.',
                role: PromptRole.USER,
            })
            .setTemperature(0)
            .addTags(['crossFileContextPlanner', `model:${provider}`])
            .setRunName(runName)
            .addMetadata({
                organizationAndTeamData,
                prNumber,
                runName,
            });

        const { result } = await this.observabilityService.runLLMInSpan({
            spanName,
            runName,
            attrs: spanAttrs,
            byokConfig,
            exec: (callbacks) => builder.addCallbacks(callbacks).execute(),
        });

        return (result as CrossFileContextPlannerSchemaType)?.queries ?? [];
    }

    private deduplicatePlannerQueries(queries: PlannerQuery[]): PlannerQuery[] {
        const riskRank: Record<string, number> = {
            high: 3,
            medium: 2,
            low: 1,
        };

        const seen = new Map<string, PlannerQuery>();

        for (const query of queries) {
            const key = `${query.symbolName ?? ''}::${query.pattern}`;
            const existing = seen.get(key);

            if (
                !existing ||
                (riskRank[query.riskLevel] ?? 0) >
                    (riskRank[existing.riskLevel] ?? 0)
            ) {
                seen.set(key, query);
            }
        }

        return Array.from(seen.values());
    }

    /**
     * Filters out low-quality planner queries that waste search budget.
     * Catches common LLM mistakes: log strings, generic names, private symbols.
     */
    private validatePlannerQueries(
        queries: PlannerQuery[],
        prNumber: number,
    ): PlannerQuery[] {
        // Patterns that indicate log/comment strings, not code symbols
        const LOG_STRING_PATTERNS = [
            /^\[.*\]$/, // [TIMING], [ERROR], etc.
            /^\[.*\]/, // [TIMING] PR#...
            /^logger\./, // logger.log, logger.warn
            /^console\./, // console.log
            /error occurred/i,
            /failed to/i,
        ];

        // Generic parameter names that match hundreds of files
        const GENERIC_NAMES = new Set([
            'config',
            'options',
            'params',
            'context',
            'data',
            'result',
            'error',
            'response',
            'request',
            'callback',
            'handler',
            'value',
            'item',
            'input',
            'output',
            'args',
        ]);

        // Private/internal symbols unlikely to have external consumers
        const PRIVATE_PATTERNS = [
            /^(private|#)/, // private keyword or # prefix
            /^_[a-z]/, // _privateMethod convention
            /^(MAX_|MIN_|DEFAULT_)/, // Constants
        ];

        const kept: PlannerQuery[] = [];
        const rejected: string[] = [];

        for (const query of queries) {
            const symbol = query.symbolName || '';

            // Reject log/comment strings
            if (LOG_STRING_PATTERNS.some((p) => p.test(symbol))) {
                rejected.push(`${symbol} (log/comment string)`);
                continue;
            }

            // Reject generic parameter names (only when symbol is the whole pattern)
            if (GENERIC_NAMES.has(symbol.toLowerCase())) {
                rejected.push(`${symbol} (generic name)`);
                continue;
            }

            // Reject private/internal symbols
            if (PRIVATE_PATTERNS.some((p) => p.test(symbol))) {
                rejected.push(`${symbol} (private/internal)`);
                continue;
            }

            // Reject patterns that are just log strings wrapped in regex
            if (
                /\[TIMING\]|\[ERROR\]|\[WARN\]|\[INFO\]|\[DEBUG\]/.test(
                    query.pattern,
                )
            ) {
                rejected.push(`${query.pattern} (log tag pattern)`);
                continue;
            }

            kept.push(query);
        }

        if (rejected.length > 0) {
            this.logger.log({
                message: `Rejected ${rejected.length} low-quality planner queries for PR#${prNumber}: ${rejected.join(', ')}`,
                context: CollectCrossFileContextsService.name,
            });
        }

        return kept;
    }
    //#endregion

    //#region Search Execution
    private async executeSearchQueries(
        queries: PlannerQuery[],
        remoteCommands: RemoteCommands,
        changedFilePaths: Set<string>,
        repoRoot: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<SearchExecutionResult> {
        return this.observabilityService.runInSpan(
            'CollectCrossFileContextsService::executeSearchQueries',
            () =>
                this._executeSearchQueriesInner(
                    queries,
                    remoteCommands,
                    changedFilePaths,
                    repoRoot,
                    organizationAndTeamData,
                    prNumber,
                ),
            {
                organizationId: organizationAndTeamData?.organizationId,
                prNumber,
                queryCount: queries.length,
            },
        );
    }

    private async _executeSearchQueriesInner(
        queries: PlannerQuery[],
        remoteCommands: RemoteCommands,
        changedFilePaths: Set<string>,
        repoRoot: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<SearchExecutionResult> {
        const queryResultMap = new Map<string, boolean>();

        const tasks = queries.map((query) => async () => {
            this.logger.log({
                message: `Executing search query for PR#${prNumber}: "${query.pattern}" (symbol: ${query.symbolName}, glob: ${query.fileGlob || '*'})`,
                context: CollectCrossFileContextsService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    pattern: query.pattern,
                    symbolName: query.symbolName,
                    fileGlob: query.fileGlob,
                    riskLevel: query.riskLevel,
                    repoRoot,
                },
            });

            const result = await this.codebaseSearchService.search({
                query: query.pattern,
                remoteCommands,
                includes: query.fileGlob ? [query.fileGlob] : undefined,
                excludes: [
                    'node_modules',
                    '.git',
                    'dist',
                    'build',
                    '*.min.js',
                    '*.map',
                ],
            });

            this.logger.log({
                message: `Search result for PR#${prNumber} pattern "${query.pattern}": success=${result.success}, contexts=${result.contexts?.length ?? 0}`,
                context: CollectCrossFileContextsService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    pattern: query.pattern,
                    success: result.success,
                    contextsCount: result.contexts?.length ?? 0,
                    contextFiles: result.contexts?.map((c) => c.file) ?? [],
                },
            });

            return { query, result };
        });

        const results = await this.runWithConcurrency(
            tasks,
            SEARCH_CONCURRENCY,
        );

        const allSnippets: CrossFileContextSnippet[] = [];
        for (const outcome of results) {
            if (outcome.status === 'rejected') continue;
            const { query, result } = outcome.value;

            if (!result.success || !result.contexts?.length) {
                queryResultMap.set(query.pattern, false);
                continue;
            }

            queryResultMap.set(query.pattern, true);

            for (const ctx of result.contexts) {
                if (changedFilePaths.has(ctx.file)) continue;

                allSnippets.push({
                    filePath: ctx.file,
                    content: ctx.content,
                    rationale: query.rationale,
                    relevanceScore: this.getBaseScore(query.riskLevel),
                    relatedSymbol: query.symbolName,
                    relationship: `consumer of ${query.symbolName || query.pattern}`,
                    hop: 1,
                    riskLevel: query.riskLevel,
                    targetFiles: [query.sourceFile],
                });
            }
        }

        // Mark failed tasks
        for (const query of queries) {
            if (!queryResultMap.has(query.pattern)) {
                queryResultMap.set(query.pattern, false);
            }
        }

        return { snippets: allSnippets, queryResultMap };
    }
    //#endregion

    //#region Context Expansion
    private async expandContextWindows(
        snippets: CrossFileContextSnippet[],
        remoteCommands: RemoteCommands,
    ): Promise<CrossFileContextSnippet[]> {
        return this.observabilityService.runInSpan(
            'CollectCrossFileContextsService::expandContextWindows',
            () => this._expandContextWindowsInner(snippets, remoteCommands),
            { snippetCount: snippets.length },
        );
    }

    private async _expandContextWindowsInner(
        snippets: CrossFileContextSnippet[],
        remoteCommands: RemoteCommands,
    ): Promise<CrossFileContextSnippet[]> {
        const tasks = snippets.map((snippet) => async () => {
            const lineCount = snippet.content.split('\n').length;

            if (lineCount >= MIN_SNIPPET_LINES) {
                return snippet;
            }

            // Skip expansion if we don't have actual line position info
            // Without it, we'd read wrong lines from the file
            if (!snippet.startLine || !snippet.endLine) {
                return snippet;
            }

            const window =
                lineCount <= 1
                    ? CONTEXT_WINDOW_SINGLE_LINE
                    : CONTEXT_WINDOW_SMALL;

            const startLine = Math.max(1, (snippet.startLine || 1) - window);
            const endLine = (snippet.endLine || lineCount) + window;

            const expandedContent = await remoteCommands.read(
                snippet.filePath,
                startLine,
                endLine,
            );

            if (expandedContent) {
                const trimmed = expandedContent.substring(
                    0,
                    MAX_PER_FILE_CHARS,
                );

                return {
                    ...snippet,
                    content: trimmed,
                    startLine,
                    endLine,
                };
            }

            return snippet;
        });

        const results = await this.runWithConcurrency(
            tasks,
            SEARCH_CONCURRENCY,
        );

        return results.map((r, i) =>
            r.status === 'fulfilled' ? r.value : snippets[i],
        );
    }
    //#endregion

    //#region Hop 2
    private async executeHop2(
        hop1Snippets: CrossFileContextSnippet[],
        remoteCommands: RemoteCommands,
        changedFilePaths: Set<string>,
        repoRoot: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<CrossFileContextSnippet[]> {
        const hop2Snippets: CrossFileContextSnippet[] = [];
        const highRiskSnippets = hop1Snippets.filter(
            (s) => s.riskLevel === 'high',
        );

        if (!highRiskSnippets.length) {
            return hop2Snippets;
        }

        try {
            // Extract function names only from high-risk hop 1 snippets
            const hop1FunctionNames = new Set<string>();
            const funcToTargetFiles = new Map<string, Set<string>>();
            for (const snippet of highRiskSnippets) {
                const funcNames = this.extractFunctionNames(snippet.content);
                for (const name of funcNames) {
                    hop1FunctionNames.add(name);
                    const existing =
                        funcToTargetFiles.get(name) || new Set<string>();
                    snippet.targetFiles?.forEach((f) => existing.add(f));
                    funcToTargetFiles.set(name, existing);
                }
            }

            // For each function found in hop 1, search for its callers
            const hop1FilePaths = new Set(hop1Snippets.map((s) => s.filePath));
            const excludedPaths = new Set([
                ...changedFilePaths,
                ...hop1FilePaths,
            ]);

            const validFuncNames = [...hop1FunctionNames].filter(
                (n) => n && n.length >= 3 && !this.isGenericFunctionName(n),
            );

            const tasks = validFuncNames.map((funcName) => async () => {
                const result = await this.codebaseSearchService.search({
                    query: funcName,
                    remoteCommands,
                    excludes: ['node_modules', '.git', 'dist', 'build'],
                });

                if (!result.success || !result.contexts?.length) {
                    return [];
                }

                return result.contexts
                    .filter((ctx) => !excludedPaths.has(ctx.file))
                    .map((ctx) => ({
                        filePath: ctx.file,
                        content: ctx.content,
                        rationale: `Hop 2: caller of ${funcName} found in hop 1 results`,
                        relevanceScore: this.getBaseScore('high') - 10,
                        relatedSymbol: funcName,
                        relationship: `indirect consumer (hop 2) of ${funcName}`,
                        hop: 2 as const,
                        riskLevel: 'high' as const,
                        targetFiles: [
                            ...(funcToTargetFiles.get(funcName) || []),
                        ],
                    }));
            });

            const results = await this.runWithConcurrency(
                tasks,
                SEARCH_CONCURRENCY,
            );
            for (const outcome of results) {
                if (outcome.status === 'fulfilled') {
                    hop2Snippets.push(...outcome.value);
                }
            }
        } catch (error) {
            this.logger.warn({
                message: `Hop 2 execution failed entirely for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                error,
                metadata: { organizationAndTeamData, prNumber },
            });
        }

        return hop2Snippets;
    }
    //#endregion

    //#region Dedup & Rank
    private async deduplicateAndRank(
        snippets: CrossFileContextSnippet[],
    ): Promise<CrossFileContextSnippet[]> {
        return this.observabilityService.runInSpan(
            'CollectCrossFileContextsService::deduplicateAndRank',
            () => this._deduplicateAndRankInner(snippets),
            { snippetCount: snippets.length },
        );
    }

    private _deduplicateAndRankInner(
        snippets: CrossFileContextSnippet[],
    ): CrossFileContextSnippet[] {
        // Group by file
        const byFile = new Map<string, CrossFileContextSnippet[]>();
        for (const snippet of snippets) {
            const existing = byFile.get(snippet.filePath) || [];
            existing.push(snippet);
            byFile.set(snippet.filePath, existing);
        }

        // Merge overlapping snippets per file and enforce per-file limit
        const merged: CrossFileContextSnippet[] = [];
        for (const [, fileSnippets] of byFile) {
            // Sort by relevance score desc, keep the best
            fileSnippets.sort((a, b) => b.relevanceScore - a.relevanceScore);

            const snippetsForThisFile: CrossFileContextSnippet[] = [];
            let totalChars = 0;

            for (const snippet of fileSnippets) {
                if (totalChars + snippet.content.length > MAX_PER_FILE_CHARS) {
                    continue;
                }

                // Check for overlap only within snippets for the current file
                const overlappingSnippet = snippetsForThisFile.find(
                    (existing) =>
                        this.hasContentOverlap(
                            existing.content,
                            snippet.content,
                        ),
                );

                if (overlappingSnippet) {
                    // Merge targetFiles from the duplicate into the survivor
                    if (snippet.targetFiles?.length) {
                        overlappingSnippet.targetFiles = [
                            ...new Set([
                                ...(overlappingSnippet.targetFiles || []),
                                ...snippet.targetFiles,
                            ]),
                        ];
                    }
                } else {
                    totalChars += snippet.content.length;
                    snippetsForThisFile.push(snippet);
                }
            }
            merged.push(...snippetsForThisFile);
        }

        // Sort by score descending
        merged.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Cap at MAX_TOTAL_CONTEXTS and MAX_TOTAL_CHARS
        const finalSnippets: CrossFileContextSnippet[] = [];
        let totalChars = 0;

        for (const snippet of merged) {
            if (finalSnippets.length >= MAX_TOTAL_CONTEXTS) break;
            if (totalChars + snippet.content.length > MAX_TOTAL_CHARS) continue;

            totalChars += snippet.content.length;
            finalSnippets.push(snippet);
        }

        return finalSnippets;
    }
    //#endregion

    //#region Sufficiency Loop
    private async runSufficiencyLoop(params: {
        changedFiles: FileChange[];
        plannerQueries: PlannerQuery[];
        currentContexts: CrossFileContextSnippet[];
        queryResultMap: Map<string, boolean>;
        remoteCommands: RemoteCommands;
        changedFilePaths: Set<string>;
        repoRoot: string;
        byokConfig?: BYOKConfig;
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        language: string;
    }): Promise<{
        mergedContexts: CrossFileContextSnippet[];
        additionalSearchCount: number;
    } | null> {
        return this.observabilityService.runInSpan(
            'CollectCrossFileContextsService::runSufficiencyLoop',
            () => this._runSufficiencyLoopInner(params),
            {
                organizationId: params.organizationAndTeamData?.organizationId,
                prNumber: params.prNumber,
                currentContextCount: params.currentContexts.length,
            },
        );
    }

    private async _runSufficiencyLoopInner(params: {
        changedFiles: FileChange[];
        plannerQueries: PlannerQuery[];
        currentContexts: CrossFileContextSnippet[];
        queryResultMap: Map<string, boolean>;
        remoteCommands: RemoteCommands;
        changedFilePaths: Set<string>;
        repoRoot: string;
        byokConfig?: BYOKConfig;
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        language: string;
    }): Promise<{
        mergedContexts: CrossFileContextSnippet[];
        additionalSearchCount: number;
    } | null> {
        const {
            changedFiles,
            plannerQueries,
            currentContexts,
            queryResultMap,
            remoteCommands,
            changedFilePaths,
            repoRoot,
            byokConfig,
            organizationAndTeamData,
            prNumber,
            language,
        } = params;

        // Skip gate: if all planner queries found results, no check needed
        const allQueriesFoundResults = plannerQueries.every(
            (q) => queryResultMap.get(q.pattern) === true,
        );

        if (allQueriesFoundResults) {
            this.logger.log({
                message: `Skipping sufficiency check for PR#${prNumber}: all ${plannerQueries.length} queries found results`,
                context: CollectCrossFileContextsService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return null;
        }

        // Evaluate sufficiency
        const sufficiencyResult = await this.evaluateSufficiency(
            changedFiles,
            plannerQueries,
            currentContexts,
            queryResultMap,
            language,
            byokConfig,
            organizationAndTeamData,
            prNumber,
        );

        if (!sufficiencyResult) {
            return null;
        }

        if (
            sufficiencyResult.sufficient ||
            !sufficiencyResult.additionalQueries?.length
        ) {
            this.logger.log({
                message: `Sufficiency check passed for PR#${prNumber}: context is sufficient`,
                context: CollectCrossFileContextsService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    gaps: sufficiencyResult.gaps,
                },
            });
            return null;
        }

        // Execute additional queries (capped)
        const additionalQueries = sufficiencyResult.additionalQueries.slice(
            0,
            MAX_SUFFICIENCY_QUERIES,
        );

        this.logger.log({
            message: `Sufficiency loop: executing ${additionalQueries.length} additional queries for PR#${prNumber}`,
            context: CollectCrossFileContextsService.name,
            metadata: {
                organizationAndTeamData,
                prNumber,
                gaps: sufficiencyResult.gaps,
                additionalQueries: additionalQueries.map((q) => ({
                    symbol: q.symbolName,
                    pattern: q.pattern,
                    risk: q.riskLevel,
                })),
            },
        });

        const additionalSearch = await this.executeSearchQueries(
            additionalQueries,
            remoteCommands,
            changedFilePaths,
            repoRoot,
            organizationAndTeamData,
            prNumber,
        );

        if (!additionalSearch.snippets.length) {
            this.logger.log({
                message: `Sufficiency loop: no additional results found for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return null;
        }

        // Expand context windows for new snippets
        const expandedAdditional = await this.expandContextWindows(
            additionalSearch.snippets,
            remoteCommands,
        );

        // Merge with existing contexts and re-deduplicate
        const mergedContexts = await this.deduplicateAndRank([
            ...currentContexts,
            ...expandedAdditional,
        ]);

        this.logger.log({
            message: `Sufficiency loop completed for PR#${prNumber}: ${expandedAdditional.length} new snippets, ${mergedContexts.length} total after dedup`,
            context: CollectCrossFileContextsService.name,
            metadata: {
                organizationAndTeamData,
                prNumber,
                newSnippets: expandedAdditional.length,
                mergedTotal: mergedContexts.length,
                previousTotal: currentContexts.length,
            },
        });

        return {
            mergedContexts,
            additionalSearchCount: additionalQueries.length,
        };
    }

    private async evaluateSufficiency(
        changedFiles: FileChange[],
        plannerQueries: PlannerQuery[],
        currentContexts: CrossFileContextSnippet[],
        queryResultMap: Map<string, boolean>,
        language: string,
        byokConfig: BYOKConfig | undefined,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<CrossFileContextSufficiencySchemaType | null> {
        try {
            // Build diff summary (same truncation as planner)
            const diffSummary = changedFiles
                .map((f) => {
                    const diff = f.patchWithLinesStr || f.patch || '';
                    const truncated =
                        diff.length > 2000
                            ? diff.substring(0, 2000) + '\n... (truncated)'
                            : diff;
                    return `### ${f.filename}\n${truncated}`;
                })
                .join('\n\n');

            const payload: CrossFileContextSufficiencyPayload = {
                changedFilenames: changedFiles.map((f) => f.filename),
                diffSummary,
                language,
                originalQueries: plannerQueries.map((q) => ({
                    symbolName: q.symbolName,
                    pattern: q.pattern,
                    riskLevel: q.riskLevel,
                    rationale: q.rationale,
                    sourceFile: q.sourceFile,
                    foundResults: queryResultMap.get(q.pattern) ?? false,
                })),
                collectedSnippetsSummary: currentContexts.map((s) => ({
                    filePath: s.filePath,
                    relatedSymbol: s.relatedSymbol,
                    rationale: s.rationale,
                    riskLevel: s.riskLevel,
                    hop: s.hop,
                })),
            };

            const provider = LLMModelProvider.CEREBRAS_GPT_OSS_120B;
            const fallbackProvider = LLMModelProvider.GEMINI_3_FLASH_PREVIEW;

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                provider,
                fallbackProvider,
                byokConfig,
            );

            const runName = 'crossFileContextSufficiency';
            const spanName = `${CollectCrossFileContextsService.name}::${runName}`;
            const spanAttrs = {
                organizationId: organizationAndTeamData?.organizationId,
                prNumber,
                type: promptRunner.executeMode,
            };

            const builder = promptRunner
                .builder()
                .setParser(
                    ParserType.ZOD,
                    CrossFileContextSufficiencySchema as any,
                )
                .setLLMJsonMode(true)
                .setPayload(payload)
                .addPrompt({
                    prompt: prompt_cross_file_context_sufficiency,
                    role: PromptRole.SYSTEM,
                })
                .addPrompt({
                    prompt: 'Evaluate whether the collected cross-file context is sufficient. Return the response in the specified JSON format.',
                    role: PromptRole.USER,
                })
                .setTemperature(0)
                .addTags(['crossFileContextSufficiency', `model:${provider}`])
                .setRunName(runName)
                .addMetadata({
                    organizationAndTeamData,
                    prNumber,
                    runName,
                });

            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                byokConfig,
                exec: (callbacks) => builder.addCallbacks(callbacks).execute(),
            });

            return (result as CrossFileContextSufficiencySchemaType) ?? null;
        } catch (error) {
            this.logger.warn({
                message: `Sufficiency evaluation failed for PR#${prNumber} — continuing without it`,
                context: CollectCrossFileContextsService.name,
                error,
                metadata: { organizationAndTeamData, prNumber },
            });
            return null;
        }
    }
    //#endregion

    //#region Utilities
    private getBaseScore(riskLevel: 'low' | 'medium' | 'high'): number {
        switch (riskLevel) {
            case 'high':
                return 80;
            case 'medium':
                return 50;
            case 'low':
                return 30;
            default:
                return 20;
        }
    }

    private extractFunctionNames(content: string): string[] {
        const names: string[] = [];

        // Match common function/method patterns across languages
        const patterns = [
            // JS/TS: function name(, async name(, name(, name =(
            /(?:function|async)\s+(\w+)\s*\(/g,
            /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
            /(\w+)\s*\([^)]*\)\s*\{/g,
            // Python: def name(
            /def\s+(\w+)\s*\(/g,
            // Go: func name(, func (receiver) name(
            /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/g,
            // Java/C#: access modifier type name(
            /(?:public|private|protected|static)\s+\w+\s+(\w+)\s*\(/g,
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(content)) !== null) {
                const name = match[1];
                if (name && name.length >= 3 && !this.isCommonKeyword(name)) {
                    names.push(name);
                }
            }
        }

        return [...new Set(names)];
    }

    /**
     * Filters out function names that are too generic to produce useful hop 2 results.
     * These names match thousands of files in any codebase and produce mostly noise.
     */
    private isGenericFunctionName(name: string): boolean {
        const genericNames = new Set([
            'constructor',
            'execute',
            'run',
            'get',
            'set',
            'init',
            'setup',
            'create',
            'update',
            'delete',
            'remove',
            'find',
            'handle',
            'process',
            'call',
            'apply',
            'bind',
            'start',
            'stop',
            'close',
            'open',
            'read',
            'write',
            'send',
            'receive',
            'load',
            'save',
            'parse',
            'format',
            'validate',
            'transform',
            'resolve',
            'reject',
            'then',
            'map',
            'filter',
            'reduce',
            'forEach',
            'push',
            'pop',
            'shift',
            'toString',
            'valueOf',
            'compile',
            'build',
            'render',
            'mount',
            'unmount',
            'test',
            'describe',
            'expect',
        ]);
        return genericNames.has(name);
    }

    private isCommonKeyword(name: string): boolean {
        const keywords = new Set([
            'if',
            'for',
            'while',
            'return',
            'const',
            'let',
            'var',
            'function',
            'class',
            'import',
            'export',
            'from',
            'new',
            'this',
            'super',
            'async',
            'await',
            'try',
            'catch',
            'throw',
            'else',
            'switch',
            'case',
            'break',
            'continue',
            'default',
            'typeof',
            'instanceof',
        ]);
        return keywords.has(name);
    }

    private hasContentOverlap(a: string, b: string): boolean {
        if (a === b) return true;
        // Check if one contains a significant portion of the other
        const shorter = a.length < b.length ? a : b;
        const longer = a.length >= b.length ? a : b;
        return longer.includes(
            shorter.substring(0, Math.min(200, shorter.length)),
        );
    }
    //#endregion

    //#region Concurrency
    /**
     * Runs async tasks with bounded concurrency, returning PromiseSettledResult[].
     */
    private async runWithConcurrency<T>(
        tasks: (() => Promise<T>)[],
        concurrency: number,
    ): Promise<PromiseSettledResult<T>[]> {
        const results: PromiseSettledResult<T>[] = new Array(tasks.length);
        let idx = 0;

        const run = async () => {
            while (idx < tasks.length) {
                const i = idx++;
                try {
                    results[i] = {
                        status: 'fulfilled',
                        value: await tasks[i](),
                    };
                } catch (reason) {
                    results[i] = { status: 'rejected', reason };
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(concurrency, tasks.length) }, run),
        );
        return results;
    }
    //#endregion
}
