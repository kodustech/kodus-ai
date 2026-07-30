import { createHash } from 'crypto';

import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { produce } from 'immer';
import { v4 } from 'uuid';

import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import {
    IPullRequestMessagesService,
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import {
    IFile,
    IPullRequests,
    ISuggestion,
    ISuggestionByPR,
} from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import {
    CodeReviewConfig,
    CodeReviewConfigWithoutLLMProvider,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import {
    DRY_RUN_REPOSITORY_TOKEN,
    IDryRunRepository,
} from '@libs/dryRun/domain/contracts/dryRun.repository.contract';
import { IDryRunService } from '@libs/dryRun/domain/contracts/dryRun.service.contract';
import { DryRunEntity } from '@libs/dryRun/domain/entities/dryRun.entity';
import {
    DryRunEventType,
    DryRunStatus,
    IDryRun,
    IDryRunEvent,
    IDryRunPayloadMap,
} from '@libs/dryRun/domain/interfaces/dryRun.interface';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { deepSort } from '@libs/common/utils/deep';
import { createLogger } from '@libs/core/log/logger';

@Injectable()
export class DryRunService implements IDryRunService {
    private readonly logger = createLogger(DryRunService.name);

    constructor(
        @Inject(DRY_RUN_REPOSITORY_TOKEN)
        private readonly dryRunRepository: IDryRunRepository,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,

        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,

        private readonly eventEmitter: EventEmitter2,
    ) {}

    create(
        dryRun: Omit<IDryRun, 'uuid' | 'createdAt' | 'updatedAt'>,
    ): Promise<DryRunEntity> {
        try {
            return this.dryRunRepository.create(dryRun);
        } catch (error) {
            this.logger.error({
                message: 'Error creating DryRun',
                error,
                context: DryRunService.name,
                metadata: { dryRun },
            });

            throw error;
        }
    }
    update(uuid: string, dryRun: Partial<IDryRun>): Promise<DryRunEntity> {
        try {
            return this.dryRunRepository.update(uuid, dryRun);
        } catch (error) {
            this.logger.error({
                message: 'Error updating DryRun',
                error,
                context: DryRunService.name,
                metadata: { uuid, dryRun },
            });

            throw error;
        }
    }
    findById(uuid: string): Promise<DryRunEntity | null> {
        try {
            return this.dryRunRepository.findOne({ uuid });
        } catch (error) {
            this.logger.error({
                message: 'Error finding DryRun by ID',
                error,
                context: DryRunService.name,
                metadata: { uuid },
            });

            throw error;
        }
    }
    findOne(filter: Partial<IDryRun>): Promise<DryRunEntity | null> {
        try {
            return this.dryRunRepository.findOne(filter);
        } catch (error) {
            this.logger.error({
                message: 'Error finding DryRun',
                error,
                context: DryRunService.name,
                metadata: { filter },
            });

            throw error;
        }
    }
    find(filter: Partial<IDryRun>): Promise<DryRunEntity[]> {
        try {
            return this.dryRunRepository.find(filter);
        } catch (error) {
            this.logger.error({
                message: 'Error finding DryRuns',
                error,
                context: DryRunService.name,
                metadata: { filter },
            });

            throw error;
        }
    }
    delete(uuid: string): Promise<void> {
        try {
            return this.dryRunRepository.delete(uuid);
        } catch (error) {
            this.logger.error({
                message: 'Error deleting DryRun',
                error,
                context: DryRunService.name,
                metadata: { uuid },
            });

            throw error;
        }
    }

    async listDryRuns(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: {
            repositoryId?: string;
            directoryId?: string;
            startDate?: Date;
            endDate?: Date;
            prNumber?: number;
            status?: string;
        };
    }): Promise<IDryRun['runs']> {
        const { organizationAndTeamData, filters = {} } = params;
        try {
            const existing = await this.dryRunRepository.findOne({
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            });

            if (!existing) {
                return [];
            }

            const filteredRuns = [];

            for (const run of existing.runs) {
                if (
                    filters.repositoryId &&
                    run.repositoryId !== filters.repositoryId
                ) {
                    continue;
                }
                if (
                    filters.directoryId &&
                    run.directoryId !== filters.directoryId
                ) {
                    continue;
                }
                if (filters.prNumber && run.prNumber !== filters.prNumber) {
                    continue;
                }
                if (filters.startDate && run.createdAt < filters.startDate) {
                    continue;
                }
                if (filters.endDate && run.createdAt > filters.endDate) {
                    continue;
                }
                if (filters.status && run.status !== filters.status) {
                    continue;
                }
                filteredRuns.push(run);
            }

            return filteredRuns;
        } catch (error) {
            this.logger.error({
                message: 'Error listing DryRuns',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData, filters },
            });
            throw error;
        }
    }

    async findDryRunById(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        id: string;
    }): Promise<IDryRun['runs'][number] | null> {
        const { organizationAndTeamData, id } = params;

        try {
            const { existing, runIndex } = await this.findRun(
                organizationAndTeamData,
                id,
            );

            if (!existing || runIndex === -1) {
                return null;
            }

            return existing.runs[runIndex];
        } catch (error) {
            this.logger.error({
                message: 'Error finding DryRun by ID',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData, id },
            });

            throw error;
        }
    }

    async initializeDryRun(params: {
        id?: string;
        status?: DryRunStatus;
        organizationAndTeamData: OrganizationAndTeamData;
        provider: IPullRequests['provider'];
        prNumber: number;
        prTitle: string;
        repositoryId: string;
        repositoryName: string;
        directoryId?: string;
    }): Promise<IDryRun['runs'][number]> {
        const {
            id = v4(),
            status = DryRunStatus.IN_PROGRESS,
            organizationAndTeamData,
            provider,
            prNumber,
            prTitle,
            repositoryId,
            repositoryName,
            directoryId,
        } = params;

        try {
            const now = new Date();

            const newDryRun: IDryRun['runs'][number] = {
                id,
                prNumber,
                provider,
                prTitle,
                repositoryId,
                repositoryName,
                directoryId,
                status,
                files: [],
                prLevelSuggestions: [],
                createdAt: now,
                updatedAt: now,
                dependents: [],
                configHashes: {
                    basic: null,
                    full: null,
                    llm: null,
                },
                messages: [],
                config: null,
                pullRequestMessages: null,
                description: null,
                events: [],
            };

            const existing = await this.dryRunRepository.findOne({
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            });

            if (!existing) {
                await this.dryRunRepository.create({
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    runs: [newDryRun],
                });
                return newDryRun;
            }

            const nextState = produce(existing.toObject(), (draft) => {
                draft.runs.push(newDryRun);
            });

            await this.dryRunRepository.update(existing.uuid, {
                runs: nextState.runs,
            });

            return newDryRun;
        } catch (error) {
            this.logger.error({
                message: 'Error initializing DryRun',
                context: DryRunService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    id,
                    provider,
                    prNumber,
                    repositoryId,
                },
            });

            throw error;
        }
    }

    async addConfigsToDryRun(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        id: string;
        config: CodeReviewConfig;
        configId: string;
        pullRequestMessagesConfig?: IPullRequestMessages;
        pullRequestMessagesId?: string;
    }): Promise<IDryRun['runs'][number] | null> {
        const {
            organizationAndTeamData,
            id,
            config,
            configId,
            pullRequestMessagesConfig,
            pullRequestMessagesId,
        } = params;

        try {
            const { existing, runIndex } = await this.findRun(
                organizationAndTeamData,
                id,
            );

            if (!existing || runIndex === -1) {
                return null;
            }

            const configHashes = this.generateHashes(
                existing.runs[runIndex],
                config,
                pullRequestMessagesConfig,
            );

            const nextState = produce(existing.toObject(), (draft) => {
                draft.runs[runIndex].configHashes = configHashes;
                draft.runs[runIndex].config = configId;
                draft.runs[runIndex].pullRequestMessages =
                    pullRequestMessagesId;
                draft.runs[runIndex].directoryId = config.directoryId;
                draft.runs[runIndex].updatedAt = new Date();
            });

            const updatedDryRun = await this.dryRunRepository.update(
                existing.uuid,
                { runs: nextState.runs },
            );

            return updatedDryRun.runs[runIndex];
        } catch (error) {
            this.logger.error({
                message: 'Error adding configs to DryRun',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData, id, config },
            });

            throw error;
        }
    }

    async addMessageToDryRun(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        id: string;
        content: string;
        path?: string;
        lines?: {
            start: number;
            end: number;
        };
        severity?: string;
        category?: string;
        language?: string;
        existingCode?: string;
        improvedCode?: string;
    }): Promise<IDryRun['runs'][number] | null> {
        const { organizationAndTeamData, id, ...content } = params;

        try {
            const { existing, runIndex } = await this.findRun(
                organizationAndTeamData,
                id,
            );

            if (!existing || runIndex === -1) {
                return null;
            }

            const now = new Date();

            const event = this.createEvent(
                id,
                organizationAndTeamData,
                DryRunEventType.MESSAGE_ADDED,
                {
                    message: {
                        id: existing.runs[runIndex].messages?.length || 0,
                        ...content,
                    },
                },
            );

            const nextState = produce(existing.toObject(), (draft) => {
                const length = draft.runs[runIndex].messages?.length || 0;
                draft.runs[runIndex].messages.push({ id: length, ...content });

                draft.runs[runIndex].events.push(event);

                draft.runs[runIndex].updatedAt = now;
            });

            const updatedDryRun = await this.dryRunRepository.update(
                existing.uuid,
                { runs: nextState.runs },
            );

            this.emitEvent(event);

            return updatedDryRun.runs[runIndex];
        } catch (error) {
            this.logger.error({
                message: 'Error adding message to DryRun',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData, hash: id, content },
            });

            throw error;
        }
    }

    async updateMessageInDryRun(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        id: string;
        commentId: number;
        content: string;
    }): Promise<IDryRun['runs'][number] | null> {
        const { organizationAndTeamData, id, commentId, content } = params;

        try {
            const { existing, runIndex } = await this.findRun(
                organizationAndTeamData,
                id,
            );

            if (!existing || runIndex === -1) {
                return null;
            }

            const messageIndex = existing.runs[runIndex].messages.findIndex(
                (msg) => msg.id === commentId,
            );

            if (messageIndex === -1) {
                this.logger.warn({
                    message:
                        'No message found in DryRun run with the specified commentId',
                    context: DryRunService.name,
                    metadata: { organizationAndTeamData, hash: id, commentId },
                });
                return null;
            }

            const now = new Date();

            const event = this.createEvent(
                id,
                organizationAndTeamData,
                DryRunEventType.MESSAGE_UPDATED,
                {
                    messageId: commentId,
                    content,
                },
            );

            const nextState = produce(existing.toObject(), (draft) => {
                draft.runs[runIndex].messages[messageIndex].content = content;
                draft.runs[runIndex].events.push(event);
                draft.runs[runIndex].updatedAt = now;
            });

            const updatedDryRun = await this.dryRunRepository.update(
                existing.uuid,
                { runs: nextState.runs },
            );

            this.emitEvent(event);

            return updatedDryRun.runs[runIndex];
        } catch (error) {
            this.logger.error({
                message: 'Error updating message in DryRun',
                error,
                context: DryRunService.name,
                metadata: {
                    organizationAndTeamData,
                    hash: id,
                    commentId,
                    body: content,
                },
            });

            throw error;
        }
    }

    async updateDescriptionInDryRun(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        id: string;
        description: string;
    }): Promise<IDryRun['runs'][number] | null> {
        const { organizationAndTeamData, id, description } = params;

        try {
            const { existing, runIndex } = await this.findRun(
                organizationAndTeamData,
                id,
            );

            if (!existing || runIndex === -1) {
                return null;
            }

            const now = new Date();

            const event = this.createEvent(
                id,
                organizationAndTeamData,
                DryRunEventType.DESCRIPTION_UPDATED,
                {
                    description,
                },
            );

            const nextState = produce(existing.toObject(), (draft) => {
                draft.runs[runIndex].description = description;
                draft.runs[runIndex].events.push(event);
                draft.runs[runIndex].updatedAt = now;
            });

            const updateDryRun = await this.dryRunRepository.update(
                existing.uuid,
                { runs: nextState.runs },
            );

            this.emitEvent(event);

            return updateDryRun.runs[runIndex];
        } catch (error) {
            this.logger.error({
                message: 'Error updating description in DryRun',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData, hash: id, description },
            });

            throw error;
        }
    }

    async updateDryRunStatus(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        id: string;
        status: DryRunStatus;
    }): Promise<IDryRun['runs'][number] | null> {
        const { organizationAndTeamData, id, status } = params;

        try {
            const { existing, runIndex } = await this.findRun(
                organizationAndTeamData,
                id,
            );

            if (!existing || runIndex === -1) {
                return null;
            }

            const now = new Date();

            const event = this.createEvent(
                id,
                organizationAndTeamData,
                DryRunEventType.STATUS_UPDATED,
                {
                    status,
                },
            );

            const nextState = produce(existing.toObject(), (draft) => {
                draft.runs[runIndex].status = status;
                draft.runs[runIndex].events.push(event);
                draft.runs[runIndex].updatedAt = now;
            });

            const updatedDryRun = await this.dryRunRepository.update(
                existing.uuid,
                { runs: nextState.runs },
            );

            this.emitEvent(event);

            return updatedDryRun.runs[runIndex];
        } catch (error) {
            this.logger.error({
                message: 'Error updating DryRun status',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData, hash: id, status },
            });

            throw error;
        }
    }

    async addPrLevelSuggestions(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        id: string;
        prLevelSuggestions: ISuggestionByPR[];
    }): Promise<IDryRun['runs'][number] | null> {
        const { organizationAndTeamData, id, prLevelSuggestions } = params;

        try {
            const { existing, runIndex } = await this.findRun(
                organizationAndTeamData,
                id,
            );

            if (!existing || runIndex === -1) {
                return null;
            }

            const now = new Date();

            const nextState = produce(existing.toObject(), (draft) => {
                draft.runs[runIndex].prLevelSuggestions = prLevelSuggestions;
                draft.runs[runIndex].updatedAt = now;
            });

            const updatedDryRun = await this.dryRunRepository.update(
                existing.uuid,
                { runs: nextState.runs },
            );

            return updatedDryRun.runs[runIndex];
        } catch (error) {
            this.logger.error({
                message: 'Error adding PR level suggestions to DryRun',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData, id, prLevelSuggestions },
            });

            throw error;
        }
    }

    async addFilesToDryRun(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        id: string;
        files: FileChange[];
        prioritizedSuggestions?: ISuggestion[];
        unusedSuggestions?: ISuggestion[];
    }): Promise<IDryRun['runs'][number] | null> {
        const {
            organizationAndTeamData,
            id,
            files,
            prioritizedSuggestions = [],
            unusedSuggestions = [],
        } = params;

        try {
            const { existing, runIndex } = await this.findRun(
                organizationAndTeamData,
                id,
            );

            if (!existing || runIndex === -1) {
                return null;
            }

            const now = new Date();

            const transformedFiles = this._transformFiles(
                files,
                prioritizedSuggestions,
                unusedSuggestions,
            );

            const nextState = produce(existing.toObject(), (draft) => {
                draft.runs[runIndex].files = transformedFiles;
                draft.runs[runIndex].updatedAt = now;
            });

            const updatedDryRun = await this.dryRunRepository.update(
                existing.uuid,
                { runs: nextState.runs },
            );

            return updatedDryRun.runs[runIndex];
        } catch (error) {
            this.logger.error({
                message: 'Error adding files to DryRun',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData, id, files },
            });

            throw error;
        }
    }

    private _transformFiles(
        files: FileChange[],
        prioritizedSuggestions: Array<ISuggestion>,
        unusedSuggestions: Array<ISuggestion>,
    ): IFile[] {
        const getSuggestionsForFile = (
            filePath: string,
            prioritizedSuggestions: Array<ISuggestion>,
            unusedSuggestions: Array<ISuggestion>,
        ): Array<ISuggestion> => {
            if (
                prioritizedSuggestions.length <= 0 &&
                unusedSuggestions.length <= 0
            ) {
                return [];
            }

            const allSuggestions = [
                ...prioritizedSuggestions,
                ...unusedSuggestions,
            ];

            const filteredSuggestions = allSuggestions
                .filter((suggestion) => {
                    const matches = suggestion.relevantFile === filePath;
                    return matches;
                })
                .map((suggestion) => ({
                    ...suggestion,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }));

            return filteredSuggestions;
        };

        try {
            return files.map((file) => ({
                id: v4(),
                sha: file.sha,
                path: file.filename,
                filename: file.filename.split('/').pop() || '',
                previousName: file.previous_filename || '',
                status: file.status,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                suggestions: getSuggestionsForFile(
                    file.filename,
                    prioritizedSuggestions,
                    unusedSuggestions,
                ),
                added: file.additions ?? 0,
                deleted: file.deletions ?? 0,
                changes: file.changes ?? 0,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error transforming files for DryRun',
                error,
                context: DryRunService.name,
                metadata: { files, prioritizedSuggestions, unusedSuggestions },
            });

            throw error;
        }
    }

    async removeDryRunByHash(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        id: string;
    }): Promise<IDryRun | null> {
        const { organizationAndTeamData, id } = params;

        try {
            const { existing, runIndex: runIndexToRemove } = await this.findRun(
                organizationAndTeamData,
                id,
            );

            if (!existing || runIndexToRemove === -1) {
                return null;
            }

            const now = new Date();

            const nextState = produce(existing.toObject(), (draft) => {
                const runToRemove = draft.runs[runIndexToRemove];

                // 1. Update parent (if it exists)
                this._updateParentOnRemove(draft, runToRemove, now);

                // 2. Promote dependents (if they exist)
                this._promoteDependentsOnRemove(draft, runToRemove, now);

                // 3. Remove the run itself
                draft.runs.splice(runIndexToRemove, 1);
            });

            const updatedDryRun = await this.dryRunRepository.update(
                existing.uuid,
                { runs: nextState.runs },
            );

            this.createAndEmitEvent(
                id,
                organizationAndTeamData,
                DryRunEventType.REMOVED,
            );

            return updatedDryRun.toObject();
        } catch (error) {
            this.logger.error({
                message: 'Error removing DryRun by hash',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData, hash: id },
            });

            throw error;
        }
    }

    /**
     * Finds the parent of a run-to-be-removed and removes the run from its
     * dependents list.
     */
    private _updateParentOnRemove(
        draft: IDryRun,
        runToRemove: IDryRun['runs'][number],
        now: Date,
    ) {
        if (typeof runToRemove.files !== 'string') {
            return; // This run has no parent
        }

        const parentId = runToRemove.files;
        const parentRun = draft.runs.find((run) => run.id === parentId);

        if (parentRun) {
            parentRun.dependents = parentRun.dependents.filter(
                (depId) => depId !== runToRemove.id,
            );
            parentRun.updatedAt = now;
        }
    }

    /**
     * Promotes the first dependent of a run-to-be-removed to take its place,
     * re-linking other dependents to the new promoted run.
     */
    private _promoteDependentsOnRemove(
        draft: IDryRun,
        runToRemove: IDryRun['runs'][number],
        now: Date,
    ) {
        if (runToRemove.dependents.length === 0) {
            return; // No dependents to promote
        }

        const promotedId = runToRemove.dependents[0];
        const otherDependentHashes = runToRemove.dependents.slice(1);
        const promotedRun = draft.runs.find((run) => run.id === promotedId);

        if (!promotedRun) {
            throw new Error(
                'Inconsistent state: Promoted run not found in runs',
            );
        }

        // 1. Promote the first dependent
        promotedRun.files = runToRemove.files; // Takes parent's files
        promotedRun.prLevelSuggestions = runToRemove.prLevelSuggestions;
        promotedRun.dependents.push(...otherDependentHashes); // Adopts siblings
        promotedRun.updatedAt = now;

        // 2. Re-link all other dependents to the promoted run
        otherDependentHashes.forEach((depId) => {
            const otherDependentRun = draft.runs.find(
                (run) => run.id === depId,
            );

            if (otherDependentRun) {
                otherDependentRun.files = promotedId;
                otherDependentRun.prLevelSuggestions = promotedId;
                otherDependentRun.updatedAt = now;
            }
        });
    }

    async clearDryRuns(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        const { organizationAndTeamData } = params;

        try {
            const existing = await this.dryRunRepository.findOne({
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            });

            if (!existing) {
                return;
            }

            await this.dryRunRepository.update(existing.uuid, { runs: [] });
        } catch (error) {
            this.logger.error({
                message: 'Error clearing DryRuns',
                error,
                context: DryRunService.name,
                metadata: { organizationAndTeamData },
            });

            throw error;
        }
    }

    private generateHashes(
        data: Pick<
            IDryRun['runs'][number],
            'prNumber' | 'repositoryId' | 'directoryId' | 'provider'
        >,
        config: CodeReviewConfigWithoutLLMProvider,
        pullRequestMessages?: IPullRequestMessages,
    ): IDryRun['runs'][number]['configHashes'] {
        const fullHash = this.generateHash({
            config,
            pullRequestMessages,
            prNumber: data.prNumber,
            repositoryId: data.repositoryId,
            directoryId: data.directoryId,
            provider: data.provider,
        });

        const { v2PromptOverrides, summary, ...restConfig } = config;

        const {
            startReviewMessage,
            endReviewMessage,
            ...restPullRequestMessages
        } = pullRequestMessages || {};

        const { content: contentStart, ...restStartReviewMessage } =
            startReviewMessage || {};
        const { content: contentEnd, ...restEndReviewMessage } =
            endReviewMessage || {};

        const { customInstructions, ...restSummary } = summary;

        const basicConfig = {
            restConfig,
            restPullRequestMessages,
            restStartReviewMessage,
            restEndReviewMessage,
            restSummary,
        };

        const llmConfig = {
            contentStart,
            contentEnd,
            v2PromptOverrides,
            customInstructions,
        };

        const basicHash = this.generateHash(basicConfig);
        const llmHash = this.generateHash(llmConfig);

        return {
            full: fullHash,
            basic: basicHash,
            llm: llmHash,
        };
    }

    private generateHash(config: any): string {
        const sorted = deepSort(config);

        const stringConfig = JSON.stringify(sorted);

        const hash = createHash('sha256').update(stringConfig).digest('hex');

        return hash;
    }

    private async findRun(
        organizationAndTeamData: OrganizationAndTeamData,
        id: string,
    ) {
        const existing = await this.dryRunRepository.findOne({
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
        });

        if (!existing) {
            this.logger.warn({
                message: 'No DryRun found for organization and team',
                context: DryRunService.name,
                metadata: { organizationAndTeamData, id },
            });
            return { existing: null, runIndex: -1, run: null };
        }

        const runIndex = existing.runs.findIndex((run) => run.id === id);

        if (runIndex === -1) {
            this.logger.warn({
                message: 'No DryRun run found with the specified id',
                context: DryRunService.name,
                metadata: { organizationAndTeamData, id },
            });
            return { existing, runIndex: -1, run: null };
        }

        return { existing, runIndex, run: existing.runs[runIndex] };
    }

    private createEvent<T extends DryRunEventType>(
        id: string,
        organizationAndTeamData: OrganizationAndTeamData,
        eventType: T,
        payload?: IDryRunPayloadMap[T],
    ) {
        return {
            id: v4(),
            dryRunId: id,
            type: eventType,
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
            payload,
            timestamp: new Date(),
        } as IDryRunEvent;
    }

    private emitEvent(event: IDryRunEvent) {
        this.eventEmitter.emit(`dryRun.${event.dryRunId}.${event.type}`, event);
    }

    private createAndEmitEvent<T extends DryRunEventType>(
        id: string,
        organizationAndTeamData: OrganizationAndTeamData,
        eventType: T,
        payload?: IDryRunPayloadMap[T],
    ) {
        const event = this.createEvent(
            id,
            organizationAndTeamData,
            eventType,
            payload,
        );

        this.emitEvent(event);
    }
}
