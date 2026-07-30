import { createHash } from 'crypto';

import type {
    ContextConsumerKind,
    ContextDependency,
    ContextDomain,
    ContextRequirement,
} from './context-pack';
import { createLogger } from '@libs/core/log/logger';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';
import {
    IPromptReferenceSyncError,
    PromptSourceType,
} from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IPromptContextEngineService,
    PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN,
} from '@libs/ai-engine/domain/prompt/contracts/promptContextEngine.contract';
import {
    CONTEXT_REFERENCE_SERVICE_TOKEN,
    IContextReferenceService,
} from '@libs/ai-engine/domain/contextReference/contracts/context-reference.service.contract';

export interface ContextDetectionField {
    fieldId?: string;
    path: string[];
    sourceType: PromptSourceType | string;
    text: string;
    inlineMarkers?: string[];
    promptHash?: string;
    metadata?: Record<string, unknown>;
    consumerKind?: ContextConsumerKind;
    consumerName?: string;
    requestDomain?: ContextDomain;
    taskIntent?: string;
    conversationIdOverride?: string;
}

export interface ContextReferenceDetectionParams {
    entityType: 'kodyRule' | 'codeReviewConfig';
    entityId: string;
    fields: ContextDetectionField[];
    repositoryId?: string;
    repositoryName?: string;
    organizationAndTeamData: OrganizationAndTeamData;
    byokConfig?: BYOKConfig;
    subscriptionStatus?: string;
}

@Injectable()
export class ContextReferenceDetectionService {
    private readonly logger = createLogger(
        ContextReferenceDetectionService.name,
    );
    constructor(
        @Inject(PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN)
        private readonly promptContextEngine: IPromptContextEngineService,
        @Inject(CONTEXT_REFERENCE_SERVICE_TOKEN)
        private readonly contextReferenceService: IContextReferenceService,
    ) {}

    async detectAndSaveReferences(
        params: ContextReferenceDetectionParams,
    ): Promise<string | undefined> {
        const {
            entityType,
            entityId,
            fields,
            repositoryId,
            repositoryName,
            organizationAndTeamData,
            byokConfig,
            subscriptionStatus,
        } = params;

        if (!fields || fields.length === 0) {
            this.logger.warn({
                message: 'No fields provided for context detection',
                context: ContextReferenceDetectionService.name,
                metadata: { entityType, entityId },
            });
            return undefined;
        }

        const preparedFields = fields
            .map((field) => ({
                ...field,
                text: field.text ?? '',
            }))
            .filter((field) => field.text.trim().length > 0);

        if (!preparedFields.length) {
            this.logger.warn({
                message: 'All provided fields are empty after trimming',
                context: ContextReferenceDetectionService.name,
                metadata: { entityType, entityId },
            });
            return undefined;
        }

        this.logger.log({
            message: `Starting context detection for ${entityType}`,
            context: ContextReferenceDetectionService.name,
            metadata: {
                entityType,
                entityId,
                repositoryId,
                fieldsCount: preparedFields.length,
            },
        });

        const requirements: ContextRequirement[] = [];
        const knowledgeRefsMap = new Map<
            string,
            { itemId: string; version?: string }
        >();
        const aggregatedSyncErrors: IPromptReferenceSyncError[] = [];

        for (const field of preparedFields) {
            const result = await this.processFieldDetection({
                entityType,
                entityId,
                field,
                repositoryId,
                repositoryName,
                organizationAndTeamData,
                byokConfig,
                subscriptionStatus,
            });

            if (!result) {
                continue;
            }

            requirements.push(result.requirement);

            for (const ref of result.knowledgeRefs) {
                if (!knowledgeRefsMap.has(ref.itemId)) {
                    knowledgeRefsMap.set(ref.itemId, ref);
                }
            }

            aggregatedSyncErrors.push(...result.syncErrors);
        }

        if (!requirements.length) {
            // A CLEAN detection must still overwrite a previously-errored
            // revision: skipping the save here left stale syncErrors (and
            // their UI chip) alive forever — once a rule ever had a sync
            // error, no later fix could clear it because the clean result
            // was never persisted.
            const previous =
                await this.contextReferenceService.getLatestRevision(
                    entityType,
                    entityId,
                );
            if (previous) {
                this.logger.log({
                    message:
                        'Clean detection over an existing revision — committing empty revision to clear stale state',
                    context: ContextReferenceDetectionService.name,
                    metadata: { entityType, entityId },
                });
                return this.saveToContextOS({
                    entityType,
                    entityId,
                    requirements: [],
                    knowledgeRefs: [],
                    entityHash: this.calculateEntityHash(
                        preparedFields
                            .map((field) => field.text.trim())
                            .join('\n:::\n'),
                    ),
                    aggregatedSyncErrors: [],
                    organizationAndTeamData,
                    repositoryId,
                    repositoryName,
                });
            }
            this.logger.warn({
                message: 'No requirements generated after processing fields',
                context: ContextReferenceDetectionService.name,
                metadata: { entityType, entityId },
            });
            return undefined;
        }

        const entityHash = this.calculateEntityHash(
            preparedFields.map((field) => field.text.trim()).join('\n:::\n'),
        );

        const knowledgeRefs = Array.from(knowledgeRefsMap.values());

        return this.saveToContextOS({
            entityType,
            entityId,
            requirements,
            knowledgeRefs,
            entityHash,
            aggregatedSyncErrors,
            organizationAndTeamData,
            repositoryId,
            repositoryName,
        });
    }

