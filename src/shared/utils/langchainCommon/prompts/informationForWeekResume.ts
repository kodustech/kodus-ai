export const prompt_releaseNotes = (payload: any) => {
    return `You are Kody, a software development specialist. Your responses should be done using a friendly tone as if chatting with your team in the company chat.

Your goal is to create friendly and informative release notes.

Analyze the provided JSON data to categorize tasks and pull requests into distinct modules or categories. Each category should be based on the tasks' specific characteristics, descriptions, and changelogs in the dataset. Generate an output as an array of objects. Each object must represent a unique category or module derived from the data analysis. Include four key-value pairs in each object: 'categoryName' for the name of the category (based on the analysis), 'description' for a detailed overview of the tasks and their nature within that category (drawn from the data), 'itemsRelated' as an array of task identifiers that belong to that category, and 'changelog' detailing the recent developments or changes specific to that category.

Avoid generic or replicated content; ensure that the analysis and summaries are tailored to the exact data provided.

The output should follow this structure (note that the content should be based on your data analysis, not these examples):

\`\`\`[ "categories": { "categoryName": "Identified Category 1", "description": "Detailed description based on the analysis of tasks in this category, covering what these tasks encompass and their significance.", "itemsRelated": [{"type": "pr", "id": "pr id"}, {"type": "workItem", "id": "workItem key"}], "changelog": "Summary of recent updates or changes in this category, as derived from the task data." }, ... ]\`\`\`

JSON INPUT
\`\`\`${payload}\`\`\`

Important guidelines:

1. Write all descriptions and changelogs. Focus on the impact and benefits of each change at the same time as intuitive to understand what is about.
2. Do not be broad in categoryName
3. Use a friendly and informal tone, typical of Brazilian dev teams.
4. Focus on highlighting the most important improvements and new features for end users.
5. Keep the language clear and accessible, avoiding overly technical jargon unless necessary.
6. Use common expressions and terms used in software development in Brazil.
7. Return only the JSON structure
8. If you do not have enough information to generate release notes return an empty array
`;
};

export const prompt_getMessageInformationForWeekResume = (payload: any) => {
    return `{prompt_kodyContext}

    Analyze the provided JSON data to categorize the tasks into distinct modules or categories. Each category should be based on the tasks' specific characteristics, descriptions, and changelogs in the dataset. Generate an output as an array of objects. Each object must represent a unique category or module derived from the data analysis. Include four key-value pairs in each object: 'categoryName' for the name of the category (based on the analysis), 'description' for a detailed overview of the tasks and their nature within that category (drawn from the data), 'tasks' as an array of task identifiers that belong to that category, and 'changelog' detailing the recent developments or changes specific to that category. Avoid generic or replicated content; ensure that the analysis and summaries are tailored to the specific data provided.

    Please try to fit all issues into at max 3 categories.

    The output should follow this structure (note that the content should be based on your data analysis, not these examples):

    \`\`\`
    [ "categories":
        {
        "categoryName": "Identified Category 1",
        "description": "Detailed description based on the analysis of tasks in this category, covering what these tasks encompass and their significance.",
        "tasks": ["Task Identifier 1", "Task Identifier 2"],
        "changelog": "Summary of recent updates or changes in this category, as derived from the task data."
        },
        ...
    ]\`\`\`

    JSON INPUT
    \`\`\`
    ${payload}
    \`\`\`
`;
};

export const prompt_weeklyCheckin_changelog = (payload: string) => {
    return `{prompt_kodyContext}
    Analyze input data from team board WorkItems and generate a simplified summary in JSON format.

    Input JSON Structure:
    \`\`\`
        {workItemsFiltered: [
            {
                key: 'workItem identification key',
                title: 'work item title',
                isLate: 'informs whether the activity is onTrack (false value) or offTrack (true value)',
                onTrackFlag: 'emoji to represent result',
                summary: 'informs how late an activity is and what is the projection for it to be completed'
               changelog: 'history of movements and changes to the workitem card on the board'
            }
        ]}
    \`\`\`

    Output JSON structure:
    \`\`\`
        {workItems: [
            {
                key: ' '
                title: ' '
                summary: 'In this case I want you to rewrite the message so that the user does not always receive the same text. but never change numerical data or invent data, just rewrite the information.'
                onTrackFlag: ' '
            }
        ]}
    \`\`\`

    Instructions:
    Focus on keeping your team informed about what's on or behind schedule, using the input data you have access to.

    All the data you have is in the input object named workItemsFiltered.

    Regarding the summary, remember that they must be clear and concise to facilitate quick understanding of progress.

    Input:
${payload}`;
};
