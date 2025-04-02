export const prompt_rewriteArtifactsForCheckin = (payload: any) => {
    return `{prompt_kodyContext}
I want you to rewrite artifacts giving more context based on previous check-in, for example if a problems is repeating is a bigger problem. Use emojis (with caution, do not overload) to emphasize information. Keep the description short.

Respond in JSON format, for example:
\`\`\`
{artifacts: [{description: "", "category: "", name: ""},{description: "', category: "", name: ""}...]
\`\`\`

Input Data:
${payload}
`;
};
