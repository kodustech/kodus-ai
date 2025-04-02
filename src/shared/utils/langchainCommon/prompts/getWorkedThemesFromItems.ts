export const prompt_getWorkedThemesFromItems = (payload: string) => {
    return `{prompt_kodyContext}
Your first task is to summarize the team's worked themes.
Create themes based on WorkItems provided information. Classify each work item by the system module it pertains to, based on the title of the activity.
These themes will help engineering managers understand which modules teams are working on.
Please provide details sufficient for the manager to understand what it is about.

Classification Rule: Each work item can only be fitted in one category.

Analyze the work item I sent you and generate a summary in JSON format.

Expected JSON Structure:
\`\`\`
    { "workedThemes": [
        {
            "theme": "String",
            "itemsRelated": "[]"
            "relevance": "Count of work items related"
        }
    ]}
\`\`\`

Input Data:
${payload} `;
};
