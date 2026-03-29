import { Injectable } from '@nestjs/common';
import {
    UnifiedLogHandler,
    BaseLogParams,
    ChangedDataToExport,
} from './unifiedLog.handler';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

function getDefaultMessages() {
    const defaults = getDefaultKodusConfigFile();
    return {
        start: defaults.customMessages?.startReviewMessage?.content ?? '',
        end: defaults.customMessages?.endReviewMessage?.content ?? '',
        globalSettings: {
            hideComments:
                defaults.customMessages?.globalSettings?.hideComments ?? false,
            suggestionCopyPrompt:
                defaults.customMessages?.globalSettings?.suggestionCopyPrompt ??
                true,
        },
    };
}

export interface PullRequestMessage {
    content: string;
    status: PullRequestMessageStatus;
}

export interface GlobalSettings {
    hideComments?: boolean;
    suggestionCopyPrompt?: boolean;
}

export interface PullRequestMessagesLogParams extends BaseLogParams {
    repositoryId?: string;
    directoryId?: string;
    startReviewMessage?: PullRequestMessage;
    endReviewMessage?: PullRequestMessage;
    existingStartMessage?: PullRequestMessage;
    existingEndMessage?: PullRequestMessage;
    globalSettings?: GlobalSettings;
    existingGlobalSettings?: GlobalSettings;
    directoryPath?: string;
    isUpdate: boolean; // true for update, false for create
}

@Injectable()
export class PullRequestMessagesLogHandler {
    constructor(private readonly unifiedLogHandler: UnifiedLogHandler) {}

    public async logPullRequestMessagesAction(
        params: PullRequestMessagesLogParams,
    ): Promise<void> {
        const changedData = this.generateChangedData(params);

        if (changedData.length === 0) {
            return;
        }

        await this.unifiedLogHandler.saveLogEntry({
            organizationAndTeamData: params.organizationAndTeamData,
            userInfo: params.userInfo,
            actionType: ActionType.EDIT,
            configLevel: params.configLevel,
            repository:
                params.repositoryId && params.repositoryId !== 'global'
                    ? { id: params.repositoryId }
                    : undefined,
            changedData,
            directory: {
                id: params.directoryId,
                path: params.directoryPath,
            },
        });
    }

    private generateChangedData(
        params: PullRequestMessagesLogParams,
    ): ChangedDataToExport[] {
        const changedData: ChangedDataToExport[] = [];
        const defaultMessages = getDefaultMessages();

        // Check start message changes
        if (params.startReviewMessage) {
            const startChange = this.analyzeMessageChange(
                'Start',
                params.startReviewMessage,
                params.existingStartMessage,
                defaultMessages.start,
                params.isUpdate,
                params.configLevel,
                params.repositoryId,
                params.directoryPath,
                params.userInfo.userEmail,
            );

            if (startChange) {
                changedData.push(startChange);
            }
        }

        // Check end message changes
        if (params.endReviewMessage) {
            const endChange = this.analyzeMessageChange(
                'End',
                params.endReviewMessage,
                params.existingEndMessage,
                defaultMessages.end,
                params.isUpdate,
                params.configLevel,
                params.repositoryId,
                params.directoryPath,
                params.userInfo.userEmail,
            );

            if (endChange) {
                changedData.push(endChange);
            }
        }

        // Check globalSettings changes
        if (params.globalSettings) {
            const globalSettingsChanges = this.analyzeGlobalSettingsChanges(
                params.globalSettings,
                params.isUpdate ? params.existingGlobalSettings : undefined,
                defaultMessages.globalSettings,
                params.isUpdate,
                params.configLevel,
                params.repositoryId,
                params.directoryPath,
                params.userInfo.userEmail,
            );

            changedData.push(...globalSettingsChanges);
        }

        return changedData;
    }

