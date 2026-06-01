import {
    ActionType,
    ConfigLevel,
    UserInfo,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { Injectable } from '@nestjs/common';
import {
    BaseLogParams,
    ChangedDataToExport,
    UnifiedLogHandler,
} from './unifiedLog.handler';

export interface CodeReviewConfigLogParams extends BaseLogParams {
    oldConfig: any;
    newConfig: any;
    isCreation?: boolean;
}

interface PropertyConfig {
    actionDescription: string;
    formatter?: (value: any) => string;
}

// Property configurations moved from external file
const PROPERTY_CONFIGS: Record<string, PropertyConfig> = {
    //#region General
    'kodusConfigFileOverridesWebPreferences': {
        actionDescription: 'Config File Overrides Web Preferences',
    },
    'pullRequestApprovalActive': {
        actionDescription: 'Pull Request Approval',
    },
    'isRequestChangesActive': {
        actionDescription: 'Request Changes',
    },

    //Review Options (only active categories)
    'reviewOptions.bug': {
        actionDescription: 'Bug Detection',
    },
    'reviewOptions.performance': {
        actionDescription: 'Performance',
    },
    'reviewOptions.security': {
        actionDescription: 'Security',
    },
    'reviewOptions.cross_file': {
        actionDescription: 'Cross-file Analysis',
    },
    'reviewOptions.business_logic': {
        actionDescription: 'Business Logic',
    },

    'ignorePaths': {
        actionDescription: 'Ignored Paths',
        formatter: (value: string[]) => value?.join(', ') || 'none',
    },
    'ignoredTitleKeywords': {
        actionDescription: 'Ignored Title Keywords',
        formatter: (value: string[]) => value?.join(', ') || 'none',
    },
    'baseBranches': {
        actionDescription: 'Base Branches',
        formatter: (value: string[]) => value?.join(', ') || 'none',
    },
    'languageResultPrompt': {
        actionDescription: 'Language Result Prompt',
    },
    'runOnDraft': {
        actionDescription: 'Run on Draft',
    },
    'showStatusFeedback': {
        actionDescription: 'Show Status Feedback',
    },
    'enableCommittableSuggestions': {
        actionDescription: 'Committable Suggestions',
    },
    //#endregion

    //#region Suggestion Control
    'suggestionControl.groupingMode': {
        actionDescription: 'Grouping Mode',
    },
    'suggestionControl.limitationType': {
        actionDescription: 'Limitation Type',
    },
    'suggestionControl.maxSuggestions': {
        actionDescription: 'Max Suggestions',
    },
    'suggestionControl.severityLevelFilter': {
        actionDescription: 'Severity Level Filter',
    },
    'suggestionControl.applyFiltersToKodyRules': {
        actionDescription: 'Apply Filters to Kody Rules',
    },
    //#endregion

    //#region PR Summary
    'summary.generatePRSummary': {
        actionDescription: 'Generate PR Summary',
    },
    'summary.customInstructions': {
        actionDescription: 'Custom Instructions',
    },
    //#endregion

    //#region Kody Rules
    'kodyRulesGeneratorEnabled': {
        actionDescription: 'Kody Rules Generator',
    },
    'llmGeneratedMemoriesRequireApproval': {
        actionDescription: 'LLM Generated Memories Require Approval',
    },
    //#endregion

    'isCommitMode': {
        actionDescription: 'Commit Mode',
    },
};

interface BasicChange {
    key: string;
    oldValue: any;
    newValue: any;
    displayName: string;
    path: string[];
}

interface SpecialChange {
    displayName: string;
    customDescription: string;
    isSpecial: true;
    key?: string;
}

@Injectable()
export class CodeReviewConfigLogHandler {
    constructor(private readonly unifiedLogHandler: UnifiedLogHandler) {}

    public async logCodeReviewConfig(
        params: CodeReviewConfigLogParams,
    ): Promise<void> {
        const changedData = await this.generateChangedData(
            params.oldConfig,
            params.newConfig,
            params.userInfo,
        );

        if (params.isCreation) {
            const creationEntry = this.generateCreationEntry(params);
            changedData.unshift(creationEntry);
        }

        if (changedData.length === 0) {
            return;
        }

        await this.unifiedLogHandler.saveLogEntry({
            organizationAndTeamData: params.organizationAndTeamData,
            userInfo: params.userInfo,
            actionType: params.isCreation
                ? ActionType.CREATE
                : params.actionType,
            configLevel: params.configLevel,
            repository: params.repository,
            directory: params?.directory,
            changedData,
        });
    }

    private generateCreationEntry(
        params: CodeReviewConfigLogParams,
    ): ChangedDataToExport {
        const userEmail = params.userInfo.userEmail;

        if (params.configLevel === ConfigLevel.DIRECTORY && params.directory) {
            const directoryLabel = params.directory.path || params.directory.id;
            const repoLabel = params.repository?.name || params.repository?.id;

            return {
                actionDescription: 'Directory Configuration Created',
                previousValue: null,
                currentValue: {
                    directoryId: params.directory.id,
                    directoryPath: params.directory.path,
                    repositoryId: params.repository?.id,
                },
                description: `User ${userEmail} created configuration for directory "${directoryLabel}" in repository "${repoLabel}"`,
            };
        }

        const repoLabel = params.repository?.name || params.repository?.id;

        return {
            actionDescription: 'Repository Configuration Created',
            previousValue: null,
            currentValue: {
                repositoryId: params.repository?.id,
                repositoryName: repoLabel,
            },
            description: `User ${userEmail} created configuration for repository "${repoLabel}"`,
        };
    }

    private async generateChangedData(
        oldConfig: any,
        newConfig: any,
        userInfo: UserInfo,
    ): Promise<ChangedDataToExport[]> {
        const resolvedOld = this.resolveWithDefaults(oldConfig);
        const resolvedNew = this.resolveWithDefaults(newConfig);

        const specialChanges = this.collectSpecialChanges(
            resolvedOld,
            resolvedNew,
        );
        const excludeFromBasic =
            this.getPropertiesHandledBySpecialCases(specialChanges);
        const basicChanges = this.collectBasicChanges(
            resolvedOld,
            resolvedNew,
            excludeFromBasic,
        );

        const allChanges = [...basicChanges, ...specialChanges];

        if (allChanges.length > 0) {
            return [
                this.createUnifiedChangedData(
                    allChanges,
                    userInfo,
                    resolvedOld,
                    resolvedNew,
                ),
            ];
        }

        return [];
    }

    private resolveWithDefaults(deltaConfig: any): any {
        const defaults = getDefaultKodusConfigFile();
        return this.deepMerge(defaults, deltaConfig || {});
    }

    private deepMerge(target: any, source: any): any {
        const result = { ...target };

        for (const key of Object.keys(source)) {
            if (
                source[key] !== null &&
                typeof source[key] === 'object' &&
                !Array.isArray(source[key]) &&
                target[key] !== null &&
                typeof target[key] === 'object' &&
                !Array.isArray(target[key])
            ) {
                result[key] = this.deepMerge(target[key], source[key]);
            } else {
                result[key] = source[key];
            }
        }

        return result;
    }

    private collectBasicChanges(
        oldConfig: any,
        newConfig: any,
        excludeKeys: string[] = [],
    ): BasicChange[] {
        const changes: BasicChange[] = [];
        const flatOld = this.flattenObject(oldConfig);
        const flatNew = this.flattenObject(newConfig);

        const allKeys = new Set([
            ...Object.keys(flatOld),
            ...Object.keys(flatNew),
        ]);

        for (const key of allKeys) {
            if (
                PROPERTY_CONFIGS[key] &&
                !excludeKeys.includes(key) &&
                UnifiedLogHandler.hasChanged(flatOld[key], flatNew[key])
            ) {
                const config = PROPERTY_CONFIGS[key];
                changes.push({
                    key,
                    oldValue: flatOld[key],
                    newValue: flatNew[key],
                    displayName: config.actionDescription,
                    path: key.split('.'),
                });
            }
        }

        return changes;
    }

    private collectSpecialChanges(
        oldConfig: any,
        newConfig: any,
    ): SpecialChange[] {
        const changes: SpecialChange[] = [];

        // Handle automatedReviewActive + reviewCadence combo
        if (this.hasSignificantAutomatedReviewChange(oldConfig, newConfig)) {
            changes.push({
                displayName: 'Automated Code Review',
                customDescription: this.getAutomatedReviewCustomDescription(
                    oldConfig,
                    newConfig,
                ),
                isSpecial: true,
                key: 'automatedReviewActive',
            });
        }

        // Handle summary toggle with behavior
        if (this.hasSignificantSummaryChange(oldConfig, newConfig)) {
            changes.push({
                displayName: 'Generate PR Summary',
                customDescription: this.getSummaryCustomDescription(
                    oldConfig,
                    newConfig,
                ),
                isSpecial: true,
                key: 'summary.generatePRSummary',
            });
        }

        return changes;
    }

    private getPropertiesHandledBySpecialCases(
        specialChanges: SpecialChange[],
    ): string[] {
        const excludeKeys: string[] = [];

        specialChanges.forEach((change) => {
            if (change.key === 'automatedReviewActive') {
                excludeKeys.push(
                    'automatedReviewActive',
                    'reviewCadence.type',
                    'reviewCadence.pushesToTrigger',
                    'reviewCadence.timeWindow',
                );
            }
            if (change.key === 'summary.generatePRSummary') {
                excludeKeys.push(
                    'summary.generatePRSummary',
                    'summary.behaviourForExistingDescription',
                );
            }
        });

        return excludeKeys;
    }

    private hasSignificantAutomatedReviewChange(
        oldConfig: any,
        newConfig: any,
    ): boolean {
        if (
            oldConfig.automatedReviewActive !== newConfig.automatedReviewActive
        ) {
            return true;
        }

        const oldType = oldConfig.reviewCadence?.type;
        const newType = newConfig.reviewCadence?.type;
        if (oldType !== newType) {
            return true;
        }

        if (oldType === 'auto_pause' && newType === 'auto_pause') {
            const oldPushes = oldConfig.reviewCadence?.pushesToTrigger;
            const newPushes = newConfig.reviewCadence?.pushesToTrigger;
            const oldTime = oldConfig.reviewCadence?.timeWindow;
            const newTime = newConfig.reviewCadence?.timeWindow;

            return oldPushes !== newPushes || oldTime !== newTime;
        }

        return false;
    }

    private hasSignificantSummaryChange(
        oldConfig: any,
        newConfig: any,
    ): boolean {
        if (
            oldConfig.summary?.generatePRSummary !==
            newConfig.summary?.generatePRSummary
        ) {
            return true;
        }

        const oldBehavior = oldConfig.summary?.behaviourForExistingDescription;
        const newBehavior = newConfig.summary?.behaviourForExistingDescription;
        return oldBehavior !== newBehavior;
    }

    private getAutomatedReviewCustomDescription(
        oldConfig: any,
        newConfig: any,
    ): string {
        const wasEnabled = oldConfig.automatedReviewActive;
        const isEnabled = newConfig.automatedReviewActive;

        if (!wasEnabled && isEnabled) {
            if (newConfig.reviewCadence?.type === 'auto_pause') {
                const params = newConfig.reviewCadence;
                return `Automated Code Review: enabled with auto_pause (${params?.pushesToTrigger} pushes, ${params?.timeWindow} minutes)`;
            }
            return `Automated Code Review: enabled`;
        }

        if (wasEnabled && !isEnabled) {
            return `Automated Code Review: disabled`;
        }

        const oldCadence = oldConfig.reviewCadence?.type || 'none';
        const newCadence = newConfig.reviewCadence?.type || 'none';

        if (oldCadence !== newCadence) {
            if (newCadence === 'auto_pause') {
                const params = newConfig.reviewCadence;
                return `Automated Code Review: changed to auto_pause (${params?.pushesToTrigger} pushes, ${params?.timeWindow} minutes)`;
            }
            return `Automated Code Review: changed to ${newCadence}`;
        }

        if (oldCadence === 'auto_pause' && newCadence === 'auto_pause') {
            const oldPushes = oldConfig.reviewCadence?.pushesToTrigger;
            const newPushes = newConfig.reviewCadence?.pushesToTrigger;
            const oldTime = oldConfig.reviewCadence?.timeWindow;
            const newTime = newConfig.reviewCadence?.timeWindow;

            if (oldPushes !== newPushes || oldTime !== newTime) {
                return `Automated Code Review: updated auto_pause parameters (${newPushes} pushes, ${newTime} minutes)`;
            }
        }

        return `Automated Code Review: configuration updated`;
    }

    private getSummaryCustomDescription(
        oldConfig: any,
        newConfig: any,
    ): string {
        const wasEnabled = oldConfig.summary?.generatePRSummary;
        const isEnabled = newConfig.summary?.generatePRSummary;

        if (!wasEnabled && isEnabled) {
            const behavior = this.formatBehaviour(
                newConfig.summary?.behaviourForExistingDescription,
            );
            return `Generate PR Summary: enabled with ${behavior} behavior`;
        }

        if (wasEnabled && !isEnabled) {
            return `Generate PR Summary: disabled`;
        }

        const oldBehavior = oldConfig.summary?.behaviourForExistingDescription;
        const newBehavior = newConfig.summary?.behaviourForExistingDescription;

        if (oldBehavior !== newBehavior) {
            const formattedOldBehavior = this.formatBehaviour(oldBehavior);
            const formattedNewBehavior = this.formatBehaviour(newBehavior);
            return `Generate PR Summary: behavior changed from ${formattedOldBehavior} to ${formattedNewBehavior}`;
        }

        return `Generate PR Summary: configuration updated`;
    }

    private createUnifiedChangedData(
        allChanges: Array<BasicChange | SpecialChange>,
        userInfo: UserInfo,
        oldConfig: any,
        newConfig: any,
    ): ChangedDataToExport {
        const previousValue = this.buildCompleteNestedStructure(
            allChanges,
            oldConfig,
            newConfig,
            'oldValue',
        );
        const currentValue = this.buildCompleteNestedStructure(
            allChanges,
            oldConfig,
            newConfig,
            'newValue',
        );
        const description = this.generateRichDescription(
            allChanges,
            userInfo.userEmail,
        );

        return {
            actionDescription: 'Configuration Updated',
            previousValue,
            currentValue,
            description,
        };
    }

    private buildCompleteNestedStructure(
        allChanges: Array<BasicChange | SpecialChange>,
        oldConfig: any,
        newConfig: any,
        valueType: 'oldValue' | 'newValue',
    ): any {
        const result = {};

        const basicChanges = allChanges.filter(
            (change): change is BasicChange => !('isSpecial' in change),
        );
        basicChanges.forEach((change) => {
            const value = change[valueType];
            const path = change.path;

            let current = result;
            for (let i = 0; i < path.length - 1; i++) {
                if (!current[path[i]]) {
                    current[path[i]] = {};
                }
                current = current[path[i]];
            }

            current[path[path.length - 1]] = value;
        });

        const specialChanges = allChanges.filter(
            (change): change is SpecialChange => 'isSpecial' in change,
        );
        specialChanges.forEach((change) => {
            const sourceConfig =
                valueType === 'oldValue' ? oldConfig : newConfig;

            if (change.key === 'automatedReviewActive') {
                result['automatedReviewActive'] =
                    sourceConfig.automatedReviewActive;
                result['reviewCadence'] = sourceConfig.reviewCadence;
            }

            if (change.key === 'summary.generatePRSummary') {
                if (!result['summary']) result['summary'] = {};
                result['summary']['generatePRSummary'] =
                    sourceConfig.summary?.generatePRSummary;
                result['summary']['behaviourForExistingDescription'] =
                    sourceConfig.summary?.behaviourForExistingDescription;
            }
        });

        return result;
    }

    private generateRichDescription(
        allChanges: Array<BasicChange | SpecialChange>,
        userEmail: string,
    ): string {
        if (allChanges.length === 1) {
            const change = allChanges[0];

            if ('isSpecial' in change) {
                return `User ${userEmail} changed ${change.customDescription}`;
            } else {
                const config = PROPERTY_CONFIGS[change.key];
                const formattedOld = config.formatter
                    ? config.formatter(change.oldValue)
                    : UnifiedLogHandler.formatValue(change.oldValue);
                const formattedNew = config.formatter
                    ? config.formatter(change.newValue)
                    : UnifiedLogHandler.formatValue(change.newValue);

                return `User ${userEmail} changed ${config.actionDescription} from ${formattedOld} to ${formattedNew}`;
            }
        }

        const header = `User ${userEmail} changed code review configuration`;
        const bullets = allChanges
            .map((change) => {
                if ('isSpecial' in change) {
                    return `- ${change.customDescription}`;
                } else {
                    const config = PROPERTY_CONFIGS[change.key];
                    const formattedOld = config.formatter
                        ? config.formatter(change.oldValue)
                        : UnifiedLogHandler.formatValue(change.oldValue);
                    const formattedNew = config.formatter
                        ? config.formatter(change.newValue)
                        : UnifiedLogHandler.formatValue(change.newValue);

                    return `- ${config.actionDescription}: from ${formattedOld} to ${formattedNew}`;
                }
            })
            .join('\n');

        return `${header}\n${bullets}`;
    }

    private formatBehaviour(behaviour: string): string {
        const behaviourLabels = {
            concatenate: 'Concatenate',
            complement: 'Complement',
            replace: 'Replace',
        };
        return behaviourLabels[behaviour] || behaviour;
    }

    private flattenObject(obj: any, prefix: string = ''): Record<string, any> {
        const flattened: Record<string, any> = {};

        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const newKey = prefix ? `${prefix}.${key}` : key;

                if (
                    obj[key] !== null &&
                    typeof obj[key] === 'object' &&
                    !Array.isArray(obj[key])
                ) {
                    Object.assign(
                        flattened,
                        this.flattenObject(obj[key], newKey),
                    );
                } else {
                    flattened[newKey] = obj[key];
                }
            }
        }

        return flattened;
    }
}
