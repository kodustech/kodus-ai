export function metricDictionary(metric) {
    const metrics = {
        leadTime:
            'The time in hours for a task to move from the Ready To Do column to the DONE column.',
        throughput: 'Number of items delivered in the last days.',
        bugRatio:
            'Number of bugs in WIP divided by the number of total tasks in WIP.',
        leadTimeInWip:
            'The time in hours for a task to move from the first WIP column to the DONE column.',
        leadTimeByColumn:
            'The time in hours tasks take in each column, looking at the 75th percentile',
        predictedDeliveryDates:
            'Delivery date for each item predict based on lead time.',

        // Dora Metrics
        deployFrequency:
            "Number of deployments to production per specified time period, used to assess the efficiency and frequency of a team's release process.",
    };

    return metrics[metric];
}
