import { randomUUID } from 'crypto';

import type { ContextRequirement, ContextDependency } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { computeRequirementsHash } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { CONTEXT_REFERENCE_SERVICE_TOKEN } from '@libs/ai-engine/domain/contextReference/contracts/context-reference.service.contract';
import { ContextReferenceEntity } from '@libs/ai-engine/domain/contextReference/entities/context-reference.entity';
import {
    IPromptExternalReferenceManagerService,
    PromptReferenceLookupOptions,
} from '@libs/ai-engine/domain/prompt/contracts/promptExternalReferenceManager.contract';
import { PromptExternalReferenceEntity } from '@libs/ai-engine/domain/prompt/entities/promptExternalReference.entity';
import {
    IFileReference,
    IPromptReferenceSyncError,
    PromptProcessingStatus,
    PromptReferenceErrorType,
    PromptSourceType,
} from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { ContextReferenceService } from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { resolveSourceTypeFromPath } from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context.utils';

type ParsedConfigKey = {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
    repositoryName: string;
    directoryId?: string;
    configKey: string;
    entityId: string;
};

type NormalizedSyncError = {
    type: PromptReferenceErrorType;
    message: string;
    details: {
        fileName?: string;
        repositoryName?: string;
        attemptedPaths?: string[];
        timestamp?: string;
    };
};

@Injectable()
export class PromptExternalReferenceManagerService implements IPromptExternalReferenceManagerService {
    private readonly logger = createLogger(
        PromptExternalReferenceManagerService.name,
    );
    constructor(
        @Inject(CONTEXT_REFERENCE_SERVICE_TOKEN)
        private readonly contextReferenceService: ContextReferenceService,
    ) {}

    buildConfigKey(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
        directoryId?: string,
    ): string {
        return this.composeEntityId({
            organizationAndTeamData,
            repositoryId: this.normalizeRepositoryId(repositoryId),
            directoryId,
        });
    }

    buildConfigKeysHierarchy(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
        directoryId?: string,
    ): string[] {
        const normalizedRepositoryId = this.normalizeRepositoryId(repositoryId);
        const keys = new Map<string, true>();

        const registerKey = (key?: string) => {
            if (key) {
                keys.set(key, true);
            }
        };

        if (directoryId) {
            registerKey(
                this.composeEntityId({
                    organizationAndTeamData,
                    repositoryId: normalizedRepositoryId,
                    directoryId,
                }),
            );
            registerKey(
                this.composeLegacyKey(
                    organizationAndTeamData.organizationId,
                    normalizedRepositoryId ?? 'global',
                    directoryId,
                ),
            );
        }

        if (normalizedRepositoryId) {
            registerKey(
                this.composeEntityId({
                    organizationAndTeamData,
                    repositoryId: normalizedRepositoryId,
                }),
            );
            registerKey(
                this.composeLegacyKey(
                    organizationAndTeamData.organizationId,
                    normalizedRepositoryId,
                ),
            );
        }

        registerKey(
            this.composeEntityId({
                organizationAndTeamData,
            }),
        );
        registerKey(
            this.composeLegacyKey(
                organizationAndTeamData.organizationId,
                'global',
            ),
        );

        return Array.from(keys.keys());
    }

