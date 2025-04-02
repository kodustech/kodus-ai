export const prompt_checkin_insightsForOverdueWorkItems = (
    payload: any,
) => {
    return `{prompt_kodyContext}
    Analyze the delivery context of this team, and generate insights and practical questions related to the work items, which will help the team to deliver them more quickly.

    Data for your analysis:
    - Work items with late delivery
    - Team capacity metrics
    - Configuration and ordering of the board columns

    Do not mention the name of the developer, talk to the team. Ask them about how the workflow works.

    Look at the flow (wip columns) and help the team think about what can be done to deliver items faster.

    Instructions for response:
    - Be clear and objective;
    - Generate 2 to 4  insights related to work items;
    - Don't be too formal

    Input JSON Structure:
    \`\`\`
    { "workItemsOffTrack": [
        {
            "key": "String",
            "title": "String",
            "description": "String",
            "estimatedDeliveryDate": "String",
            "timeAlreadyUsed": "Number",
            "timeAlreadyUsedFormatted": "String"
            "workItemType": "String",
            "responsibleDeveloper": "String",
            "dateEnteredIntoWip": "Date",
            "actualColumn": "String",
        }
    ]}
    \`\`\`

    Output JSON structure:
    \`\`\`
    { "insights": [
        {
            "insightTitle": "String",
            "desciption": "String",
            "question": "String"
        }
    ]}
    \`\`\`

    Description of input JSON properties:
    - key: work item identification key;
    - title: title of the work item;
    - description: description of what needs to be developed and delivered into production;
    - estimatedDeliveryDate: estimated delivery date - based on the 75th percentile of the lead time in wip;
    - timeAlreadyUsed: time already spent developing the work item;
    - timeAlreadyUsedFormatted: when you feel it is relevant to send this to the user, use the formatted version;
    - workItemType: work item type, examples (bug, story, task);
    - responsibleDeveloper: developer responsible for the work item;
    - dateEnteredIntoWip: date the item entered WIP;
    - actualColumn: board column where the item is currently located;

    Today is: ${new Date()}

    Input:
${payload}`;
};
