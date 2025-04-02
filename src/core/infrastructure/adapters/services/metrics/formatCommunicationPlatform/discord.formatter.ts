import {
    DiscordField,
    DiscordMessage,
} from '@/core/application/use-cases/platformIntegration/communication/sendNotification/notification.formatter';
import { DiscordEmbed } from '@/core/application/use-cases/platformIntegration/communication/sendNotification/notification.formatter';
import {
    ColumnsForMetricsMessage,
    ProcessedMetrics,
} from './metrics.formatter';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import {
    getTranslationsForLanguageByCategory,
    TranslationsCategory,
} from '@/shared/utils/translations/translations';

export class DiscordFormatter {
    private static readonly EMOJIS = {
        IMPROVES: '🚀',
        WORSENS: '❗',
        NEUTRAL: '✅',
        TITLE: '📊',
        METRICS: '📌',
    };

    private static readonly TRANSLATIONS = {
        [LanguageValue.ENGLISH]: {
            title: '📦 Engineering Metrics',
            legend: {
                title: 'Legend of results',
                same: 'Means the result remained the __same__',
                improved: 'Means the result __improved__',
                worsened: 'Means the result __worsened__',
            },
            flowMetrics: {
                title: 'Flow Metrics',
                leadTime: {
                    title: 'Lead Time',
                    description: (columns: ColumnsForMetricsMessage) =>
                        `The time it takes for an activity to move from the ${columns.todo} status to the ${columns.done} status.`,
                },
                leadTimeInWip: {
                    title: 'Lead Time in WIP',
                    description: (columns: ColumnsForMetricsMessage) =>
                        `The time it takes for an activity to move from the ${columns.wip} status to the ${columns.done} status.`,
                },
                throughput: {
                    title: 'Throughput',
                    description: (columns: ColumnsForMetricsMessage) =>
                        `Number of items that reached the ${columns.done} status in the last 7 days.`,
                    items: 'items',
                },
                bugRatio: {
                    title: 'Bug Ratio',
                    description:
                        'Number of bugs in WIP relative to the total activities in WIP, in the last 7 days.',
                },
                leadTimeByColumn: {
                    title: 'Lead Time By Column',
                    description:
                        'Time an item spends in *P75* in each status of your board.',
                },
            },
            doraMetrics: {
                title: 'Dora Metrics',
                deployFrequency: {
                    title: 'Deploy Frequency',
                    description: 'Deploy frequency in the week.',
                    value: (value: number) => `${value} deploys per week`,
                },
                leadTimeForChange: {
                    title: 'Lead Time for Change',
                    description:
                        'Average time from the first commit to the PR merge.',
                    value: (value: number) => `${value} days`,
                },
            },
            percentiles: {
                p50: 'P50 (Optimistic)',
                p75: 'P75 (Confident)',
                p95: 'P95 (Pessimistic)',
            },
        },
        [LanguageValue.PORTUGUESE_BR]: {
            title: '📦 Métricas de Engenharia',
            legend: {
                title: 'Legenda dos resultados',
                same: 'Significa que o resultado permaneceu o __mesmo__',
                improved: 'Significa que o resultado __melhorou__',
                worsened: 'Significa que o resultado __piorou__',
            },
            flowMetrics: {
                title: 'Métricas de Fluxo',
                leadTime: {
                    title: 'Lead Time',
                    description: (columns: ColumnsForMetricsMessage) =>
                        `O tempo que uma atividade leva para ir do status ${columns.todo} até o status ${columns.done}.`,
                },
                leadTimeInWip: {
                    title: 'Lead Time em WIP',
                    description: (columns: ColumnsForMetricsMessage) =>
                        `O tempo que uma atividade leva para ir do status ${columns.wip} até o status ${columns.done}.`,
                },
                throughput: {
                    title: 'Throughput',
                    description: (columns: ColumnsForMetricsMessage) =>
                        `Número de itens que chegaram ao status ${columns.done} nos últimos 7 dias.`,
                    items: 'itens',
                },
                bugRatio: {
                    title: 'Bug Ratio',
                    description:
                        'Número de bugs em WIP em relação ao total de atividades em WIP, nos últimos 7 dias.',
                },
                leadTimeByColumn: {
                    title: 'Lead Time por Coluna',
                    description:
                        'Tempo que um item passa em *P75* em cada status do seu quadro.',
                },
            },
            doraMetrics: {
                title: 'Métricas DORA',
                deployFrequency: {
                    title: 'Frequência de Deploy',
                    description: 'Frequência de deploy na semana.',
                    value: (value: number) => `${value} deploys por semana`,
                },
                leadTimeForChange: {
                    title: 'Lead Time for Changes',
                    description:
                        'Tempo médio do primeiro commit até o merge do PR.',
                    value: (value: number) => `${value} dias`,
                },
            },
            percentiles: {
                p50: 'P50 (Otimista)',
                p75: 'P75 (Confiante)',
                p95: 'P95 (Pessimista)',
            },
        },
    };

    static format(
        processedMetrics: ProcessedMetrics,
        columns: ColumnsForMetricsMessage,
        language: LanguageValue = LanguageValue.ENGLISH,
    ): DiscordMessage {
        const translation = getTranslationsForLanguageByCategory(
            language,
            TranslationsCategory.DiscordFormatter,
        );

        if (!translation) {
            throw new Error('Translation not found');
        }

        const embed: DiscordEmbed = {
            title: translation.title,
            description: this.buildLegendSection(translation.legend),
            color: 0x800080,
            fields: [
                ...(processedMetrics?.flowMetrics
                    ? this.buildFlowMetricsFields(
                          processedMetrics.flowMetrics,
                          columns,
                          translation.flowMetrics,
                          translation.percentiles,
                      )
                    : []),
                ...(processedMetrics?.doraMetrics
                    ? this.buildDoraMetricsFields(
                          processedMetrics.doraMetrics,
                          translation.doraMetrics,
                      )
                    : []),
            ],
        };

        return {
            embeds: [embed],
        };
    }

