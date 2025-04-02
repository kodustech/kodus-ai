import { ColumnsConfigResult } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { Timezone } from '@/shared/domain/enums/timezones.enum';
import * as moment from 'moment-timezone';

class LeadTimeByColumnCalculator {
    private columnsConfig: ColumnsConfigResult;
    private leadTimeData: any;

    setConfiguration(columnsConfig: ColumnsConfigResult, leadTimeData: any) {
        this.columnsConfig = columnsConfig;
        this.leadTimeData = leadTimeData;
    }

    calculateWipLeadTime() {
        try {
            const timesInWip: { [key: string]: number[] } = {};

            // Initialize arrays for each WIP column
            this.columnsConfig.allColumns.forEach((column) => {
                if (column.column !== 'done') {
                    timesInWip[column.name] = [];
                }
            });

            Object.values(this.leadTimeData).forEach((issueData: any) => {
                // Process WIP columns
                this.columnsConfig.allColumns.forEach((column) => {
                    if (
                        column.column !== 'done' &&
                        issueData[column.name] !== undefined
                    ) {
                        timesInWip[column.name].push(issueData[column.name]);
                    }
                });
            });

            const percentileResults: { [key: string]: number } = {};
            Object.keys(timesInWip).forEach((wipCol) => {
                if (timesInWip[wipCol].length > 0) {
                    const sortedTimes = timesInWip[wipCol].sort(
                        (a, b) => a - b,
                    );
                    const arrayIndex = (75 / 100) * (sortedTimes.length - 1);

                    if (Number.isInteger(arrayIndex)) {
                        percentileResults[wipCol] = Number(
                            sortedTimes[arrayIndex].toFixed(3),
                        );
                    } else {
                        const lower = sortedTimes[Math.floor(arrayIndex)];
                        const upper = sortedTimes[Math.ceil(arrayIndex)];
                        percentileResults[wipCol] = Number(
                            (
                                lower +
                                (upper - lower) *
                                    (arrayIndex - Math.floor(arrayIndex))
                            ).toFixed(3),
                        );
                    }
                }
            });

            return percentileResults;
        } catch (error) {
            console.log('Error calculating lead time by column', error);
            return {};
        }
    }
    processLeadTimeByColumnTeamAndPeriod(
        data: any,
        columnsConfigKey: any,
        timezone = Timezone.DEFAULT_TIMEZONE,
    ) {
        const transformed = [];

        data.forEach((metric, index) => {
            let entry = {
                date: moment(metric?.utcDate).tz(timezone).format('DD/MM/YY'),
                chartDate: moment(metric?.utcDate)
                    .tz(timezone)
                    .format('YYYY-MM-DD'),
                order: index + 1,
            };

            // Maintaining the order of columns according to their position in the columnsConfigKey array
            const orderedColumns = columnsConfigKey
                .filter((column) => metric.original.hasOwnProperty(column.name))
                .map((column, index) => ({ ...column, index })) // Add the index to the object
                .sort((a, b) => a.index - b.index); // Sort by index

            // Adding the values in the correct order
            orderedColumns.forEach((column) => {
                const hours = metric.original[column.name];
                if (typeof hours !== 'number') {
                    console.error(
                        `Expected a number for hours, received ${typeof hours}`,
                    );
                } else {
                    entry[column.name] = hours / 24;
                }
            });

            transformed.push(entry);
        });

        return transformed;
    }
}

export { LeadTimeByColumnCalculator };