    private calculateEntityHash(text: string): string {
        return createHash('sha256').update(text).digest('hex');
    }

    private async processFieldDetection(params: {
        entityType: 'kodyRule' | 'codeReviewConfig';
        entityId: string;
        field: ContextDetectionField;
        repositoryId?: string;
        repositoryName?: string;
        organizationAndTeamData: OrganizationAndTeamData;
        byokConfig?: BYOKConfig;
        subscriptionStatus?: string;
    }): Promise<
        | {
              requirement: ContextRequirement;
              knowledgeRefs: Array<{ itemId: string; version?: string }>;
              syncErrors: IPromptReferenceSyncError[];
          }
        | undefined
    > {
        const {
            entityType,
            entityId,
            field,
            repositoryId,
            repositoryName,
            organizationAndTeamData,
            byokConfig,
            subscriptionStatus,
        } = params;

        const trimmedText = field.text.trim();
        if (!trimmedText) {
            return undefined;
        }

        const fieldKey = this.resolveFieldKey(field);
        const hasSuffix = !!fieldKey && fieldKey.length > 0;
        const requirementId = hasSuffix
            ? `${entityType}:${entityId}#${fieldKey}`
            : `${entityType}:${entityId}`;
        const consumerId = field.conversationIdOverride
            ? field.conversationIdOverride
            : hasSuffix
              ? `${entityId}#${fieldKey}`
              : entityId;
        const consumerKind: ContextConsumerKind =
            field.consumerKind ??
            (entityType === 'kodyRule' ? 'prompt' : 'prompt_section');
        const consumerName =
            field.consumerName ?? (hasSuffix ? fieldKey : entityId);
        const requestDomain: ContextDomain =
            field.requestDomain ??
            (entityType === 'kodyRule' ? ('code' as ContextDomain) : 'general');
        const taskIntent =
            field.taskIntent ?? `Process ${entityType} references`;

        let detectionReferences: Array<{
            filePath: string;
            description?: string;
            originalText?: string;
            lineRange?: { start: number; end: number };
            repositoryName?: string;
            repositoryId?: string;
            lastValidatedAt?: string | Date;
            lastContentHash?: string;
            estimatedTokens?: number;
        }> = [];
        let detectionSyncErrors: IPromptReferenceSyncError[] = [];

        const shouldAttemptDetection =
            this.hasLikelyExternalReferences(trimmedText) ||
            entityType === 'kodyRule';

        if (shouldAttemptDetection) {
            const detection = await this.detectAndResolveReferences({
                text: trimmedText,
                path: field.path,
                sourceType: field.sourceType,
                entityType,
                repositoryId,
                repositoryName,
                organizationAndTeamData,
                byokConfig,
                subscriptionStatus,
                fieldId: fieldKey,
            });

            detectionReferences = detection.references;
            detectionSyncErrors = detection.syncErrors;
        } else {
            this.logger.debug({
                message: 'Skipping detection due to lack of reference patterns',
                context: ContextReferenceDetectionService.name,
                metadata: {
                    entityType,
                    entityId,
                    fieldKey,
                },
            });
        }

        const normalization = this.buildKnowledgeDependencies({
            references: detectionReferences,
            syncErrors: detectionSyncErrors,
            repositoryName,
            repositoryId,
        });

        const dependencies = normalization.dependencies;
        const syncErrors = normalization.syncErrors;

        if (dependencies.length === 0 && syncErrors.length === 0) {
            this.logger.debug({
                message: 'Skipping field without dependencies or sync errors',
                context: ContextReferenceDetectionService.name,
                metadata: {
                    entityType,
                    entityId,
                    fieldKey,
                },
            });
            return undefined;
        }

        const knowledgeRefs = this.extractKnowledgeRefs(dependencies);

        const requirementMetadata: Record<string, unknown> = {
            source: entityType,
            entityHash: this.calculateEntityHash(trimmedText),
            path: field.path,
            sourceType: field.sourceType,
            sourceSnippet: field.metadata?.sourceSnippet ?? trimmedText,
        };

        if (field.inlineMarkers?.length) {
            requirementMetadata.inlineMarkers = Array.from(
                new Set(field.inlineMarkers),
            );
        }

        if (field.promptHash) {
            requirementMetadata.promptHash = field.promptHash;
        }

        if (field.metadata) {
            const { sourceSnippet: _ignoredSnippet, ...rest } = field.metadata;
            Object.assign(requirementMetadata, rest);
        }

        if (syncErrors.length) {
            requirementMetadata.syncErrors = syncErrors;
        }

        const consumerMetadata: Record<string, unknown> = {
            path: field.path,
            sourceType: field.sourceType,
        };

        const requirement: ContextRequirement = {
            id: requirementId,
            consumer: {
                kind: consumerKind,
                id: consumerId,
                name: consumerName,
                metadata: consumerMetadata,
            },
            request: {
                domain: requestDomain,
                taskIntent,
                signal: {
                    conversationId: consumerId,
                    metadata: {
                        path: field.path,
                        sourceType: field.sourceType,
                    },
                },
            },
            dependencies,
            status: syncErrors.length > 0 ? 'draft' : 'active',
            metadata: requirementMetadata,
        };

        this.logger.debug({
            message: 'Built requirement for field',
            context: ContextReferenceDetectionService.name,
            metadata: {
                requirementId,
                dependencyCount: dependencies.length,
                syncErrors: syncErrors.length,
            },
        });

        return {
            requirement,
            knowledgeRefs,
            syncErrors,
        };
    }