    async findByConfigKeys(
        configKeys: string[],
        options?: PromptReferenceLookupOptions,
    ): Promise<PromptExternalReferenceEntity[]> {
        if (!configKeys?.length) {
            return [];
        }

        if (options?.contextReferenceId) {
            const revision = await this.fetchRevisionByContextReferenceId(
                options.contextReferenceId,
            );

            if (revision) {
                const targetConfigKey =
                    this.selectConfigKeyForRevision(configKeys, revision) ??
                    configKeys[0];
                const parsed = this.parseConfigKey(targetConfigKey);
                return this.mapRevisionToReferences(revision, parsed);
            }

            this.logger.warn({
                message:
                    'Context reference pointer provided but revision was not found',
                context: PromptExternalReferenceManagerService.name,
                metadata: {
                    contextReferenceId: options.contextReferenceId,
                    configKeys,
                },
            });
        }

        const aggregated: PromptExternalReferenceEntity[] = [];

        const visited = new Set<string>();

        for (const configKey of configKeys) {
            const candidates = this.expandConfigKeyCandidates(configKey);

            for (const candidate of candidates) {
                if (visited.has(candidate)) {
                    continue;
                }
                visited.add(candidate);

                const revision = await this.fetchLatestRevision(candidate);
                if (!revision) {
                    continue;
                }

                const parsed = this.parseConfigKey(candidate);
                const entities = this.mapRevisionToReferences(revision, parsed);

                aggregated.push(...entities);
            }
        }

        return aggregated;
    }

    async findByConfigKey(
        configKey: string,
        sourceType: PromptSourceType,
        options?: PromptReferenceLookupOptions,
    ): Promise<PromptExternalReferenceEntity | null> {
        const references = await this.findByConfigKeys([configKey], options);
        return (
            references.find((entity) => entity.sourceType === sourceType) ??
            null
        );
    }

    async getReference(
        configKey: string,
        sourceType: PromptSourceType,
        options?: PromptReferenceLookupOptions,
    ): Promise<PromptExternalReferenceEntity | null> {
        return await this.findByConfigKey(configKey, sourceType, options);
    }

    async getMultipleReferences(
        configKey: string,
        sourceTypes: PromptSourceType[],
        options?: PromptReferenceLookupOptions,
    ): Promise<Map<PromptSourceType, PromptExternalReferenceEntity>> {
        const result = new Map<
            PromptSourceType,
            PromptExternalReferenceEntity
        >();

        if (!sourceTypes.length) {
            return result;
        }

        const references = await this.findByConfigKeys([configKey], options);

        for (const sourceType of sourceTypes) {
            const match = references.find(
                (entity) => entity.sourceType === sourceType,
            );
            if (match) {
                result.set(sourceType, match);
            }
        }

        return result;
    }

    private parseConfigKey(configKey: string): ParsedConfigKey {
        if (configKey.includes('/')) {
            return this.parseEntityIdFormat(configKey);
        }

        return this.parseLegacyFormat(configKey);
    }

    private parseEntityIdFormat(configKey: string): ParsedConfigKey {
        const segments = configKey.split('/');
        let organizationId = '';
        let teamId: string | undefined;
        let repositoryId: string | undefined;
        let directoryId: string | undefined;

        for (const segment of segments) {
            if (segment.startsWith('org:')) {
                organizationId = segment.slice(4);
            } else if (segment.startsWith('team:')) {
                teamId = segment.slice(5);
            } else if (segment.startsWith('repo:')) {
                repositoryId = segment.slice(5);
            } else if (segment.startsWith('dir:')) {
                directoryId = segment.slice(4);
            }
        }

        const normalizedRepositoryId =
            repositoryId && repositoryId.length > 0 ? repositoryId : undefined;

        return {
            organizationAndTeamData: {
                organizationId,
                teamId,
            },
            repositoryId: normalizedRepositoryId ?? 'global',
            repositoryName: normalizedRepositoryId ?? 'global',
            directoryId,
            configKey,
            entityId: configKey,
        };
    }

    private parseLegacyFormat(configKey: string): ParsedConfigKey {
        const parts = configKey.split(':');
        const organizationId = parts[0] ?? '';
        let repositoryId = parts[1] ?? 'global';
        const directoryId = parts.length > 2 ? parts[2] : undefined;

        if (repositoryId === 'global') {
            repositoryId = undefined;
        }

        const entityId = this.composeEntityId({
            organizationAndTeamData: {
                organizationId,
            },
            repositoryId,
            directoryId,
        });

        return {
            organizationAndTeamData: {
                organizationId,
            },
            repositoryId: repositoryId ?? 'global',
            repositoryName: repositoryId ?? 'global',
            directoryId,
            configKey,
            entityId,
        };
    }

