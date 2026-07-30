import { createHash } from 'crypto';

import type {
    ContextDependency,
    ContextLayer,
    ContextLayerBuilder,
    ContextPack,
    ContextRequirement,
    LayerInputContext,
    LayerBuildOptions,
    LayerBuildResult,
    PackAssemblyStep,
} from './context-pack';
import { SequentialPackAssemblyPipeline } from './context-pack';
import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';

import { PromptReferenceErrorType } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import type { IPromptReferenceSyncError } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import type {
    CodeReviewConfig,
    Repository,
    AnalysisContext,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import {
    CODE_REVIEW_CONTEXT_PATTERNS,
    pathToKey,
    stripMarkersFromText,
    deepClone,
} from './code-review-context.utils';
import { ContextReferenceService } from './context-reference.service';

import { ContextAugmentationsMap } from './interfaces/code-review-context-pack.interface';

interface BuildPackParams {
    organizationAndTeamData?: OrganizationAndTeamData;
    contextReferenceId?: string;
    overrides?: CodeReviewConfig['v2PromptOverrides'];
    externalLayers?: ContextLayer[];
    repository?: Partial<Repository>;
    pullRequest?: AnalysisContext['pullRequest'];
}

interface BuildPackResult {
    sanitizedOverrides?: CodeReviewConfig['v2PromptOverrides'];
    augmentations?: ContextAugmentationsMap;
    pack?: ContextPack;
}

const DEFAULT_LAYER_INPUT: LayerInputContext = {
    domain: 'code',
    taskIntent: 'review',
    retrieval: {
        candidates: [],
    },
};

class StaticLayerBuilder implements ContextLayerBuilder {
    public readonly stage = 'core' as unknown as ContextLayerBuilder['stage'];

    constructor(private readonly layerFactory: () => ContextLayer) {}

    async build(
        _input: LayerInputContext,
        _options?: LayerBuildOptions,
    ): Promise<LayerBuildResult> {
        return {
            layer: this.layerFactory(),
            resources: [],
        };
    }
}

@Injectable()
export class CodeReviewContextPackService {
    private readonly logger = createLogger(CodeReviewContextPackService.name);
    constructor(
        private readonly contextReferenceService: ContextReferenceService,
        private readonly codeManagementService: CodeManagementService,
    ) {}

    async buildContextPack(params: BuildPackParams): Promise<BuildPackResult> {
        const { organizationAndTeamData, contextReferenceId, overrides } =
            params;

        const processedOverrides = overrides
            ? (JSON.parse(
                  JSON.stringify(overrides),
              ) as CodeReviewConfig['v2PromptOverrides'])
            : undefined;

        if (!contextReferenceId || !organizationAndTeamData?.organizationId) {
            return {
                sanitizedOverrides: this.sanitizeOverrides(processedOverrides),
            };
        }

        const reference =
            await this.contextReferenceService.findById(contextReferenceId);

        if (!reference) {
            return {
                sanitizedOverrides: this.sanitizeOverrides(processedOverrides),
            };
        }

        const requirements = reference.requirements ?? [];
        const knowledgeDependencies =
            this.buildDependencyGroups(requirements);
        const hasPackContent =
            Boolean(processedOverrides) ||
            knowledgeDependencies.length > 0 ||
            (params.externalLayers?.length ?? 0) > 0;

        if (!hasPackContent) {
            return {
                sanitizedOverrides: this.sanitizeOverrides(processedOverrides),
            };
        }

        const knowledgeResolution = knowledgeDependencies.length
            ? await this.resolveKnowledgeDependencies({
                  contextReferenceId,
                  dependencies: knowledgeDependencies,
                  organizationAndTeamData,
                  repository: params.repository,
                  pullRequest: params.pullRequest,
              })
            : {
                  layers: [],
                  items: [],
                  errors: [] as IPromptReferenceSyncError[],
              };

        const instructionsLayer = this.createInstructionsLayer(
            contextReferenceId,
            processedOverrides,
        );

        const pack = await this.assemblePackFromPipeline({
            contextReferenceId,
            instructionsLayer,
            externalLayers: params.externalLayers,
        });

        if (knowledgeResolution.layers.length) {
            for (const layer of knowledgeResolution.layers) {
                pack.layers.push(this.cloneLayer(layer));
            }
        }

        pack.dependencies = [...knowledgeDependencies];
        pack.metadata = {
            ...(pack.metadata ?? {}),
            contextReferenceId,
            configContextReferenceId: reference.metadata?.contextReferenceId,
            requirementIds: requirements.map((req) => req.id),
            knowledgeItemsCount: knowledgeResolution.items.length,
            knowledgeErrors: knowledgeResolution.errors,
        };

        try {
            await this.contextReferenceService.update(
                { uuid: contextReferenceId },
                {
                    metadata: {
                        ...(reference.metadata ?? {}),
                        syncErrors: knowledgeResolution.errors,
                    },
                    lastProcessedAt: new Date(),
                },
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to persist sync errors back to context reference',
                context: CodeReviewContextPackService.name,
                error,
                metadata: {
                    contextReferenceId,
                    syncErrorsCount: knowledgeResolution.errors.length,
                },
            });
        }

        return {
            sanitizedOverrides: processedOverrides,
            pack,
        };
    }

    private sanitizeOverrides(
        overrides?: CodeReviewConfig['v2PromptOverrides'],
    ): CodeReviewConfig['v2PromptOverrides'] | undefined {
        if (!overrides) {
            return undefined;
        }

        const clone = JSON.parse(
            JSON.stringify(overrides),
        ) as CodeReviewConfig['v2PromptOverrides'];

        const sanitizeRecursive = (node: unknown): unknown => {
            if (typeof node === 'string') {
                return stripMarkersFromText(node, CODE_REVIEW_CONTEXT_PATTERNS);
            }

            if (Array.isArray(node)) {
                return node.map((item) => sanitizeRecursive(item));
            }

            if (node && typeof node === 'object') {
                const candidate = node as Record<string, unknown>;

                if (candidate.type === 'mcpMention') {
                    return node;
                }

                const result: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(candidate)) {
                    result[key] = sanitizeRecursive(value);
                }
                return result;
            }

            return node;
        };

        return sanitizeRecursive(
            clone,
        ) as CodeReviewConfig['v2PromptOverrides'];
    }

    private buildDependencyGroups(
        requirements: ContextRequirement[],
    ): ContextDependency[] {
        const knowledgeDependencies: ContextDependency[] = [];
        const knowledgeDedupe = new Set<string>();

        for (const requirement of requirements) {
            const path = this.resolveRequirementPath(requirement);
            const pathKey = pathToKey(path);

            for (const dependency of requirement.dependencies ?? []) {
                if (!dependency || dependency.type !== 'knowledge') {
                    continue;
                }

                const filePath = dependency.metadata?.filePath as
                    | string
                    | undefined;
                if (!filePath) {
                    continue;
                }

                const repositoryName = dependency.metadata?.repositoryName as
                    | string
                    | undefined;
                const repositoryId = dependency.metadata?.repositoryId as
                    | string
                    | undefined;

                const knowledgeKey = `${repositoryName ?? repositoryId ?? 'default'}::${filePath}`;
                if (knowledgeDedupe.has(knowledgeKey)) {
                    continue;
                }
                knowledgeDedupe.add(knowledgeKey);

                const metadata = {
                    ...(dependency.metadata ?? {}),
                    filePath,
                    repositoryName,
                    repositoryId,
                    path,
                    pathKey,
                    requirementId: requirement.id,
                };

                knowledgeDependencies.push({
                    type: 'knowledge',
                    id: dependency.id || knowledgeKey,
                    descriptor: dependency.descriptor,
                    metadata,
                });
            }
        }

        return knowledgeDependencies;
    }

    private async resolveKnowledgeDependencies(params: {
        contextReferenceId: string;
        dependencies: ContextDependency[];
        organizationAndTeamData?: OrganizationAndTeamData;
        repository?: Partial<Repository>;
        pullRequest?: AnalysisContext['pullRequest'];
    }): Promise<{
        layers: ContextLayer[];
        items: Array<{
            dependencyId: string;
            filePath: string;
            repositoryId?: string;
            repositoryName?: string;
            content: string;
            lineRange?: { start: number; end: number };
            description?: string;
            tokens: number;
            hash: string;
        }>;
        errors: IPromptReferenceSyncError[];
    }> {
        const { contextReferenceId, dependencies, organizationAndTeamData } =
            params;

        const resolvedItems: Array<{
            dependencyId: string;
            filePath: string;
            repositoryId?: string;
            repositoryName?: string;
            content: string;
            lineRange?: { start: number; end: number };
            description?: string;
            tokens: number;
            hash: string;
        }> = [];
        const errors: IPromptReferenceSyncError[] = [];
        const dedupe = new Set<string>();

        for (const dependency of dependencies) {
            const filePath = dependency.metadata?.filePath as
                | string
                | undefined;
            if (!filePath) {
                continue;
            }

            const rawRepositoryName =
                (dependency.metadata?.repositoryName as string | undefined) ??
                params.repository?.name;
            const rawRepositoryId =
                (dependency.metadata?.repositoryId as string | undefined) ??
                params.repository?.id;

            const repositoryName = rawRepositoryName?.trim();
            const repositoryId = rawRepositoryId?.trim();
            const description = dependency.metadata?.description as
                | string
                | undefined;
            const lineRange = dependency.metadata?.lineRange as
                | { start: number; end: number }
                | undefined;

            const uniqueKey = `${repositoryName ?? repositoryId ?? 'default'}::${filePath}::${lineRange?.start ?? 'all'}-${lineRange?.end ?? 'all'}`;
            if (dedupe.has(uniqueKey)) {
                continue;
            }
            dedupe.add(uniqueKey);

            const dependencyMetadata =
                (dependency.metadata as Record<string, unknown>) ?? {};
            if (repositoryName) {
                dependencyMetadata.repositoryName = repositoryName;
            }
            if (repositoryId) {
                dependencyMetadata.repositoryId = repositoryId;
            }
            dependency.metadata = dependencyMetadata;

            try {
                const content = await this.fetchKnowledgeContent({
                    filePath,
                    repositoryId,
                    repositoryName,
                    organizationAndTeamData,
                    repositoryFallback: params.repository,
                    pullRequest: params.pullRequest,
                    lineRange,
                });

                if (!content) {
                    errors.push({
                        type: PromptReferenceErrorType.FILE_NOT_FOUND,
                        message: `File not found: ${filePath}`,
                        details: {
                            fileName: filePath,
                            repositoryName:
                                repositoryName ?? params.repository?.name,
                            timestamp: new Date(),
                        },
                    });
                    continue;
                }

                const tokens = this.estimateTokens(content);
                const hash = this.calculateContentHash(content);

                resolvedItems.push({
                    dependencyId: dependency.id as string,
                    filePath,
                    repositoryId: repositoryId ?? params.repository?.id,
                    repositoryName: repositoryName ?? params.repository?.name,
                    content,
                    lineRange,
                    description,
                    tokens,
                    hash,
                });
            } catch (error) {
                this.logger.error({
                    message:
                        'Failed to resolve knowledge dependency for context pack',
                    context: CodeReviewContextPackService.name,
                    error,
                    metadata: {
                        filePath,
                        repositoryId,
                        repositoryName,
                        contextReferenceId,
                    },
                });

                errors.push({
                    type: PromptReferenceErrorType.FETCH_FAILED,
                    message: `Error loading knowledge dependency: ${filePath}`,
                    details: {
                        fileName: filePath,
                        repositoryName:
                            repositoryName ?? params.repository?.name,
                        timestamp: new Date(),
                    },
                });
            }
        }

        if (!resolvedItems.length) {
            return { layers: [], items: [], errors };
        }

        const knowledgeLayer: ContextLayer = {
            id: `${contextReferenceId}::knowledge`,
            kind: 'catalog',
            priority: 1,
            tokens: resolvedItems.reduce((sum, item) => sum + item.tokens, 0),
            content: resolvedItems.map((item) => ({
                id: item.dependencyId,
                filePath: item.filePath,
                repositoryId: item.repositoryId,
                repositoryName: item.repositoryName,
                lineRange: item.lineRange,
                description: item.description,
                content: item.content,
                tokens: item.tokens,
                hash: item.hash,
            })),
            references: resolvedItems.map((item) => ({
                itemId: item.dependencyId,
            })),
            metadata: {
                contextReferenceId,
                type: 'knowledge',
                itemsCount: resolvedItems.length,
                sourceType: 'knowledge',
            },
        };

        return {
            layers: [knowledgeLayer],
            items: resolvedItems,
            errors,
        };
    }

    private async fetchKnowledgeContent(params: {
        filePath: string;
        repositoryId?: string;
        repositoryName?: string;
        repositoryFallback?: Partial<Repository>;
        organizationAndTeamData?: OrganizationAndTeamData;
        pullRequest?: AnalysisContext['pullRequest'];
        lineRange?: { start: number; end: number };
    }): Promise<string | null> {
        const {
            filePath,
            repositoryId,
            repositoryName,
            repositoryFallback,
            organizationAndTeamData,
            pullRequest,
            lineRange,
        } = params;

        const repoName = repositoryName ?? repositoryFallback?.name;
        const repoId = repositoryId ?? repositoryFallback?.id ?? '';

        if (!repoName) {
            return null;
        }

        const response =
            await this.codeManagementService.getRepositoryContentFile({
                organizationAndTeamData,
                repository: {
                    id: repoId,
                    name: repoName,
                },
                file: { filename: filePath },
                pullRequest: pullRequest as any,
            });

        let content = response?.data?.content;
        if (!content) {
            return null;
        }

        if (response?.data?.encoding === 'base64') {
            content = Buffer.from(content, 'base64').toString('utf-8');
        }

        if (lineRange) {
            const extracted = this.extractLineRange(content, lineRange);
            if (extracted && extracted.trim().length > 0) {
                content = extracted;
            }
        }

        return content;
    }

    private extractLineRange(
        content: string,
        range: { start: number; end: number },
    ): string {
        const lines = content.split('\n');

        if (range.start <= 0 || range.end <= 0 || range.start > range.end) {
            this.logger.warn({
                message: 'Invalid line range provided for knowledge dependency',
                context: CodeReviewContextPackService.name,
                metadata: { range },
            });
            return '';
        }

        if (range.start > lines.length) {
            this.logger.warn({
                message:
                    'Line range start exceeds file length for knowledge dependency',
                context: CodeReviewContextPackService.name,
                metadata: { range, totalLines: lines.length },
            });
            return '';
        }

        const start = Math.max(0, range.start - 1);
        const end = Math.min(lines.length, range.end);
        return lines.slice(start, end).join('\n');
    }

    private estimateTokens(content: string): number {
        if (!content) {
            return 0;
        }
        return Math.max(1, Math.ceil(content.length / 4));
    }

    private calculateContentHash(content: string): string {
        return createHash('sha256').update(content).digest('hex');
    }

    private async assemblePackFromPipeline(params: {
        contextReferenceId: string;
        instructionsLayer?: ContextLayer;
        externalLayers?: ContextLayer[];
    }): Promise<ContextPack> {
        const steps: PackAssemblyStep[] = [];

        if (params.instructionsLayer) {
            const snapshot = this.cloneLayer(params.instructionsLayer);
            steps.push({
                description: 'Code review instructions',
                builder: new StaticLayerBuilder(() =>
                    this.cloneLayer(snapshot),
                ),
            });
        }

        const pipeline = new SequentialPackAssemblyPipeline({
            steps,
            createdBy: 'code-review-context-pack',
            packIdFactory: () => `code-review:${params.contextReferenceId}`,
            versionFactory: () => '1.0.0',
        });

        const input: LayerInputContext = {
            domain: DEFAULT_LAYER_INPUT.domain,
            taskIntent: DEFAULT_LAYER_INPUT.taskIntent,
            retrieval: {
                candidates: [],
                diagnostics: {},
            },
            metadata: {
                contextReferenceId: params.contextReferenceId,
            },
        };

        const { pack } = await pipeline.execute(input);

        if (params.externalLayers?.length) {
            for (const layer of params.externalLayers) {
                pack.layers.push(this.cloneLayer(layer));
            }
        }

        return pack;
    }

    private createInstructionsLayer(
        contextReferenceId: string,
        overrides?: CodeReviewConfig['v2PromptOverrides'],
    ): ContextLayer | undefined {
        if (!overrides) {
            return undefined;
        }

        return {
            id: `${contextReferenceId}::instructions`,
            kind: 'core',
            priority: 1,
            tokens: 0,
            content: deepClone(overrides),
            references: [],
            metadata: {
                contextReferenceId,
                sourceType: 'instructions',
            },
        };
    }

    private resolveRequirementPath(requirement: ContextRequirement): string[] {
        if (
            Array.isArray(requirement.metadata?.path) &&
            requirement.metadata.path.every(
                (segment) => typeof segment === 'string',
            )
        ) {
            return requirement.metadata.path as string[];
        }

        return this.derivePathFromRequirementId(requirement.id);
    }

    private derivePathFromRequirementId(id: string): string[] {
        if (!id.includes('#')) {
            return [id];
        }

        const [, tail] = id.split('#');
        return tail.split('.');
    }

    private cloneLayer(layer: ContextLayer): ContextLayer {
        return {
            ...layer,
            content: deepClone(layer.content),
            references: layer.references.map((ref) => ({ ...ref })),
            metadata: layer.metadata ? deepClone(layer.metadata) : undefined,
        };
    }
}
