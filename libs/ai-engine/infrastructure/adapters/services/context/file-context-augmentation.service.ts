import type { ContextDependency, ContextEvidence } from '@kodus/flow';
import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import pLimit from 'p-limit';

import { ContextEvidenceAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/contextEvidenceAgent.provider';
import { ContextMCPDependency } from '@libs/agents/infrastructure/services/kodus-flow/contextEvidenceAgent.provider';
import {
    CodeReviewConfig,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { ContextAugmentationsMap } from './interfaces/code-review-context-pack.interface';
import {
    CodeReviewPipelineContext,
    FileContextAgentResult,
} from '@libs/code-review/pipeline/context/code-review-pipeline.context';

@Injectable()
export class FileContextAugmentationService {
    private readonly logger = createLogger(FileContextAugmentationService.name);
    private readonly concurrency = 5;

    constructor(
        private readonly contextEvidenceAgentProvider: ContextEvidenceAgentProvider,
    ) {}

    async augmentFiles(
        files: FileChange[],
        context: CodeReviewPipelineContext,
        mcpDependencies: ContextDependency[],
        kodyRule?: Partial<IKodyRule>,
    ): Promise<Record<string, ContextAugmentationsMap>> {
        if (!files?.length && !kodyRule) {
            return {};
        }

        if (!mcpDependencies?.length) {
            return {};
        }

        if (!context.organizationAndTeamData) {
            this.logger.warn({
                message:
                    'Missing organizationAndTeamData, skipping context augmentation',
                context: FileContextAugmentationService.name,
            });
            return {};
        }

        const {
            dependencies: extractedDependencies,
            lookup: dependencyLookup,
        } = this.extractMCPDependencies(mcpDependencies);

        if (kodyRule) {
            const result = await this.analyzeContext(
                files,
                context,
                extractedDependencies,
                dependencyLookup,
                kodyRule,
            );

            if (!result) {
                return {};
            }

            const augmentations = this.buildAugmentationsForFile(result);
            return {
                global: augmentations,
            };
        }

        const limit = pLimit(this.concurrency);
        const results = await Promise.allSettled(
            files.map((file) =>
                limit(() =>
                    this.analyzeContext(
                        [file],
                        context,
                        extractedDependencies,
                        dependencyLookup,
                        undefined,
                    ),
                ),
            ),
        );

        const validResults: FileContextAgentResult[] = [];
        const validFiles: FileChange[] = [];

        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                validResults.push(result.value);
                validFiles.push(files[index]);
            }
        });

        return this.buildAugmentationsByFile(validResults, validFiles);
    }

    private async analyzeContext(
        files: FileChange[],
        context: CodeReviewPipelineContext,
        dependencies: ContextMCPDependency[],
        dependencyLookup: Map<string, ContextMCPDependency>,
        kodyRule?: Partial<IKodyRule>,
    ) {
        try {
            const baseOverrides = this.getBasePromptOverrides(
                context,
                dependencies,
            );

            let sandboxEvidences: ContextEvidence[] = [];
            const agentResult = await this.contextEvidenceAgentProvider.execute(
                {
                    organizationAndTeamData: context.organizationAndTeamData,
                    files,
                    dependencies,
                    promptOverrides: baseOverrides,
                    additionalContext: this.buildAdditionalContext(context),
                    kodyRule: kodyRule,
                    // Per-repo/directory model override resolved by ValidateConfigStage.
                    byokModel: context.codeReviewConfig?.byokModel,
                },
            );

            if (!agentResult) {
                this.logger.debug({
                    message: 'Context agent returned null',
                    context: FileContextAugmentationService.name,
                    metadata: {
                        filesCount: files.length,
                        dependenciesCount: dependencies.length,
                        mode: kodyRule ? 'PR-Level' : 'File-Level',
                    },
                });
                return null;
            }

            if (agentResult?.actionsLog) {
                this.logger.debug({
                    message: 'Context agent actions log',
                    context: FileContextAugmentationService.name,
                    metadata: {
                        filesCount: files.length,
                        actionsLog: agentResult.actionsLog,
                    },
                });
            }

            if (agentResult?.evidences?.length) {
                sandboxEvidences = agentResult.evidences;
            }

            if (!sandboxEvidences.length) {
                this.logger.debug({
                    message: 'No evidences generated by agent',
                    context: FileContextAugmentationService.name,
                    metadata: {
                        filesCount: files.length,
                        actionsLog: agentResult.actionsLog,
                    },
                });
                return null;
            }

            sandboxEvidences = this.attachPathKeyToEvidence(
                sandboxEvidences,
                dependencyLookup,
            );

            return {
                sandboxEvidences,
            };
        } catch (error) {
            this.logger.error({
                message: 'Context augmentation execution failed',
                error,
                context: FileContextAugmentationService.name,
                metadata: {
                    filesCount: files.length,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return null;
        }
    }

    private buildAugmentationsByFile(
        results: Array<FileContextAgentResult | null>,
        files: FileChange[],
    ): Record<string, ContextAugmentationsMap> {
        const augmentationsMap: Record<string, ContextAugmentationsMap> = {};

        if (files.length === 0 && results.length > 0 && results[0]) {
            const prLevelAugmentations = this.buildAugmentationsForFile(
                results[0],
            );
            if (Object.keys(prLevelAugmentations).length > 0) {
                augmentationsMap['PR_LEVEL'] = prLevelAugmentations;
            }
            return augmentationsMap;
        }

        results.forEach((result, index) => {
            const file = files[index];
            if (!file || !result?.sandboxEvidences?.length) {
                return;
            }

            const fileAugmentations = this.buildAugmentationsForFile(result);
            if (Object.keys(fileAugmentations).length > 0) {
                augmentationsMap[file.filename] = fileAugmentations;
            }
        });

        return augmentationsMap;
    }

    private buildAugmentationsForFile(
        result: FileContextAgentResult,
    ): ContextAugmentationsMap {
        const map: ContextAugmentationsMap = {};

        if (!result?.sandboxEvidences?.length) {
            return map;
        }

        for (const evidence of result.sandboxEvidences) {
            if (
                (evidence.metadata as Record<string, unknown>)
                    ?.executionStatus !== 'success'
            ) {
                continue;
            }

            if (evidence.metadata?.hidden || evidence.metadata?.internal) {
                continue;
            }

            const resolvedToolName =
                (evidence as any).toolName ??
                evidence.metadata?.toolName?.toString() ??
                evidence.metadata?.tool?.toString();

            const pathKey =
                (evidence.metadata?.pathKey as string | undefined) ??
                this.resolvePathKeyFromMetadata(
                    evidence.metadata as Record<string, unknown> | undefined,
                );

            const rawKey = pathKey ?? 'generation.main';
            const key = rawKey.replace(/^v2PromptOverrides\./, '');

            if (!map[key]) {
                map[key] = {
                    path: key.split('.'),
                    outputs: [],
                };
            }

            map[key].outputs.push({
                provider: evidence.provider ?? 'unknown',
                toolName: resolvedToolName ?? 'unknown',
                success: true,
                output: this.serializeEvidencePayload(evidence.payload),
            });
        }

        return map;
    }

    private serializeEvidencePayload(payload: unknown): string {
        if (payload === null || payload === undefined) {
            return 'No output returned.';
        }
        if (typeof payload === 'string') {
            return payload;
        }

        try {
            return JSON.stringify(payload);
        } catch {
            return String(payload ?? '[unserializable payload]');
        }
    }

    private extractMCPDependencies(dependencies?: ContextDependency[]): {
        dependencies: ContextMCPDependency[];
        lookup: Map<string, ContextMCPDependency>;
    } {
        const list: ContextMCPDependency[] = [];
        const lookup = new Map<string, ContextMCPDependency>();

        if (!dependencies?.length) {
            return { dependencies: list, lookup };
        }

        for (const dependency of dependencies) {
            if (!dependency || dependency.type !== 'mcp') {
                continue;
            }

            const provider = this.resolveDependencyProvider(dependency);
            const toolName = this.resolveDependencyTool(dependency);

            if (!provider || !toolName) {
                continue;
            }

            const metadataRecord = (dependency.metadata ?? {}) as Record<
                string,
                unknown
            >;

            const info: ContextMCPDependency = {
                provider,
                toolName,
                path: Array.isArray(dependency.metadata?.path)
                    ? (dependency.metadata?.path as string[])
                    : undefined,
                pathKey:
                    typeof dependency.metadata?.pathKey === 'string'
                        ? (dependency.metadata?.pathKey as string)
                        : undefined,
                requirementId:
                    typeof dependency.metadata?.requirementId === 'string'
                        ? (dependency.metadata?.requirementId as string)
                        : undefined,
                metadata: metadataRecord ?? undefined,
                descriptor: dependency.descriptor,
                schema: this.resolveDependencySchema(dependency),
                requiredArgs: this.resolveDependencyRequiredArgs(dependency),
                description: this.resolveDependencyDescription(dependency),
            };

            list.push(info);
            lookup.set(this.normalizeProviderToolKey(provider, toolName), info);
        }

        return { dependencies: list, lookup };
    }

    private getBasePromptOverrides(
        context: CodeReviewPipelineContext,
        dependencies: ContextMCPDependency[],
    ): CodeReviewConfig['v2PromptOverrides'] | undefined {
        const allOverrides = context.codeReviewConfig?.v2PromptOverrides;

        if (!allOverrides || !dependencies?.length) {
            return allOverrides;
        }

        const filteredOverrides: any = {};
        const uniquePathKeys = [
            ...new Set(
                dependencies.map((d) => d.pathKey).filter(Boolean) as string[],
            ),
        ];

        if (uniquePathKeys.length === 0) {
            return {};
        }

        for (const pathKey of uniquePathKeys) {
            const path = pathKey.replace(/^v2PromptOverrides\./, '').split('.');

            const getValue = (obj: any, pathArr: string[]) =>
                pathArr.reduce((acc, key) => acc && acc[key], obj);

            const value = getValue(allOverrides, path);

            if (value !== undefined) {
                let current = filteredOverrides;
                for (let i = 0; i < path.length - 1; i++) {
                    const key = path[i];
                    if (!current[key]) {
                        current[key] = {};
                    }
                    current = current[key];
                }
                current[path[path.length - 1]] = value;
            }
        }

        return Object.keys(filteredOverrides).length
            ? (filteredOverrides as CodeReviewConfig['v2PromptOverrides'])
            : undefined;
    }

    private buildAdditionalContext(context: CodeReviewPipelineContext): any {
        const { repository, pullRequest, correlationId } = context;

        return {
            repository: {
                name:
                    repository?.fullName ?? repository?.name ?? repository?.id,
                currentBranch: context.branch,
            },
            pullRequest: {
                pr_number: pullRequest?.number,
                pr_title: pullRequest?.title,
                pr_description: pullRequest?.body,
                pr_total_additions: pullRequest?.stats?.total_additions,
                pr_total_deletions: pullRequest?.stats?.total_deletions,
                pr_total_files: pullRequest?.stats?.total_files,
                pr_total_lines_changed: pullRequest?.stats?.total_lines_changed,
                pr_base_branch: pullRequest?.base?.ref,
                pr_tags: pullRequest?.tags ?? [],
                pr_author: pullRequest?.user?.login ?? pullRequest?.user?.name,
                pr_stats: pullRequest?.stats,
            },
            correlationId,
        };
    }

    private normalizeProviderToolKey(
        provider?: string,
        toolName?: string,
    ): string {
        return `${(provider ?? 'default').trim().toLowerCase()}|${(toolName ?? '').trim().toLowerCase()}`;
    }

    private attachPathKeyToEvidence(
        evidences: ContextEvidence[],
        dependencyLookup: Map<string, ContextMCPDependency>,
    ): ContextEvidence[] {
        return evidences.map((evidence) => {
            const metadata = {
                ...(evidence.metadata as Record<string, unknown> | undefined),
            };

            if (!metadata.toolName) {
                metadata.toolName = evidence.toolName ?? metadata.toolName;
            }

            if (!metadata.provider) {
                metadata.provider =
                    evidence.provider ?? metadata.provider ?? undefined;
            }

            if (!metadata.pathKey) {
                const provider = this.resolveEvidenceProvider(evidence);
                const toolName =
                    evidence.toolName ?? (metadata.toolName as string);

                if (provider && toolName) {
                    const dependency = dependencyLookup.get(
                        this.normalizeProviderToolKey(provider, toolName),
                    );

                    if (dependency?.metadata) {
                        if (dependency.metadata.hidden) {
                            metadata.hidden = true;
                        }

                        if (dependency.metadata.internal) {
                            metadata.internal = true;
                        }
                    }

                    if (dependency?.pathKey) {
                        metadata.pathKey = dependency.pathKey;
                    }
                }
            }

            return {
                ...evidence,
                metadata,
            };
        });
    }

    private resolveEvidenceProvider(
        evidence: ContextEvidence,
    ): string | undefined {
        const provider =
            (evidence.metadata?.provider as string | undefined) ??
            evidence.provider;
        return typeof provider === 'string'
            ? provider.trim().toLowerCase()
            : undefined;
    }

    private resolveDependencySchema(dependency: ContextDependency): unknown {
        const metadata = dependency.metadata as
            | Record<string, unknown>
            | undefined;
        if (metadata?.toolInputSchema) {
            return metadata.toolInputSchema;
        }

        if (
            dependency.descriptor &&
            typeof dependency.descriptor === 'object' &&
            (dependency.descriptor as Record<string, unknown>).schema
        ) {
            return (dependency.descriptor as Record<string, unknown>).schema;
        }

        return undefined;
    }

    private resolveDependencyDescription(
        dependency: ContextDependency,
    ): string | undefined {
        const metadata = dependency.metadata as
            | Record<string, unknown>
            | undefined;
        if (typeof metadata?.description === 'string') {
            return metadata.description;
        }

        if (
            dependency.descriptor &&
            typeof dependency.descriptor === 'object' &&
            typeof (dependency.descriptor as Record<string, unknown>)
                .description === 'string'
        ) {
            return (dependency.descriptor as Record<string, unknown>)
                .description as string;
        }

        return undefined;
    }

    private resolveDependencyRequiredArgs(
        dependency: ContextDependency,
    ): string[] | undefined {
        const metadata = dependency.metadata as
            | Record<string, unknown>
            | undefined;
        if (Array.isArray(metadata?.requiredArgs)) {
            return (metadata.requiredArgs as unknown[]).filter(
                (item): item is string => typeof item === 'string',
            );
        }

        return undefined;
    }

    private resolvePathKeyFromMetadata(
        metadata?: Record<string, unknown>,
    ): string | undefined {
        if (!metadata) {
            return undefined;
        }

        if (typeof metadata.pathKey === 'string') {
            return metadata.pathKey;
        }

        const category =
            typeof metadata.category === 'string'
                ? metadata.category.toLowerCase()
                : undefined;

        if (category === 'bug') {
            return 'categories.descriptions.bug';
        }

        if (category === 'performance') {
            return 'categories.descriptions.performance';
        }

        if (category === 'security') {
            return 'categories.descriptions.security';
        }

        return undefined;
    }

    private resolveDependencyProvider(
        dependency: ContextDependency,
    ): string | undefined {
        const metadata = dependency.metadata ?? {};
        if (typeof metadata.provider === 'string') {
            return metadata.provider.trim().toLowerCase();
        }
        if (typeof metadata.mcpId === 'string') {
            return metadata.mcpId.trim().toLowerCase();
        }
        const [provider] = dependency.id.split('|', 2);
        return provider?.trim().toLowerCase();
    }

    private resolveDependencyTool(
        dependency: ContextDependency,
    ): string | undefined {
        const metadata = dependency.metadata ?? {};
        if (typeof metadata.toolName === 'string') {
            return metadata.toolName.trim().toLowerCase();
        }
        if (typeof metadata.tool === 'string') {
            return metadata.tool.trim().toLowerCase();
        }
        const [, toolName] = dependency.id.split('|', 2);
        return toolName?.trim().toLowerCase();
    }
}