    private resolveFieldKey(field: ContextDetectionField): string {
        if (field.fieldId !== undefined) {
            return field.fieldId.trim();
        }

        return this.buildPathKey(field.path);
    }

    private buildPathKey(path: string[]): string {
        if (!path || path.length === 0) {
            return '';
        }

        return path.join('.');
    }

    private extractKnowledgeRefs(
        dependencies: ContextDependency[],
    ): Array<{ itemId: string; version?: string }> {
        const refs: Array<{ itemId: string; version?: string }> = [];

        for (const dependency of dependencies) {
            if (dependency.type !== 'knowledge') {
                continue;
            }

            const metadata =
                (dependency.metadata as Record<string, unknown> | undefined) ??
                {};
            const repositoryId = metadata.repositoryId as string | undefined;
            const repositoryName = metadata.repositoryName as
                | string
                | undefined;
            const filePath =
                (metadata.filePath as string | undefined) ??
                (typeof dependency.id === 'string' ? dependency.id : 'unknown');

            const baseId =
                typeof dependency.id === 'string' && dependency.id.includes('|')
                    ? dependency.id
                    : `${repositoryId ?? repositoryName ?? 'unknown'}|${filePath}`;

            const version =
                (metadata.version as string | undefined) ??
                (metadata.lastContentHash as string | undefined);

            refs.push({ itemId: baseId, version });
        }

        return refs;
    }

