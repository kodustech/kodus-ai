import { Injectable } from '@nestjs/common';
import {
    BaseLogParams,
    ChangedDataToExport,
    UnifiedLogHandler,
} from './unifiedLog.handler';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

export interface OrgSettingsLogParams extends BaseLogParams {
    settingKey: string;
    previousValue: any;
    currentValue: any;
}

@Injectable()
export class OrgSettingsLogHandler {
    constructor(private readonly unifiedLogHandler: UnifiedLogHandler) {}

    public async logOrgSettingsChange(
        params: OrgSettingsLogParams,
    ): Promise<void> {
        const changedData = this.generateChangedData(params);

        if (changedData.length === 0) {
            return;
        }

        await this.unifiedLogHandler.saveLogEntry({
            ...params,
            actionType: ActionType.EDIT,
            configLevel: ConfigLevel.GLOBAL,
            repository: undefined,
            changedData,
        });
    }

    private generateChangedData(
        params: OrgSettingsLogParams,
    ): ChangedDataToExport[] {
        const { settingKey, previousValue, currentValue, userInfo } = params;

        switch (settingKey) {
            case 'auto_join_config':
                return this.generateAutoJoinChanges(
                    previousValue,
                    currentValue,
                    userInfo.userEmail,
                );
            case 'timezone_config':
                return this.generateTimezoneChanges(
                    previousValue,
                    currentValue,
                    userInfo.userEmail,
                );
            case 'cockpit_metrics_visibility':
                return this.generateCockpitMetricsChanges(
                    previousValue,
                    currentValue,
                    userInfo.userEmail,
                );
            case 'byok_config':
                return this.generateByokChanges(
                    previousValue,
                    currentValue,
                    userInfo.userEmail,
                );
            default:
                return [];
        }
    }

    private generateAutoJoinChanges(
        previous: any,
        current: any,
        userEmail: string,
    ): ChangedDataToExport[] {
        const changes: ChangedDataToExport[] = [];

        const prevEnabled = previous?.enabled ?? false;
        const currEnabled = current?.enabled ?? false;
        const prevDomains: string[] = previous?.domains ?? [];
        const currDomains: string[] = current?.domains ?? [];

        const enabledChanged = prevEnabled !== currEnabled;
        const domainsChanged =
            JSON.stringify(prevDomains.sort()) !==
            JSON.stringify(currDomains.sort());

        if (!enabledChanged && !domainsChanged) {
            return [];
        }

        const parts: string[] = [];

        if (enabledChanged) {
            parts.push(currEnabled ? 'enabled' : 'disabled');
        }

        if (domainsChanged && currDomains.length > 0) {
            parts.push(`with domains: ${currDomains.join(', ')}`);
        }

        const action = enabledChanged
            ? currEnabled
                ? 'enabled'
                : 'disabled'
            : 'updated';

        changes.push({
            actionDescription: 'Auto-Join Settings Updated',
            previousValue: {
                enabled: prevEnabled,
                domains: prevDomains,
            },
            currentValue: {
                enabled: currEnabled,
                domains: currDomains,
            },
            description: `User ${userEmail} ${action} Auto-Join${domainsChanged && currDomains.length > 0 ? ` with domains: ${currDomains.join(', ')}` : ''}`,
        });

        return changes;
    }

    private generateTimezoneChanges(
        previous: any,
        current: any,
        userEmail: string,
    ): ChangedDataToExport[] {
        const prevTimezone = previous ?? 'not set';
        const currTimezone = current ?? 'not set';

        if (prevTimezone === currTimezone) {
            return [];
        }

        return [
            {
                actionDescription: 'Timezone Updated',
                previousValue: { timezone: prevTimezone },
                currentValue: { timezone: currTimezone },
                description: `User ${userEmail} changed timezone from ${this.formatTimezone(prevTimezone)} to ${this.formatTimezone(currTimezone)}`,
            },
        ];
    }

    private generateCockpitMetricsChanges(
        previous: any,
        current: any,
        userEmail: string,
    ): ChangedDataToExport[] {
        const changes: ChangedDataToExport[] = [];

        const categories: Array<{ key: string; label: string }> = [
            { key: 'summary', label: 'Summary Metrics' },
            { key: 'details', label: 'Details Metrics' },
        ];

        const metricLabels: Record<string, Record<string, string>> = {
            summary: {
                deployFrequency: 'Deploy Frequency',
                prCycleTime: 'PR Cycle Time',
                kodySuggestions: 'Kody Suggestions',
                bugRatio: 'Bug Ratio',
                prSize: 'PR Size',
            },
            details: {
                leadTimeBreakdown: 'Lead Time Breakdown',
                prCycleTime: 'PR Cycle Time Chart',
                prsOpenedVsClosed: 'PRs Opened vs Closed',
                prsMergedByDeveloper: 'PRs Merged by Developer',
                teamActivity: 'Team Activity',
            },
        };

        for (const category of categories) {
            const prevCategory = previous?.[category.key] ?? {};
            const currCategory = current?.[category.key] ?? {};

            const allKeys = new Set([
                ...Object.keys(prevCategory),
                ...Object.keys(currCategory),
            ]);

            for (const metric of allKeys) {
                const prevValue = prevCategory[metric] ?? true;
                const currValue = currCategory[metric] ?? true;

                if (prevValue !== currValue) {
                    const label =
                        metricLabels[category.key]?.[metric] ?? metric;
                    const action = currValue ? 'enabled' : 'disabled';

                    changes.push({
                        actionDescription: `Cockpit Metric ${action === 'enabled' ? 'Enabled' : 'Disabled'}`,
                        previousValue: { [metric]: prevValue },
                        currentValue: { [metric]: currValue },
                        description: `User ${userEmail} ${action} ${label} in ${category.label}`,
                    });
                }
            }
        }

        return changes;
    }