    private static buildLegendSection(legendTranslations: any): string {
        return (
            `**${legendTranslations.title}**\n` +
            `→ ${this.EMOJIS.NEUTRAL} ${legendTranslations.same}\n` +
            `→ ${this.EMOJIS.IMPROVES} ${legendTranslations.improved}\n` +
            `→ ${this.EMOJIS.WORSENS} ${legendTranslations.worsened}`
        );
    }

    private static buildFlowMetricsFields(
        flowMetrics: ProcessedMetrics['flowMetrics'],
        columns: ColumnsForMetricsMessage,
        translations: any,
        percentileTranslations: any,
    ): DiscordField[] {
        const fields: DiscordField[] = [
            {
                name: '\u200B',
                value: `__**${translations.title}**__`,
                inline: false,
            },
        ];

        if (flowMetrics.leadTime) {
            fields.push({
                name: `${this.EMOJIS.METRICS} ${translations.leadTime.title} ${this.getEmojiForType(flowMetrics.leadTime.type)}`,
                value:
                    `${this.formatDescription(columns, translations.leadTime.description)}\n` +
                    `* **${percentileTranslations.p50}**: ${this.formatTime(flowMetrics.leadTime.percentiles?.p50?.value)}\n` +
                    `* **${percentileTranslations.p75}**: ${this.formatTime(flowMetrics.leadTime.percentiles?.p75?.value)}\n` +
                    `* **${percentileTranslations.p95}**: ${this.formatTime(flowMetrics.leadTime.percentiles?.p95?.value)}\n`,
                inline: false,
            });
        }

        if (flowMetrics.leadTimeInWip) {
            fields.push({
                name: `${this.EMOJIS.METRICS} ${translations.leadTimeInWip.title} ${this.getEmojiForType(flowMetrics.leadTimeInWip.type)}`,
                value:
                    `${this.formatDescription(columns, translations.leadTimeInWip.description)}\n` +
                    `* **${percentileTranslations.p50}**: ${this.formatTime(flowMetrics.leadTimeInWip.percentiles?.p50?.value)}\n` +
                    `* **${percentileTranslations.p75}**: ${this.formatTime(flowMetrics.leadTimeInWip.percentiles?.p75?.value)}\n` +
                    `* **${percentileTranslations.p95}**: ${this.formatTime(flowMetrics.leadTimeInWip.percentiles?.p95?.value)}\n`,
                inline: false,
            });
        }

        if (flowMetrics.throughput) {
            fields.push({
                name: `${this.EMOJIS.METRICS} ${translations.throughput.title} ${this.getEmojiForType(flowMetrics.throughput.type)}`,
                value:
                    `${this.formatDescription(columns, translations.throughput.description)}\n` +
                    `* ${flowMetrics.throughput.currentValue} ${translations.throughput.items}.`,
                inline: false,
            });
        }

        if (flowMetrics.bugRatio) {
            fields.push({
                name: `${this.EMOJIS.METRICS} ${translations.bugRatio.title} ${this.getEmojiForType(flowMetrics.bugRatio.type)}`,
                value:
                    `${translations.bugRatio.description}\n` +
                    `* ${flowMetrics.bugRatio.currentValue}.\n`,
                inline: false,
            });
        }

        if (flowMetrics.leadTimeByColumn) {
            const leadTimeByColumnValue = Object.entries(
                flowMetrics.leadTimeByColumn,
            )
                .map(
                    ([column, data]) =>
                        `* **${column}**: ${this.formatTime(data.value)} ${this.getEmojiForType(data.type)}`,
                )
                .join('\n');

            fields.push({
                name: `${this.EMOJIS.METRICS} ${translations.leadTimeByColumn.title}`,
                value:
                    `${translations.leadTimeByColumn.description}\n` +
                    `${leadTimeByColumnValue}\n`,
                inline: false,
            });
        }

        return fields;
    }

    private static buildDoraMetricsFields(
        doraMetrics: ProcessedMetrics['doraMetrics'],
        translations: any,
    ): DiscordField[] {
        const fields: DiscordField[] = [
            {
                name: '\u200B',
                value: `__**${translations.title}**__`,
                inline: false,
            },
        ];

        fields.push({
            name: `${this.EMOJIS.METRICS} ${translations.deployFrequency.title} ${this.getEmojiForType(doraMetrics.deployFrequency.type)}`,
            value:
                `${translations.deployFrequency.description}\n` +
                `* ${this.formatDoraValue(doraMetrics.deployFrequency.currentValue, translations.deployFrequency.value)}.\n`,
            inline: false,
        });

        fields.push({
            name: `${this.EMOJIS.METRICS} ${translations.leadTimeForChange.title} ${this.getEmojiForType(doraMetrics.leadTimeForChange.type)}`,
            value:
                `${translations.leadTimeForChange.description}\n` +
                `* ${this.formatDoraValue(doraMetrics.leadTimeForChange.currentValue, translations.leadTimeForChange.value)}.\n`,
            inline: false,
        });

        return fields;
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

    private static formatDescription(
        columns: ColumnsForMetricsMessage,
        description: string,
    ): string {
        return description
            .replace(/\${todo}/g, columns.todo)
            .replace(/\${wip}/g, columns.wip)
            .replace(/\${done}/g, columns.done);
    }

    private static formatDoraValue(value: any, text: string): string {
        return text.replace(/\${value}/g, value);
    }
}
