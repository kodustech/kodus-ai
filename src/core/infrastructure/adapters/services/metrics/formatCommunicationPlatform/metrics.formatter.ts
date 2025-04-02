import { DiscordFormatter } from './discord.formatter';

interface ComparedMetric {
    currentValue: any;
    previousValue: any;
    variation: string;
    type: 'improves' | 'worsens' | 'neutral';
    percentiles?: {
        p50?: {
            value: number;
            variation: string;
        };
        p75?: {
            value: number;
            variation: string;
        };
        p95?: {
            value: number;
            variation: string;
        };
    };
}

export interface ProcessedMetrics {
    flowMetrics?: {
        leadTime?: ComparedMetric;
        leadTimeInWip?: ComparedMetric;
        throughput?: ComparedMetric;
        bugRatio?: ComparedMetric;
        leadTimeByColumn?: {
            [key: string]: {
                value: number;
                type: 'improves' | 'worsens' | 'neutral';
            };
        };
    };
    doraMetrics?: {
        deployFrequency?: ComparedMetric;
        leadTimeForChange?: ComparedMetric;
    };
}

export type ColumnsForMetricsMessage = {
    todo: string;
    wip: string;
    done: string;
};

export class MetricsFormatterCommunicationPlatform {
    private static createEmptyComparedMetric(): ComparedMetric {
        return {
            currentValue: 0,
            previousValue: 0,
            variation: '0%',
            type: 'neutral',
        };
    }

    private static getLatestMetrics(
        dataHistory: any[] | undefined,
    ): ComparedMetric | null {
        if (!Array.isArray(dataHistory) || dataHistory.length < 2) {
            return null;
        }

        try {
            const [current, previous] = dataHistory;

            if (!current?.result?.value || !previous?.result?.value) {
                return null;
            }

            return {
                currentValue: current.result.value,
                previousValue: previous.result.value,
                variation: current.resultRelatedPreviousWeek?.variation || '0%',
                type: current.resultRelatedPreviousWeek?.type || 'neutral',
                percentiles: current.percentiles,
            };
        } catch (error) {
            console.warn('Error processing latest metrics:', error);
            return null;
        }
    }

    private static processLeadTimeByColumn(dataHistory: any[] | undefined) {
        if (!Array.isArray(dataHistory) || dataHistory.length < 2) {
            return {};
        }

        try {
            const [current, previous] = dataHistory;

            if (!current?.result?.value || !previous?.result?.value) {
                return {};
            }

            const columns = Object.keys(current.result.value);

            return columns.reduce((acc, column) => {
                const currentValue = current.result.value[column] || 0;
                const previousValue = previous.result.value[column] || 0;

                acc[column] = {
                    value: currentValue,
                    type:
                        currentValue < previousValue
                            ? 'improves'
                            : currentValue > previousValue
                              ? 'worsens'
                              : 'neutral',
                };

                return acc;
            }, {});
        } catch (error) {
            console.warn('Error processing lead time by column:', error);
            return {};
        }
    }

    public static async compareMetrics(
        mappedMetrics: any,
    ): Promise<ProcessedMetrics> {
        const result: ProcessedMetrics = {};

        try {
            // Process flow metrics if they exist
            if (mappedMetrics?.flowMetrics) {
                result.flowMetrics = {
                    leadTime:
                        this.getLatestMetrics(
                            mappedMetrics.flowMetrics.leadTime?.dataHistory,
                        ) || this.createEmptyComparedMetric(),
                    leadTimeInWip:
                        this.getLatestMetrics(
                            mappedMetrics.flowMetrics.leadTimeInWip
                                ?.dataHistory,
                        ) || this.createEmptyComparedMetric(),
                    throughput:
                        this.getLatestMetrics(
                            mappedMetrics.flowMetrics.throughput?.dataHistory,
                        ) || this.createEmptyComparedMetric(),
                    bugRatio:
                        this.getLatestMetrics(
                            mappedMetrics.flowMetrics.bugRatio?.dataHistory,
                        ) || this.createEmptyComparedMetric(),
                    leadTimeByColumn: this.processLeadTimeByColumn(
                        mappedMetrics.flowMetrics.leadTimeByColumn?.dataHistory,
                    ),
                };
            }

            // Process DORA metrics if they exist
            if (mappedMetrics?.doraMetrics) {
                result.doraMetrics = {
                    deployFrequency:
                        this.getLatestMetrics(
                            mappedMetrics.doraMetrics.deployFrequency
                                ?.dataHistory,
                        ) || this.createEmptyComparedMetric(),
                    leadTimeForChange:
                        this.getLatestMetrics(
                            mappedMetrics.doraMetrics.leadTimeForChange
                                ?.dataHistory,
                        ) || this.createEmptyComparedMetric(),
                };
            }

            return result;
        } catch (error) {
            console.error('Error comparing metrics:', error);
            return result;
        }
    }
}

// Example of usage in DiscordService
export class DiscordService {
    public async formatMetricsMessage(params: any): Promise<any> {
        try {
            const comparedMetrics =
                await MetricsFormatterCommunicationPlatform.compareMetrics(
                    params.metrics,
                );

            // Check if there is valid data to format
            if (!comparedMetrics.flowMetrics && !comparedMetrics.doraMetrics) {
                throw new Error('No valid metrics data available');
            }

            return DiscordFormatter.format(comparedMetrics, params.columns);
        } catch (error) {
            console.error('Error formatting metrics:', error);
            return null;
        }
    }
}
