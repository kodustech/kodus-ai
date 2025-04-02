export const METRICS_STRUCTURE_DATA = {
    metrics_glossary: {
        leadTime: {
            'metricType': 'Metric type identifier',
            'date': 'Date the metric was calculated',
            'original.columns':
                'Array containing objects with information and calculations for each board column',
            'original.columns.column':
                'Name of the column where the calculations were made',
            'original.columns.average':
                'Average calculation for the specific column',
            'original.columns.percentile':
                'Object containing all calculation percentiles for the specific column',
            'original.columns.percentile.p50':
                '50th percentile (median) calculation for the specific column',
            'original.columns.percentile.p75':
                '75th percentile calculation for the specific column',
            'original.columns.percentile.p85':
                '85th percentile calculation for the specific column',
            'original.columns.percentile.p95':
                '95th percentile calculation for the specific column',
            'original.total':
                'Object with the total result of leadTime, aggregating the percentiles across all columns',
            'original.total.average':
                'Overall average calculation for lead time',
            'original.total.percentiles':
                'Object containing all calculation percentiles for total lead time',
            'original.total.percentiles.p50':
                '50th percentile (median) calculation for total lead time',
            'original.total.percentiles.p75':
                '75th percentile calculation for total lead time',
            'original.total.percentiles.p85':
                '85th percentile calculation for total lead time',
            'original.total.percentiles.p95':
                '95th percentile calculation for total lead time',
            'original.total.sum': 'Total sum calculation for lead time',
            'differences':
                'Array of objects containing difference calculations between the current and previous dates',
            'differences.date': 'Date the difference was calculated',
            'differences.difference.date':
                'Date of the comparison point for the difference calculation',
            'differences.difference.total':
                'Object containing the difference calculations for total lead time',
            'differences.difference.total.average':
                'Difference in the overall average calculation for lead time',
            'differences.difference.total.percentiles':
                'Object containing all difference calculations for total lead time percentiles',
            'differences.difference.total.percentiles.p50':
                'Difference in the 50th percentile (median) calculation for total lead time',
            'differences.difference.total.percentiles.p75':
                'Difference in the 75th percentile calculation for total lead time',
            'differences.difference.total.percentiles.p85':
                'Difference in the 85th percentile calculation for total lead time',
            'differences.difference.total.percentiles.p95':
                'Difference in the 95th percentile calculation for total lead time',
            'differences.difference.total.sum':
                'Difference in the total sum calculation for lead time',
            'differences.difference.columns':
                'Array of objects containing difference calculations for each column',
            'differences.difference.columns.column':
                'Name of the column where the difference calculations were made',
            'differences.difference.columns.averageDifference':
                'Difference in the average calculation for the specific column',
            'differences.difference.columns.percentileDifferences':
                'Object containing all difference calculations for the specific column percentiles',
            'differences.difference.columns.percentileDifferences.p50':
                'Difference in the 50th percentile (median) calculation for the specific column',
            'differences.difference.columns.percentileDifferences.p75':
                'Difference in the 75th percentile calculation for the specific column',
            'differences.difference.columns.percentileDifferences.p85':
                'Difference in the 85th percentile calculation for the specific column',
            'differences.difference.columns.percentileDifferences.p95':
                'Difference in the 95th percentile calculation for the specific column',
            'differences.original':
                'Object containing the original calculations for lead time before the difference',
            'differences.original.total':
                'Object with the total original calculations for lead time',
            'differences.original.total.sum':
                'Original total sum calculation for lead time before the difference',
            'differences.original.total.average':
                'Original overall average calculation for lead time before the difference',
            'differences.original.total.percentiles':
                'Object containing all original calculations for total lead time percentiles before the difference',
            'differences.original.total.percentiles.p50':
                'Original 50th percentile (median) calculation for total lead time before the difference',
            'differences.original.total.percentiles.p75':
                'Original 75th percentile calculation for total lead time before the difference',
            'differences.original.total.percentiles.p85':
                'Original 85th percentile calculation for total lead time before the difference',
            'differences.original.total.percentiles.p95':
                'Original 95th percentile calculation for total lead time before the difference',
            'differences.original.columns':
                'Array of objects containing the original calculations for each column before the difference',
            'differences.original.columns.column':
                'Name of the column where the original calculations were made',
            'differences.original.columns.average':
                'Original average calculation for the specific column before the difference',
            'differences.original.columns.percentile':
                'Object containing all original calculations for the specific column percentiles before the difference',
            'differences.original.columns.percentile.p50':
                'Original 50th percentile (median) calculation for the specific column before the difference',
            'differences.original.columns.percentile.p75':
                'Original 75th percentile calculation for the specific column before the difference',
            'differences.original.columns.percentile.p85':
                'Original 85th percentile calculation for the specific column before the difference',
            'differences.original.columns.percentile.p95':
                'Original 95th percentile calculation for the specific column before the difference',
            'description':
                'The time in hours for a task to move from the Ready To Do column to the DONE column',
            'utcDate':
                'Timestamp of when the data was last updated in UTC format',
        },
        leadTimeInWip: {
            'metricType': 'Type of the metric (leadTimeInWip)',
            'date': 'Date when the metric was calculated',
            'original.total.average':
                'Overall average calculation for lead time in WIP',
            'original.total.percentiles':
                'Object containing all calculation percentiles for lead time in WIP',
            'original.total.percentiles.p50':
                '50th percentile (median) calculation for lead time in WIP',
            'original.total.percentiles.p75':
                '75th percentile calculation for lead time in WIP',
            'original.total.percentiles.p85':
                '85th percentile calculation for lead time in WIP',
            'original.total.percentiles.p95':
                '95th percentile calculation for lead time in WIP',
            'original.total.sum': 'Total sum calculation for lead time in WIP',
            'original.total.deviation':
                'Object containing deviation information for lead time in WIP',
            'original.total.deviation.value': 'Deviation value from the mean',
            'original.total.deviation.level': 'Severity level of the deviation',
            'differences':
                'Array of objects containing difference calculations between the current and previous dates',
            'differences.date': 'Date the difference was calculated',
            'differences.difference.date':
                'Date of the comparison point for the difference calculation',
            'differences.difference.total':
                'Object containing the difference calculations for total lead time in WIP',
            'differences.difference.total.average':
                'Difference in the overall average calculation for lead time in WIP',
            'differences.difference.total.percentiles':
                'Object containing all difference calculations for lead time in WIP percentiles',
            'differences.difference.total.percentiles.p50':
                'Difference in the 50th percentile (median) calculation for lead time in WIP',
            'differences.difference.total.percentiles.p75':
                'Difference in the 75th percentile calculation for lead time in WIP',
            'differences.difference.total.percentiles.p85':
                'Difference in the 85th percentile calculation for lead time in WIP',
            'differences.difference.total.percentiles.p95':
                'Difference in the 95th percentile calculation for lead time in WIP',
            'differences.difference.total.sum':
                'Difference in the total sum calculation for lead time in WIP',
            'differences.difference.total.deviation':
                'Object containing deviation information for the difference in lead time in WIP',
            'differences.difference.total.deviation.value':
                'Difference in deviation value from the mean',
            'differences.difference.total.deviation.level':
                'Difference in the severity level of the deviation',
            'differences.original.total':
                'Object containing the original calculations for lead time in WIP before the difference',
            'differences.original.total.sum':
                'Original total sum calculation for lead time in WIP before the difference',
            'differences.original.total.average':
                'Original overall average calculation for lead time in WIP before the difference',
            'differences.original.total.deviation':
                'Object containing deviation information for lead time in WIP before the difference',
            'differences.original.total.deviation.value':
                'Original deviation value from the mean before the difference',
            'differences.original.total.deviation.level':
                'Original severity level of the deviation before the difference',
            'differences.original.total.percentiles':
                'Object containing all original calculations for lead time in WIP percentiles before the difference',
            'differences.original.total.percentiles.p50':
                'Original 50th percentile (median) calculation for lead time in WIP before the difference',
            'differences.original.total.percentiles.p75':
                'Original 75th percentile calculation for lead time in WIP before the difference',
            'differences.original.total.percentiles.p85':
                'Original 85th percentile calculation for lead time in WIP before the difference',
            'differences.original.total.percentiles.p95':
                'Original 95th percentile calculation for lead time in WIP before the difference',
            'description':
                'The time in hours for a task to move from the first WIP column to the DONE column',
            'utcDate':
                'Timestamp of when the data was last updated in UTC format',
        },
        leadTimeByColumn: {
            'metricType': 'Type of the metric (leadTimeByColumn)',
            'date': 'Date when the metric was calculated',
            'original.Ready To Do':
                "Lead time for tasks in the 'Ready To Do' column",
            'original.In Progress':
                "Lead time for tasks in the 'In Progress' column",
            'original.Waiting For Homolog':
                "Lead time for tasks in the 'Waiting For Homolog' column",
            'original.In Homolog':
                "Lead time for tasks in the 'In Homolog' column",
            'original.Ready To Deploy':
                "Lead time for tasks in the 'Ready To Deploy' column",
            'differences':
                'Array of objects containing difference calculations between the current and previous dates',
            'differences.date': 'Date the difference was calculated',
            'differences.difference.date':
                'Date of the comparison point for the difference calculation',
            'differences.difference.Ready To Do':
                "Difference in lead time for tasks in the 'Ready To Do' column",
            'differences.difference.In Progress':
                "Difference in lead time for tasks in the 'In Progress' column",
            'differences.difference.Waiting For Homolog':
                "Difference in lead time for tasks in the 'Waiting For Homolog' column",
            'differences.difference.In Homolog':
                "Difference in lead time for tasks in the 'In Homolog' column",
            'differences.difference.Ready To Deploy':
                "Difference in lead time for tasks in the 'Ready To Deploy' column",
            'differences.original.In Homolog':
                "Original lead time for tasks in the 'In Homolog' column before the difference",
            'differences.original.In Progress':
                "Original lead time for tasks in the 'In Progress' column before the difference",
            'differences.original.Ready To Do':
                "Original lead time for tasks in the 'Ready To Do' column before the difference",
            'differences.original.Ready To Deploy':
                "Original lead time for tasks in the 'Ready To Deploy' column before the difference",
            'differences.original.Waiting For Homolog':
                "Original lead time for tasks in the 'Waiting For Homolog' column before the difference",
            'description':
                'The time in hours tasks take in each column, looking at the 75th percentile',
            'utcDate':
                'Timestamp of when the data was last updated in UTC format',
        },
        throughput: {
            'metricType': 'Type of the metric (throughput)',
            'date': 'Date when the metric was calculated',
            'original.value': 'Number of items delivered',
            'differences':
                'Array of objects containing difference calculations between the current and previous dates',
            'differences.date': 'Date the difference was calculated',
            'differences.difference.date':
                'Date of the comparison point for the difference calculation',
            'differences.difference.value':
                'Difference in the number of items delivered',
            'differences.original.value':
                'Original number of items delivered before the difference',
            'description': 'Number of items delivered in the last days',
            'utcDate':
                'Timestamp of when the data was last updated in UTC format',
        },
        bugRatio: {
            'metricType': 'Type of the metric (bugRatio)',
            'date': 'Date when the metric was calculated',
            'original.value':
                'Bug ratio value (number of bugs in WIP divided by the number of total tasks in WIP)',
            'differences':
                'Array of objects containing difference calculations between the current and previous dates',
            'differences.date': 'Date the difference was calculated',
            'differences.difference.date':
                'Date of the comparison point for the difference calculation',
            'differences.difference.value': 'Difference in the bug ratio value',
            'differences.original.value':
                'Original bug ratio value before the difference',
            'description':
                'Number of bugs in WIP divided by the number of total tasks in WIP',
            'utcDate':
                'Timestamp of when the data was last updated in UTC format',
        },
        leadTimeInWipByItemType: {
            'metricType': 'Metric type identifier (leadTimeInWipByItemType)',
            'date': 'Date the metric was calculated',
            'original.IssuesTypes':
                'Object containing calculations for different issue types, which can vary by client',
            'original.IssuesTypes.[ItemType].average':
                'Average lead time for the specific issue type',
            'original.IssuesTypes.[ItemType].percentiles':
                'Object containing percentiles for the specific issue type',
            'original.IssuesTypes.[ItemType].percentiles.p50':
                '50th percentile (median) for the specific issue type',
            'original.IssuesTypes.[ItemType].percentiles.p75':
                '75th percentile for the specific issue type',
            'original.IssuesTypes.[ItemType].percentiles.p95':
                '95th percentile for the specific issue type',
            'original.IssuesTypes.[ItemType].sum':
                'Sum of lead times for the specific issue type',
            'original.IssuesTypes.[ItemType].percentageOfTotal':
                'Percentage of total lead time for the specific issue type',
            'differences':
                'Array of objects containing difference calculations between the current and previous dates',
            'differences.date': 'Date the difference was calculated',
            'differences.difference.date':
                'Date of the comparison point for the difference calculation',
            'differences.difference.IssuesTypes.[ItemType].average':
                'Difference in the average lead time for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].percentiles':
                'Object containing difference calculations for the specific issue type percentiles',
            'differences.difference.IssuesTypes.[ItemType].percentiles.p50':
                'Difference in the 50th percentile (median) for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].percentiles.p75':
                'Difference in the 75th percentile for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].percentiles.p95':
                'Difference in the 95th percentile for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].sum':
                'Difference in the sum of lead times for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].percentageOfTotal':
                'Difference in the percentage of total lead time for the specific issue type',
            'differences.original.IssuesTypes.[ItemType].average':
                'Original average lead time for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].percentiles':
                'Object containing original calculations for the specific issue type percentiles before the difference',
            'differences.original.IssuesTypes.[ItemType].percentiles.p50':
                'Original 50th percentile (median) for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].percentiles.p75':
                'Original 75th percentile for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].percentiles.p95':
                'Original 95th percentile for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].sum':
                'Original sum of lead times for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].percentageOfTotal':
                'Original percentage of total lead time for the specific issue type before the difference',
            'description':
                'The time in hours for a task to move from the first WIP column to the DONE column',
            'utcDate':
                'Timestamp of when the data was last updated in UTC format',
        },
        leadTimeByItemType: {
            'metricType': 'Metric type identifier (leadTimeByItemType)',
            'date': 'Date the metric was calculated',
            'original.IssuesTypes':
                'Object containing calculations for different issue types, which can vary by client',
            'original.IssuesTypes.[ItemType].average':
                'Average lead time for the specific issue type',
            'original.IssuesTypes.[ItemType].percentiles':
                'Object containing percentiles for the specific issue type',
            'original.IssuesTypes.[ItemType].percentiles.p50':
                '50th percentile (median) for the specific issue type',
            'original.IssuesTypes.[ItemType].percentiles.p75':
                '75th percentile for the specific issue type',
            'original.IssuesTypes.[ItemType].percentiles.p95':
                '95th percentile for the specific issue type',
            'original.IssuesTypes.[ItemType].sum':
                'Sum of lead times for the specific issue type',
            'original.IssuesTypes.[ItemType].percentageOfTotal':
                'Percentage of total lead time for the specific issue type',
            'differences':
                'Array of objects containing difference calculations between the current and previous dates',
            'differences.date': 'Date the difference was calculated',
            'differences.difference.date':
                'Date of the comparison point for the difference calculation',
            'differences.difference.IssuesTypes.[ItemType].average':
                'Difference in the average lead time for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].percentiles':
                'Object containing difference calculations for the specific issue type percentiles',
            'differences.difference.IssuesTypes.[ItemType].percentiles.p50':
                'Difference in the 50th percentile (median) for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].percentiles.p75':
                'Difference in the 75th percentile for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].percentiles.p95':
                'Difference in the 95th percentile for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].sum':
                'Difference in the sum of lead times for the specific issue type',
            'differences.difference.IssuesTypes.[ItemType].percentageOfTotal':
                'Difference in the percentage of total lead time for the specific issue type',
            'differences.original.IssuesTypes.[ItemType].average':
                'Original average lead time for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].percentiles':
                'Object containing original calculations for the specific issue type percentiles before the difference',
            'differences.original.IssuesTypes.[ItemType].percentiles.p50':
                'Original 50th percentile (median) for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].percentiles.p75':
                'Original 75th percentile for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].percentiles.p95':
                'Original 95th percentile for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].sum':
                'Original sum of lead times for the specific issue type before the difference',
            'differences.original.IssuesTypes.[ItemType].percentageOfTotal':
                'Original percentage of total lead time for the specific issue type before the difference',
            'description':
                'The time in hours tasks take in each column, looking at the 75th percentile',
            'utcDate':
                'Timestamp of when the data was last updated in UTC format',
        },
    },
};