    private expandConfigKeyCandidates(configKey: string): string[] {
        const parsed = this.parseConfigKey(configKey);
        const normalizedRepositoryId = this.normalizeRepositoryId(
            parsed.repositoryId,
        );

        const candidates = new Map<string, true>();

        const register = (value?: string) => {
            if (value) {
                candidates.set(value, true);
            }
        };

        register(parsed.entityId);

        if (parsed.organizationAndTeamData.teamId) {
            register(
                this.composeEntityId({
                    organizationAndTeamData: parsed.organizationAndTeamData,
                    repositoryId: normalizedRepositoryId,
                    directoryId: parsed.directoryId,
                }),
            );
        }

        register(
            this.composeLegacyKey(
                parsed.organizationAndTeamData.organizationId,
                normalizedRepositoryId ?? 'global',
                parsed.directoryId,
            ),
        );

        return Array.from(candidates.keys());
    }

    private async fetchLatestRevision(
        configKey: string,
    ): Promise<ContextReferenceEntity | undefined> {
        const parsed = this.parseConfigKey(configKey);
        try {
            return await this.contextReferenceService.getLatestRevision(
                'codeReviewConfig',
                parsed.entityId,
            );
        } catch (error) {
            this.logger.warn({
                message: 'Failed to fetch context reference revision',
                context: PromptExternalReferenceManagerService.name,
                error,
                metadata: {
                    configKey,
                    entityId: parsed.entityId,
                },
            });
            return undefined;
        }
    }

    private async fetchRevisionByContextReferenceId(
        contextReferenceId: string,
    ): Promise<ContextReferenceEntity | undefined> {
        try {
            return await this.contextReferenceService.findById(
                contextReferenceId,
            );
        } catch (error) {
            this.logger.warn({
                message: 'Failed to fetch context reference by pointer id',
                context: PromptExternalReferenceManagerService.name,
                error,
                metadata: { contextReferenceId },
            });
            return undefined;
        }
    }

    private selectConfigKeyForRevision(
        configKeys: string[],
        revision: ContextReferenceEntity,
    ): string | undefined {
        const metadata =
            (revision.metadata as Record<string, unknown>) ?? undefined;

        const revisionRepositoryId =
            typeof metadata?.repositoryId === 'string'
                ? (metadata.repositoryId as string)
                : 'global';
        const revisionDirectoryId =
            typeof metadata?.directoryId === 'string'
                ? (metadata.directoryId as string)
                : undefined;

        for (const key of configKeys) {
            const parsed = this.parseConfigKey(key);
            const parsedRepositoryId = parsed.repositoryId ?? 'global';

            if (
                parsedRepositoryId === revisionRepositoryId &&
                parsed.directoryId === revisionDirectoryId
            ) {
                return key;
            }
        }

        return configKeys[0];
    }

    private mapRevisionToReferences(
        revision: ContextReferenceEntity,
        parsedKey: ParsedConfigKey,
    ): PromptExternalReferenceEntity[] {
        const requirements = revision.requirements ?? [];
        if (requirements.length === 0) {
            return [];
        }

        const requirementHash = computeRequirementsHash(requirements);
        const entities: PromptExternalReferenceEntity[] = [];

        for (const requirement of requirements) {
            const sourceType = this.resolveSourceType(requirement);
            if (!sourceType) {
                continue;
            }

            const references = this.extractReferencesFromRequirement(
                requirement,
                parsedKey.repositoryName,
            );

            const syncErrors =
                this.extractSyncErrorsFromRequirement(requirement);

            const processingStatus =
                requirement.status === 'draft' ||
                (syncErrors.length > 0 && references.length === 0)
                    ? PromptProcessingStatus.FAILED
                    : PromptProcessingStatus.COMPLETED;

            const lastProcessedAt =
                this.extractLastProcessedAt(requirement, revision) ??
                new Date();

            const promptHash =
                typeof requirement.metadata?.promptHash === 'string'
                    ? requirement.metadata?.promptHash
                    : '';

            entities.push(
                PromptExternalReferenceEntity.create({
                    uuid: `${revision.uuid}:${requirement.id}:${randomUUID()}`,
                    configKey: parsedKey.configKey,
                    sourceType,
                    organizationId:
                        parsedKey.organizationAndTeamData.organizationId,
                    repositoryId: parsedKey.repositoryId,
                    directoryId: parsedKey.directoryId,
                    repositoryName: parsedKey.repositoryName,
                    promptHash,
                    contextReferenceId: revision.uuid,
                    contextRequirementsHash: requirementHash,
                    references,
                    syncErrors,
                    processingStatus,
                    lastProcessedAt,
                    createdAt: revision.createdAt ?? undefined,
                    updatedAt: revision.updatedAt ?? undefined,
                }),
            );
        }

        return entities;
    }

