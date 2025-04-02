interface MetricDetail {
    type: string;
    whatIsIt: string;
    explanationForTeams: string;
    explanationForOrganizations: string;
}

interface MetricsData {
    metrics: MetricDetail[];
}

const metricsExplanation: MetricsData = {
    metrics: [
        {
            type: 'throughput',
            whatIsIt:
                "Throughput measures a team's delivery capacity over a given period. In other words, how many items were delivered to production by the team in a week, fortnight, or month. In our system, we record the delivery history weekly, which helps provide good visibility into the team's delivery pace and can also assist in demand delivery predictability. It's important to remember that isolated metrics do not provide a complete understanding of the scenario, so it's always important to analyze other metrics. However, a throughput with high variation (e.g., one week the team delivers 3 items and the next 15) can be a clear sign that the workflow, backlog management, or task breakdown needs adjustment.",
            explanationForTeams:
                "Every Sunday at the end of the day, the system runs a routine that analyzes the team's board and records in the database how many activities were delivered in the last week (since the last routine execution, the previous Sunday). Whenever the dashboard is accessed, we highlight the current week's metric and compare it with the previous week's result.",
            explanationForOrganizations:
                "Every week, we run a routine that analyzes the metrics recorded for each team in the organization, calculate a weighted average, and save it in the database. Whenever the dashboard is accessed, we highlight the current week's metric and compare it with the previous week's result. This provides an overview of overall performance. But be careful when looking at consolidated metrics for all teams; remember that teams have different workflows and tasks that can be broken down into different sizes. To get a better idea of overall performance, it's worth looking at each team's metrics individually.",
        },
        {
            type: 'leadTime',
            whatIsIt:
                "Lead Time measures the total time required for an activity to move from stage X to stage Y on the board. It accounts for the time from when the activity entered the TO DO phase (when it's available for the team to work on) until it was made available in production. This metric is consolidated considering the total time each activity spent in each stage of the board. It's important to remember that isolated metrics do not provide a complete understanding of the scenario, so it's always important to analyze other metrics. But looking at Lead Time weekly can help understand the team's pace and whether the flow is slower or faster. By looking at Lead Time by column (we have this chart on the team dashboards), it's possible to identify stages that are bottlenecks in the process.",
            explanationForTeams:
                "Every Sunday at the end of the day, the system runs a routine that analyzes the movement of tasks on the team's board and records in the database the time each activity spent in each stage of the board (since the last routine execution, the previous Sunday). For a more realistic analysis, we consider the 75th percentile of Lead Time, i.e., how much time was spent in each column by 75% of the activities worked on by the team. Whenever the dashboard is accessed, we highlight the current week's metric and compare it with the previous week's result.",
            explanationForOrganizations:
                "Every week, we run a routine that analyzes the metrics recorded for each team in the organization, calculate a weighted average, and save it in the database. Whenever the dashboard is accessed, we highlight the current week's metric and compare it with the previous week's result. This provides an overview of overall performance. But be careful when looking at consolidated metrics for all teams; remember that teams have different workflows and tasks that can be broken down into different sizes. To get a better idea of overall performance, it's worth looking at each team's metrics individually.",
        },
        {
            type: 'leadTimeInWip',
            whatIsIt:
                "Lead Time in WIP measures the total time an activity spends on the board, from its entry into WIP until it is published in production. This metric is consolidated considering the total time each activity spent in each WIP stage of the board. It's important to remember that isolated metrics do not provide a complete understanding of the scenario, so it's always important to analyze other metrics. But looking at Lead Time in WIP weekly can help understand the team's pace and whether the flow is slower or faster.",
            explanationForTeams:
                "Every Sunday at the end of the day, the system runs a routine that analyzes the movement of tasks on the team's board and records in the database the time each activity spent in each WIP stage of the board (since the last routine execution, the previous Sunday). For a more realistic analysis, we consider the 75th percentile of Lead Time in WIP, i.e., how much time was spent in each column by 75% of the activities worked on by the team. Whenever the dashboard is accessed, we highlight the current week's metric and compare it with the previous week's result.",
            explanationForOrganizations:
                "Every week, we run a routine that analyzes the metrics recorded for each team in the organization, calculate a weighted average, and save it in the database. Whenever the dashboard is accessed, we highlight the current week's metric and compare it with the previous week's result. This provides an overview of overall performance. But be careful when looking at consolidated metrics for all teams; remember that teams have different workflows and tasks that can be broken down into different sizes. To get a better idea of overall performance, it's worth looking at each team's metrics individually.",
        },
        {
            type: 'bugRatio',
            whatIsIt:
                "Bug ratio is a metric that analyzes how much effort the team has invested in fixing bugs compared to the total activities the team has worked on. This helps understand the quality of development. It's important to remember that isolated metrics do not provide a complete understanding of the scenario, so it's always important to analyze other metrics. But looking at Bug Ratio weekly can help understand whether the quality of deliveries is improving (fewer bugs reported) or worsening (more bugs reported). Additionally, it provides an idea of how the client perceives the software, as a consistently high bug ratio indicates many corrections and fewer new features being delivered, which can affect the perception of value generated.",
            explanationForTeams:
                "Every Sunday at the end of the day, the system runs a routine that analyzes the total activities in WIP on the board during that week. It compares the percentage of bugs in WIP to the total activities in WIP and records it in the database. Whenever the dashboard is accessed, we highlight this same analysis, looking at the current work week and comparing it with the previous week's result.",
            explanationForOrganizations:
                "Every week, we run a routine that analyzes the metrics recorded for each team in the organization, calculate a weighted average, and save it in the database. Whenever the dashboard is accessed, we highlight the current week's metric and compare it with the previous week's result. This provides an overview of overall performance. But be careful when looking at consolidated metrics for all teams; remember that teams have different workflows and tasks that can be broken down into different sizes. To get a better idea of overall performance, it's worth looking at each team's metrics individually.",
        },
        {
            type: 'deployFrequency',
            whatIsIt:
                'Deploy frequency measures how regularly a team can release changes to production. This indicates the agility of the software delivery process, showing how often updates are effectively made available to end users over a given period, such as a week, fortnight, or month. In our system, we record the deployment history weekly, providing visibility into the efficiency and speed of the development lifecycle. Frequent deployments with little variation indicate a stable and predictable development operation.',
            explanationForTeams:
                "Every Sunday at the end of the day, the system runs a routine that analyzes the team's releases and records in the database how many deployments were made in the last week (since the last routine execution, the previous Sunday). When accessing the dashboard, the current week's metric is highlighted and compared with the previous week's result, allowing teams to evaluate their consistency and identify areas that may require attention to improve deployment predictability and efficiency.",
            explanationForOrganizations:
                "Every week, a routine is executed to analyze the deployment metrics of each team in the organization, calculating a weighted average that is stored in the database. Whenever the dashboard is accessed, the current week's metric is highlighted, comparing it with the previous week to provide an overview of the organization's performance. It's important to note that different teams may have varied workflows and task sizes, so for a more accurate assessment of overall performance, it's recommended to examine each team's metrics individually.",
        },
        {
            type: 'leadTimeForChange',
            whatIsIt:
                'Lead Time for Changes measures the time elapsed from the first commit in a development cycle to the implementation of that commit in production. This metric is crucial for evaluating the agility and efficiency of the software development process, as a reduced Lead Time for Changes indicates that the team can quickly deliver new features and fixes to end users.',
            explanationForTeams:
                'Each week, our system calculates the Lead Time for Changes for each deployment made. This is done by identifying the timestamp of the first commit after the last deployment and measuring the interval until that commit is included in a subsequent deployment. These data are automatically collected and presented on the dashboard, allowing teams to visualize how quickly they are moving changes from start to finish.',
            explanationForOrganizations:
                'For organizations, we compile Lead Time for Changes data from all teams and calculate a weighted average. This metric is updated weekly and made available on the organizational dashboard so stakeholders can monitor the efficiency of the development process across the organization. This not only helps identify trends over time but also highlights potential bottlenecks in the process that may require attention to improve delivery speed.',
        },
        {
            type: 'deliveryCapacity',
            whatIsIt:
                "Delivery capacity is a metric that measures a team's ability to deliver new features and fixes to production. It is calculated as the number of new features and fixes delivered to production compared to the rate of new features and fixes entering the board. This metric is important for understanding how healthy the relationship is between new items entering and being delivered.",
            explanationForTeams:
                "Each week, our system calculates the delivery capacity for each team. This is done by identifying the number of new features and fixes delivered to production compared to the number of new features and fixes that entered the board. These data are automatically collected from the team's own board items.",
            explanationForOrganizations:
                'For organizations, we compile delivery capacity data from all teams and calculate a weighted average. This metric is updated weekly and made available on the organizational dashboard so stakeholders can monitor the efficiency of the development process across the organization.',
        },
        {
            type: 'flowEfficiency',
            whatIsIt:
                "Flow efficiency is a metric that measures the efficiency of a team's workflow. It is calculated based on how much time is spent in each column of the board compared to the total Lead Time in WIP. It is important for understanding how healthy the team's workflow is.",
            explanationForTeams:
                "Each week, our system calculates the flow efficiency for each team. This efficiency is calculated based on the total Lead Time in WIP and the time spent in each column of the board. These data are automatically collected from the team's own board items.",
            explanationForOrganizations:
                'For organizations, we compile flow efficiency data from all teams and calculate a weighted average. This metric is updated weekly and made available on the organizational dashboard so stakeholders can monitor the efficiency of the development process across the organization.',
        },
    ],
};

export { metricsExplanation };
