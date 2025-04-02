import { ProcessedMetrics } from './metrics.formatter';
import {
    SlackBlocks,
    SlackBlock,
} from '@/core/application/use-cases/platformIntegration/communication/sendNotification/notification.formatter';
import { ColumnsForMetricsMessage } from './metrics.formatter';

export class SlackFormatter {
    private static readonly EMOJIS = {
        IMPROVES: '🚀',
        WORSENS: '❗',
        NEUTRAL: '✅',
        TITLE: '📊',
        METRICS: '📌',
    };

    static format(
        processedMetrics: ProcessedMetrics,
        columns: ColumnsForMetricsMessage,
    ): SlackBlocks {
        const blocks: SlackBlocks = [
            // Header
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: `${this.EMOJIS.TITLE} Engineering Metrics`,
                    emoji: true,
                },
            },
            // Legend
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: this.buildLegendSection(),
                },
            },
            // Divider
            { type: 'divider' },
            // Flow Metrics Header
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '*Flow Metrics*',
                },
            },
            ...this.buildFlowMetricsBlocks(
                processedMetrics.flowMetrics,
                columns,
            ),
            // Divider
            { type: 'divider' },
            // Dora Metrics Header
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '*Dora Metrics*',
                },
            },
            ...this.buildDoraMetricsBlocks(processedMetrics.doraMetrics),
        ];

        return blocks;
    }

    private static buildLegendSection(): string {
        return (
            '*Legend of results*\n' +
            `→ ${this.EMOJIS.NEUTRAL} Means the result stayed the *same*\n` +
            `→ ${this.EMOJIS.IMPROVES} Means the result *improved*\n` +
            `→ ${this.EMOJIS.WORSENS} Means the result *worsened*`
        );
    }

    private static buildFlowMetricsBlocks(
        flowMetrics: ProcessedMetrics['flowMetrics'],
        columns: ColumnsForMetricsMessage,
    ): SlackBlock[] {
        const blocks: SlackBlock[] = [];

        if (flowMetrics.leadTime) {
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text:
                        `${this.EMOJIS.METRICS} *Lead Time*  ${this.getEmojiForType(flowMetrics.leadTime.type)}\n` +
                        `The time it takes for an activity to move from ${columns.todo} to ${columns.done}.\n` +
                        `• *P50 (Optimistic)*: ${this.formatTime(flowMetrics.leadTime.currentValue)}\n` +
                        `• *P75 (Confident)*: ${this.formatTime(flowMetrics.leadTime.currentValue)}\n` +
                        `• *P95 (Pessimistic)*: ${this.formatTime(flowMetrics.leadTime.currentValue)}`,
                },
            });
        }

        if (flowMetrics.leadTimeInWip) {
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text:
                        `${this.EMOJIS.METRICS} *Lead Time in WIP*  ${this.getEmojiForType(flowMetrics.leadTimeInWip.type)}\n` +
                        `The time it takes for an activity to move from ${columns.wip} to ${columns.done}.\n` +
                        `• *P50 (Optimistic)*: ${this.formatTime(flowMetrics.leadTimeInWip.currentValue)}\n` +
                        `• *P75 (Confident)*: ${this.formatTime(flowMetrics.leadTimeInWip.currentValue)}\n` +
                        `• *P95 (Pessimistic)*: ${this.formatTime(flowMetrics.leadTimeInWip.currentValue)}`,
                },
            });
        }

        if (flowMetrics.throughput) {
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text:
                        `${this.EMOJIS.METRICS} *Throughput*  ${this.getEmojiForType(flowMetrics.throughput.type)}\n` +
                        `Number of items that reached the ${columns.done} status in the last 7 days.\n` +
                        `• ${flowMetrics.throughput.currentValue} items.`,
                },
            });
        }

        if (flowMetrics.bugRatio) {
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text:
                        `${this.EMOJIS.METRICS} *Bug Ratio*  ${this.getEmojiForType(flowMetrics.bugRatio.type)}\n` +
                        'Number of bugs in WIP relative to the total activities in WIP, in the last 7 days.\n' +
                        `• ${flowMetrics.bugRatio.currentValue}.`,
                },
            });
        }

        if (flowMetrics.leadTimeByColumn) {
            const leadTimeByColumnValue = Object.entries(
                flowMetrics.leadTimeByColumn,
            )
                .map(
                    ([column, data]) =>
                        `• *${column}*: ${this.formatTime(data.value)}  ${this.getEmojiForType(data.type)}`,
                )
                .join('\n');

            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text:
                        `${this.EMOJIS.METRICS} *Lead Time By Column*\n` +
                        'Time an item spends in *P75* in each status of your board.\n' +
                        leadTimeByColumnValue,
                },
            });
        }

        return blocks;
    }

    private static buildDoraMetricsBlocks(
        doraMetrics: ProcessedMetrics['doraMetrics'],
    ): SlackBlock[] {
        const blocks: SlackBlock[] = [];

        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text:
                    `${this.EMOJIS.METRICS} *Deploy Frequency*  ${this.getEmojiForType(doraMetrics.deployFrequency.type)}\n` +
                    'Deploy frequency per week.\n' +
                    `• ${doraMetrics.deployFrequency.currentValue} deploys per week.`,
            },
        });

        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text:
                    `${this.EMOJIS.METRICS} *Lead Time for Change*  ${this.getEmojiForType(doraMetrics.leadTimeForChange.type)}\n` +
                    'Average time from the first commit to the merge of the PR.\n' +
                    `• ${doraMetrics.leadTimeForChange.currentValue} days.`,
            },
        });

        return blocks;
    }

    private static getEmojiForType(
        type: 'improves' | 'worsens' | 'neutral',
    ): string {
        return this.EMOJIS[type.toUpperCase()];
    }

    private static formatTime(hours: number): string {
        const days = Math.floor(hours / 24);
        const remainingHours = Math.floor(hours % 24);
        const minutes = Math.floor((hours * 60) % 60);

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (remainingHours > 0) parts.push(`${remainingHours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);

        return parts.join(' ');
    }
}