    private analyzeMessageChange(
        messageType: 'Start' | 'End',
        newMessage: PullRequestMessage,
        existingMessage: PullRequestMessage | undefined,
        defaultMessage: string,
        isUpdate: boolean,
        configLevel: ConfigLevel,
        repositoryId?: string,
        directoryPath?: string,
        userEmail?: string,
    ): ChangedDataToExport | null {
        let previousValue: any;
        let currentValue: any;
        let description: string;

        if (!isUpdate) {
            // Create case - changing from default to custom
            previousValue = {
                content: defaultMessage,
                status: 'active',
                isDefault: true,
            };
            currentValue = {
                content: newMessage.content,
                status: newMessage.status,
                isDefault: false,
            };

            if (this.hasContentChanged(defaultMessage, newMessage.content)) {
                description = `User ${userEmail} changed default ${messageType.toLowerCase()} review message ${this.getConfigLevelDescription(configLevel, repositoryId, directoryPath)}`;
            } else if (newMessage.status === 'inactive') {
                description = `User ${userEmail} deactivated ${messageType.toLowerCase()} review message ${this.getConfigLevelDescription(configLevel, repositoryId, directoryPath)}`;
            } else {
                return null; // No significant change
            }
        } else {
            // Update case - changing from existing custom to new custom
            if (!existingMessage) {
                return null;
            }

            const contentChanged = this.hasContentChanged(
                existingMessage.content,
                newMessage.content,
            );
            const statusChanged = existingMessage.status !== newMessage.status;

            if (!contentChanged && !statusChanged) {
                return null;
            }

            previousValue = {
                content: existingMessage.content,
                status: existingMessage.status,
                isDefault: false,
            };
            currentValue = {
                content: newMessage.content,
                status: newMessage.status,
                isDefault: false,
            };

            if (contentChanged && statusChanged) {
                const statusAction =
                    newMessage.status === 'active'
                        ? 'activated'
                        : 'deactivated';
                description = `User ${userEmail} updated content and ${statusAction} ${messageType.toLowerCase()} review message ${this.getConfigLevelDescription(configLevel, repositoryId, directoryPath)}`;
            } else if (contentChanged) {
                description = `User ${userEmail} updated ${messageType.toLowerCase()} review message content ${this.getConfigLevelDescription(configLevel, repositoryId, directoryPath)}`;
            } else {
                const statusAction =
                    newMessage.status === 'active'
                        ? 'activated'
                        : 'deactivated';
                description = `User ${userEmail} ${statusAction} ${messageType.toLowerCase()} review message ${this.getConfigLevelDescription(configLevel, repositoryId, directoryPath)}`;
            }
        }

        return {
            actionDescription: `${messageType} Review Message Updated`,
            previousValue,
            currentValue,
            description,
        };
    }

    private hasContentChanged(oldContent: string, newContent: string): boolean {
        return oldContent.trim() !== newContent.trim();
    }

    private analyzeGlobalSettingsChanges(
        newSettings: GlobalSettings,
        existingSettings: GlobalSettings | undefined,
        defaultSettings: GlobalSettings,
        isUpdate: boolean,
        configLevel: ConfigLevel,
        repositoryId?: string,
        directoryPath?: string,
        userEmail?: string,
    ): ChangedDataToExport[] {
        const changes: ChangedDataToExport[] = [];
        const baseSettings = isUpdate
            ? (existingSettings ?? defaultSettings)
            : defaultSettings;
        const levelDesc = this.getConfigLevelDescription(
            configLevel,
            repositoryId,
            directoryPath,
        );

        // Check hideComments
        const prevHideComments = baseSettings.hideComments ?? false;
        const newHideComments = newSettings.hideComments ?? false;

        if (prevHideComments !== newHideComments) {
            const action = newHideComments ? 'enabled' : 'disabled';
            changes.push({
                actionDescription:
                    'Global Setting Updated: Post as Hidden Comment',
                previousValue: { hideComments: prevHideComments },
                currentValue: { hideComments: newHideComments },
                description: `User ${userEmail} ${action} Post as Hidden Comment ${levelDesc}`,
            });
        }

        // Check suggestionCopyPrompt
        const prevSuggestionCopyPrompt =
            baseSettings.suggestionCopyPrompt ?? true;
        const newSuggestionCopyPrompt =
            newSettings.suggestionCopyPrompt ?? true;

        if (prevSuggestionCopyPrompt !== newSuggestionCopyPrompt) {
            const action = newSuggestionCopyPrompt ? 'enabled' : 'disabled';
            changes.push({
                actionDescription: 'Global Setting Updated: Enable LLM Prompt',
                previousValue: {
                    suggestionCopyPrompt: prevSuggestionCopyPrompt,
                },
                currentValue: {
                    suggestionCopyPrompt: newSuggestionCopyPrompt,
                },
                description: `User ${userEmail} ${action} Enable LLM Prompt ${levelDesc}`,
            });
        }

        return changes;
    }

    private getConfigLevelDescription(
        configLevel: ConfigLevel,
        repositoryId?: string,
        directoryPath?: string,
    ): string {
        switch (configLevel) {
            case ConfigLevel.GLOBAL:
                return 'at global level';
            case ConfigLevel.REPOSITORY:
                return `for repository ${repositoryId}`;
            case ConfigLevel.DIRECTORY:
                return `for directory ${directoryPath}`;
            default:
                return '';
        }
    }
}
