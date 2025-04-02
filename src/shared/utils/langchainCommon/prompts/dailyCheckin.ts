export const prompt_dailyCheckin_workItemsInWipWithDeliveryStatus = (
    payload: string,
) => {
    return `{prompt_kodyContext}
    Analyze input data from team board WorkItems and generate a simplified summary in JSON format.

    Input JSON Structure:
    \`\`\`
        { "workItemsInWipFiltered": [
            {
                "key": "String",
                "title": "String",
                "summary": "String",
                "leadTimeToEndWithLeadTimeAlreadyUsed": "Number",
                "estimatedDeliveryDate": "String",
                "deliveryStatusFlag": "String",
                "isLate": "Boolean"
            }
        ]}
    \`\`\`

    Output JSON structure:
    \`\`\`
        { "deliveryStatusForWorkItemsInWip": [
            {
                "key": "String",
                "title": "String",
                "summary": "String",
                "leadTimeToEndWithLeadTimeAlreadyUsed": "Number",
                "estimatedDeliveryDate": "String",
                "deliveryStatusFlag": "String",
                "isLate": "Boolean"
            }
        ]}
    \`\`\`

    Description of input JSON properties:
    - key: work item identification key,
    - title: title of the work item,
    - summary: In this case I want you to rewrite the message so that the user does not always receive the same text. but never change numerical data or invent data, just rewrite the information.
    - estimatedDeliveryDate: estimation date

    All the data you have is in the input object called workItemsFiltered.

    All items in the input object must always be in the output object.

    Input:
${payload}`;
};

export const prompt_dailyCheckin_warnings = (payload: any) => {
    return `{prompt_kodyContext}
    Your mission is to generate alerts for a software engineering team based on historical data from the team.

    Input information you will receive:

    # mostRecentArtifacts
    - Most recent alerts from the team, which are the focus of the notification: ${JSON.stringify(payload.mostRecentArtifacts)}

    # previousArtifacts
    - Historical data from the team: ${JSON.stringify(payload.previousArtifacts)}
    This data should not be used to generate alerts, but can be useful for comparison.

    Output JSON object structure:
    \`\`\`
    {
    "warnings": [
    {
    "title": "Title of the Point of Attention", // String

    "description": "" // String

    "relatedWorkItems": [{key: "", name: ""}]
    }]
    }
    \`\`\`

    Purpose:
    - Your description should be advisory, informative and objective.
    - Use only the data from the input objects to generate alerts, never invent data.
    - Each alert must contain a description with a maximum of 200 characters.
    - Whenever sending a date, use the format dd/mm/yyyy

    Today is ${payload.todayDate}
    `;
};

export const prompt_dailyCheckin_changelog = (payload: string) => {
    return `{prompt_kodyContext}
Develop a process that analyzes the input data of team members' and generates a simplified summary in JSON format.
This summary should focus on the team members, listing their names and summarizing the activities, including status changes, new assignments, tasks in development, and task priority updates.

Expected JSON Structure:
\`\`\`
    { members: [
        {
            member: 'Member Name',
            summary: '', //Try to keep under 350 characters
        }
    ]}
\`\`\`

Instructions:
Focus on activities changed in the last 24 hours for each member and activities in WIP for each member.
The "Summary" should be a resume of tasks the member worked on or is working on, with details on the key updates for each task.
Always include activities that members are currently working on in the Summary.
For that, you should look at the filteredWipWorkItems or last24WorkItems input object.
Updates should be clear and concise to facilitate a quick understanding of progress.

Goal:
To provide a clear and straightforward summary of each team member's daily contributions, highlighting the main activities and changes, to support effective communication and alignment of the team in an asynchronous standup format.
Input:
${payload}`;
};