    private generateByokChanges(
        previous: any,
        current: any,
        userEmail: string,
    ): ChangedDataToExport[] {
        const changes: ChangedDataToExport[] = [];
        const slots: Array<{ key: string; label: string }> = [
            { key: 'main', label: 'Main' },
            { key: 'fallback', label: 'Fallback' },
        ];

        const loggableFields: Array<{ key: string; label: string }> = [
            { key: 'provider', label: 'Provider' },
            { key: 'model', label: 'Model' },
            { key: 'baseURL', label: 'Base URL' },
            { key: 'disableReasoning', label: 'Disable Reasoning' },
            { key: 'temperature', label: 'Temperature' },
            { key: 'maxInputTokens', label: 'Max Input Tokens' },
            { key: 'maxConcurrentRequests', label: 'Max Concurrent Requests' },
            { key: 'maxOutputTokens', label: 'Max Output Tokens' },
        ];

        for (const slot of slots) {
            const prevSlot = previous?.[slot.key];
            const currSlot = current?.[slot.key];

            // Slot added
            if (!prevSlot && currSlot) {
                changes.push({
                    actionDescription: `BYOK ${slot.label} Configuration Added`,
                    previousValue: null,
                    currentValue: this.sanitizeByokSlot(currSlot),
                    description: `User ${userEmail} added BYOK ${slot.label} configuration (provider: ${currSlot.provider ?? 'N/A'}, model: ${currSlot.model ?? 'N/A'})`,
                });
                continue;
            }

            // Slot removed
            if (prevSlot && !currSlot) {
                changes.push({
                    actionDescription: `BYOK ${slot.label} Configuration Removed`,
                    previousValue: this.sanitizeByokSlot(prevSlot),
                    currentValue: null,
                    description: `User ${userEmail} removed BYOK ${slot.label} configuration`,
                });
                continue;
            }

            // Both exist — compare individual fields
            if (prevSlot && currSlot) {
                for (const field of loggableFields) {
                    const prevVal = prevSlot[field.key];
                    const currVal = currSlot[field.key];

                    if (prevVal !== currVal) {
                        changes.push({
                            actionDescription: `BYOK ${slot.label} ${field.label} Updated`,
                            previousValue: {
                                [field.key]: prevVal ?? 'not set',
                            },
                            currentValue: {
                                [field.key]: currVal ?? 'not set',
                            },
                            description: `User ${userEmail} changed ${field.label} in BYOK ${slot.label} from ${this.formatByokValue(prevVal)} to ${this.formatByokValue(currVal)}`,
                        });
                    }
                }

                // Detect API key change (log that it changed, never the value)
                if (prevSlot.apiKey !== currSlot.apiKey) {
                    const prevKeyExists = !!prevSlot.apiKey;
                    const currKeyExists = !!currSlot.apiKey;
                    const action = currKeyExists
                        ? prevKeyExists
                            ? 'updated'
                            : 'added'
                        : 'removed';
                    const actionVerb =
                        action.charAt(0).toUpperCase() + action.slice(1);

                    changes.push({
                        actionDescription: `BYOK ${slot.label} API Key ${actionVerb}`,
                        previousValue: {
                            apiKey: prevKeyExists ? '***' : 'not set',
                        },
                        currentValue: {
                            apiKey: currKeyExists ? '***' : 'not set',
                        },
                        description: `User ${userEmail} ${action} the API Key in BYOK ${slot.label} configuration`,
                    });
                }
            }
        }

        return changes;
    }

    private sanitizeByokSlot(slot: any): Record<string, any> {
        if (!slot || typeof slot !== 'object') return {};
        const { apiKey, ...rest } = slot;
        return { ...rest, apiKey: apiKey ? '***' : undefined };
    }

    private formatByokValue(value: any): string {
        if (value === undefined || value === null) return 'not set';
        return String(value);
    }

    private formatTimezone(tz: string): string {
        if (tz === 'not set') return tz;
        return tz.replace(/_/g, ' ');
    }
}