    private hasLikelyExternalReferences(text: string): boolean {
        const patterns = [
            /@file[:\s]/i,
            /\[\[file:/i,
            /@\w+\.(ts|js|py|md|yml|yaml|json|txt|go|java|cpp|c|h|rs)/i,

            /refer to.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /check.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /see.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /use.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /read.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /open.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /examine.*\.(ts|js|py|md|yml|yaml|json|txt)/i,

            /\b\w+\.\w+\.(ts|js|py|md|yml|yaml|json|txt)\b/i,
            /\b[A-Z_][A-Z0-9_]*\.(ts|js|py|md|yml|yaml|json|txt)\b/,

            /\b(readme|contributing|changelog|license|setup|config|package|tsconfig|jest\.config|vite\.config|webpack\.config|dockerfile|makefile)\b/i,

            /src\//i,
            /lib\//i,
            /test\//i,
            /docs\//i,
            /config\//i,

            /@mcp/i,
            /mcp:/i,
        ];
        return patterns.some((pattern) => pattern.test(text));
    }

    private async detectAndResolveReferences(params: {
        text: string;
        path: string[];
        sourceType: any;
        entityType: 'kodyRule' | 'codeReviewConfig';
        repositoryId?: string;
        repositoryName?: string;
        organizationAndTeamData: OrganizationAndTeamData;
        byokConfig?: BYOKConfig;
        subscriptionStatus?: string;
        fieldId?: string;
    }): Promise<{
        references: Array<{
            filePath: string;
            description?: string;
            originalText?: string;
            lineRange?: { start: number; end: number };
            repositoryName?: string;
            repositoryId?: string;
        }>;
        syncErrors: IPromptReferenceSyncError[];
    }> {
        const detection =
            await this.promptContextEngine.detectAndResolveReferences({
                requirementId:
                    params.fieldId && params.fieldId.length > 0
                        ? `field-detection:${params.fieldId}`
                        : `unified-detection-${Date.now()}`,
                promptText: params.text,
                path: params.path,
                sourceType: params.sourceType,
                repositoryId: params.repositoryId,
                repositoryName: params.repositoryName,
                organizationAndTeamData: params.organizationAndTeamData,
                context:
                    params.entityType === 'codeReviewConfig'
                        ? 'instruction'
                        : 'rule',
                detectionMode:
                    params.entityType === 'kodyRule' ? 'rule' : 'prompt',
                byokConfig: params.byokConfig,
                subscriptionStatus: params.subscriptionStatus,
            });

        const allDependencies: ContextDependency[] =
            detection.requirements && detection.requirements.length > 0
                ? [...(detection.requirements[0].dependencies || [])]
                : [];

        const references = allDependencies.map((dep) => {
            if (dep.type === 'mcp') {
                return {
                    filePath: dep.id,
                    description: dep.metadata?.description as string,
                    originalText: dep.metadata?.originalText as string,
                    repositoryName: undefined,
                    repositoryId: undefined,
                    lineRange: undefined,
                    lastValidatedAt: undefined,
                    lastContentHash: undefined,
                    estimatedTokens: undefined,
                };
            }

            const resolvedRepositoryName =
                (dep.metadata?.repositoryName as string | undefined) ??
                params.repositoryName;
            const resolvedRepositoryId =
                (dep.metadata?.repositoryId as string | undefined) ??
                params.repositoryId;

            return {
                filePath: (dep.metadata?.filePath as string) || dep.id,
                description: dep.metadata?.description as string,
                originalText: dep.metadata?.originalText as string,
                repositoryName: resolvedRepositoryName,
                repositoryId: resolvedRepositoryId,
                lineRange: dep.metadata?.lineRange as
                    | { start: number; end: number }
                    | undefined,
                lastValidatedAt: dep.metadata?.lastValidatedAt as
                    | string
                    | Date
                    | undefined,
                lastContentHash: dep.metadata?.lastContentHash as
                    | string
                    | undefined,
                estimatedTokens: dep.metadata?.estimatedTokens as
                    | number
                    | undefined,
            };
        });

        this.logger.log({
            message: `Detected ${references.length} references for ${params.entityType}`,
            context: ContextReferenceDetectionService.name,
            metadata: {
                entityType: params.entityType,
                entityId: params.fieldId ?? params.entityType,
                referenceCount: references.length,
                references: references.map((r) => ({
                    filePath: r.filePath,
                    hasDescription: !!r.description,
                })),
            },
        });

        return {
            references,
            syncErrors: detection.syncErrors || [],
        };
    }

    /**
     * Convert detected references into `knowledge` context dependencies (the
     * `@file` path). MCP-tool references are no longer supported in context
     * packs, so every detected reference maps to a knowledge dependency.
     */
    private buildKnowledgeDependencies(params: {
        references: Array<{
            filePath: string;
            description?: string;
            originalText?: string;
            lineRange?: { start: number; end: number };
            repositoryName?: string;
            repositoryId?: string;
            lastValidatedAt?: string | Date;
            lastContentHash?: string;
            estimatedTokens?: number;
        }>;
        syncErrors: IPromptReferenceSyncError[];
        repositoryName?: string;
        repositoryId?: string;
    }): {
        dependencies: ContextDependency[];
        syncErrors: IPromptReferenceSyncError[];
    } {
        const { references, syncErrors, repositoryName, repositoryId } = params;

        const dependencies: ContextDependency[] = references.map((ref) => {
            const knowledgeId = ref.repositoryId
                ? `${ref.repositoryId}|${ref.filePath}`
                : ref.repositoryName
                  ? `${ref.repositoryName}|${ref.filePath}`
                  : ref.filePath;

            return {
                type: 'knowledge' as const,
                id: knowledgeId,
                metadata: {
                    filePath: ref.filePath,
                    description: ref.description,
                    originalText: ref.originalText,
                    repositoryName: ref.repositoryName ?? repositoryName,
                    repositoryId: ref.repositoryId ?? repositoryId,
                    lineRange: ref.lineRange,
                    lastValidatedAt: ref.lastValidatedAt
                        ? new Date(ref.lastValidatedAt)
                        : undefined,
                    lastContentHash: ref.lastContentHash,
                    estimatedTokens: ref.estimatedTokens,
                    detectedAt: new Date(),
                },
            } satisfies ContextDependency;
        });

        return { dependencies, syncErrors };
    }

    private buildScopePath(
        scopeLevel: string,
        organizationId: string,
        teamId?: string,
        repositoryId?: string,
    ): Array<{ level: string; id: string }> {
        const path: Array<{ level: string; id: string }> = [
            { level: 'organization', id: organizationId },
        ];

        if (teamId) {
            path.push({ level: 'team', id: teamId });
        }

        if (scopeLevel === 'repository' && repositoryId) {
            path.push({ level: 'repository', id: repositoryId });
        }

        return path;
    }

    private async saveToContextOS(params: {
        entityType: 'kodyRule' | 'codeReviewConfig';
        entityId: string;
        entityHash: string;
        requirements: ContextRequirement[];
        knowledgeRefs: Array<{ itemId: string; version?: string }>;
        aggregatedSyncErrors: IPromptReferenceSyncError[];
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId?: string;
        repositoryName?: string;
    }): Promise<string> {
        const {
            entityType,
            entityId,
            entityHash,
            requirements,
            knowledgeRefs,
            aggregatedSyncErrors,
            organizationAndTeamData,
            repositoryId,
            repositoryName,
        } = params;

        const isGlobalScope = !repositoryId || repositoryId === 'global';
        const scopeLevel = isGlobalScope ? 'organization' : 'repository';
        const scopePath = this.buildScopePath(
            scopeLevel,
            organizationAndTeamData.organizationId,
            organizationAndTeamData.teamId,
            isGlobalScope ? undefined : repositoryId,
        );

        const scope = {
            level: scopeLevel,
            identifiers: {
                tenantId: organizationAndTeamData.organizationId,
                organizationId: organizationAndTeamData.organizationId,
                ...(organizationAndTeamData.teamId && {
                    teamId: organizationAndTeamData.teamId,
                }),
                ...(!isGlobalScope && { repositoryId }),
            },
            path: scopePath,
            metadata: { source: entityType },
        };

        const previousReference =
            await this.contextReferenceService.getLatestRevision(
                entityType,
                entityId,
            );

        const revisionId = `rev:${entityType}:${entityId}:${Date.now()}`;
        const result = await this.contextReferenceService.commitRevision({
            scope,
            entityType,
            entityId,
            requirements,
            origin: { kind: 'system', id: 'kody-system' },
            revisionId,
            parentReferenceId: previousReference?.uuid,
            knowledgeRefs: knowledgeRefs.length ? knowledgeRefs : undefined,
            metadata: {
                source: entityType,
                repositoryId: repositoryId ?? 'global',
                repositoryName,
                entityHash,
                requirementsCount: requirements.length,
                syncErrorsCount: aggregatedSyncErrors.length,
                syncErrors:
                    aggregatedSyncErrors.length > 0
                        ? aggregatedSyncErrors
                        : undefined,
            },
        });

        this.logger.log({
            message: `Successfully saved unified references to Context OS`,
            context: ContextReferenceDetectionService.name,
            metadata: {
                entityType,
                entityId,
                contextReferenceId: result.pointer.uuid,
                requirementsCount: requirements.length,
                knowledgeRefsCount: knowledgeRefs.length,
            },
        });

        return result.pointer.uuid;
    }
}
