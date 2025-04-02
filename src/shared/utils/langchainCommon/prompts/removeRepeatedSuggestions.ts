export const prompt_removeRepeatedSuggestions = (payload: any) => {
    return `
    <Context>
Below are two lists: one contains saved suggestions from history (already applied or sent previously), and the other contains newly generated suggestions.
Your task is to analyze each new suggestion and decide if it should be kept or discarded, based on the following rules:
</Context>
<DecisionRules>xq
- Contradiction: If a new suggestion contradicts an existing one in the history (e.g., it suggests reverting or invalidating a previously applied suggestion), discard it.
- Duplicate in a Different Context: If a new suggestion is similar to a saved one but applies to a different part of the code, keep it.
- Unrelated: If a new suggestion has no relation to any saved suggestions, keep it.
</DecisionRules>
<OutputRequirements>
For each new suggestion, return a JSON object containing: - The **id** of the suggestion. - A **decision** field indicating if the suggestion should be \`"keep"\` or \`"discard"\`. - A **reason** explaining why the suggestion was kept or discarded.
Return in JSON format.
</OutputRequirements>
<OutputFormat>
\`\`\`
{ "suggestions": [ { "id": "<suggestion_id>", "decision": "<keep|discard>", "reason": "<clear and concise explanation>" } ]}
\`\`\`
</OutputFormat>

<SavedSuggestions>
\`\`\`
${JSON.stringify(payload.savedSuggestions)}
\`\`\`
</SavedSuggestions>
<NewlyGeneratedSuggestions>
\`\`\`
${JSON.stringify(payload.newSuggestions)}
\`\`\`
</NewlyGeneratedSuggestions>
    `;
};