    private resolveSourceType(
        requirement: ContextRequirement,
    ): PromptSourceType | undefined {
        if (requirement.metadata) {
            const rawSourceType = requirement.metadata.sourceType;
            if (
                typeof rawSourceType === 'string' &&
                this.isPromptSourceType(rawSourceType)
            ) {
                return rawSourceType;
            }
        }

        if (Array.isArray(requirement.metadata?.path)) {
            return resolveSourceTypeFromPath(
                requirement.metadata?.path as string[],
            );
        }

        return undefined;
    }

    private isPromptSourceType(value: string): value is PromptSourceType {
        return Object.values(PromptSourceType).includes(
            value as PromptSourceType,
        );
    }

    private extractReferencesFromRequirement(
        requirement: ContextRequirement,
        fallbackRepositoryName: string,
    ): IFileReference[] {
        const knowledgeDependencies =
            requirement.dependencies?.filter(
                (dependency) => dependency.type === 'knowledge',
            ) ?? [];

        const references: IFileReference[] = [];
        const seen = new Set<string>();

        for (const dependency of knowledgeDependencies) {
            const reference = this.mapDependencyToReference(
                dependency,
                fallbackRepositoryName,
            );

            if (!reference) {
                continue;
            }

            const key = `${reference.repositoryName ?? fallbackRepositoryName}:${reference.filePath}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            references.push(reference);
        }

        return references;
    }

    private mapDependencyToReference(
        dependency: ContextDependency,
        fallbackRepositoryName: string,
    ): IFileReference | undefined {
        const metadata = dependency.metadata as
            | Record<string, unknown>
            | undefined;
        const filePath =
            typeof metadata?.filePath === 'string'
                ? metadata.filePath
                : undefined;

        if (!filePath) {
            return undefined;
        }

        const repositoryName =
            typeof metadata?.repositoryName === 'string'
                ? metadata.repositoryName
                : fallbackRepositoryName;

        const lineRangeRaw = metadata?.lineRange as
            | { start?: number; end?: number }
            | undefined;

        const description =
            typeof metadata?.description === 'string'
                ? metadata.description
                : undefined;

        const originalText =
            typeof metadata?.originalText === 'string'
                ? metadata.originalText
                : undefined;

        const detectedAt =
            typeof metadata?.detectedAt === 'string'
                ? new Date(metadata.detectedAt)
                : undefined;

        const lastValidatedAt =
            typeof metadata?.lastValidatedAt === 'string'
                ? new Date(metadata.lastValidatedAt)
                : (detectedAt ?? new Date());

        const lastContentHash =
            typeof metadata?.lastContentHash === 'string'
                ? metadata.lastContentHash
                : '';

        const estimatedTokens =
            typeof metadata?.estimatedTokens === 'number'
                ? metadata.estimatedTokens
                : undefined;

        const lastFetchErrorRaw = metadata?.lastFetchError as
            | Record<string, unknown>
            | undefined;

        const lastFetchError = lastFetchErrorRaw
            ? this.mapDependencyError(lastFetchErrorRaw)
            : undefined;

        return {
            filePath,
            repositoryName,
            description,
            originalText,
            lineRange:
                lineRangeRaw?.start !== undefined &&
                lineRangeRaw?.end !== undefined
                    ? {
                          start: Number(lineRangeRaw.start),
                          end: Number(lineRangeRaw.end),
                      }
                    : undefined,
            lastContentHash,
            lastValidatedAt,
            estimatedTokens,
            lastFetchError,
        };
    }

    private mapDependencyError(
        error: Record<string, unknown>,
    ): IFileReference['lastFetchError'] | undefined {
        const type = error.type as PromptReferenceErrorType | undefined;
        if (!type) {
            return undefined;
        }

        const message = typeof error.message === 'string' ? error.message : '';
        const attemptedPatterns = Array.isArray(error.attemptedPatterns)
            ? (error.attemptedPatterns as string[])
            : [];
        const timestamp =
            typeof error.timestamp === 'string'
                ? new Date(error.timestamp)
                : new Date();

        return {
            type,
            message,
            attemptedPatterns,
            timestamp,
        };
    }

    private extractSyncErrorsFromRequirement(
        requirement: ContextRequirement,
    ): IPromptReferenceSyncError[] {
        const rawErrors = requirement.metadata?.syncErrors;
        if (!Array.isArray(rawErrors)) {
            return [];
        }

        return rawErrors
            .map((error) => this.toPromptReferenceSyncError(error))
            .filter(
                (error): error is IPromptReferenceSyncError =>
                    error !== undefined,
            );
    }

    private toPromptReferenceSyncError(
        raw: unknown,
    ): IPromptReferenceSyncError | undefined {
        if (!raw || typeof raw !== 'object') {
            return undefined;
        }

        const data = raw as NormalizedSyncError;
        if (!data.type || !data.message) {
            return undefined;
        }

        const details = data.details ?? {};

        return {
            type: data.type,
            message: data.message,
            details: {
                fileName: details.fileName,
                repositoryName: details.repositoryName,
                attemptedPaths: Array.isArray(details.attemptedPaths)
                    ? details.attemptedPaths
                    : undefined,
                timestamp: details.timestamp
                    ? new Date(details.timestamp)
                    : undefined,
            },
        };
    }

    private extractLastProcessedAt(
        requirement: ContextRequirement,
        revision: ContextReferenceEntity,
    ): Date | undefined {
        const metadata = requirement.metadata as
            | Record<string, unknown>
            | undefined;
        if (metadata?.lastProcessedAt) {
            const raw = metadata.lastProcessedAt as string;
            if (typeof raw === 'string') {
                return new Date(raw);
            }
        }

        return revision.updatedAt ?? revision.createdAt ?? new Date();
    }

    private composeEntityId(options: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId?: string;
        directoryId?: string;
    }): string {
        const segments = [
            `org:${options.organizationAndTeamData.organizationId}`,
        ];

        if (options.organizationAndTeamData.teamId) {
            segments.push(`team:${options.organizationAndTeamData.teamId}`);
        }

        if (options.repositoryId) {
            segments.push(`repo:${options.repositoryId}`);
        }

        if (options.directoryId) {
            segments.push(`dir:${options.directoryId}`);
        }

        return segments.join('/');
    }

    private composeLegacyKey(
        organizationId: string,
        repositoryId: string,
        directoryId?: string,
    ): string {
        if (directoryId) {
            return `${organizationId}:${repositoryId}:${directoryId}`;
        }

        return `${organizationId}:${repositoryId}`;
    }

    private normalizeRepositoryId(repositoryId?: string): string | undefined {
        if (!repositoryId || repositoryId === 'global') {
            return undefined;
        }
        return repositoryId;
    }

    private normalizeToolKey(value?: string | null): string | undefined {
        if (!value) {
            return undefined;
        }

        const normalized = value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');

        return normalized || undefined;
    }
}
