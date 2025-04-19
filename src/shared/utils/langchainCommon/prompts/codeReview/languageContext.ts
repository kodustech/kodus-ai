export const prompt_languageContext = (payload: {
    languageName: string;
    detectedLibraries: { name: string; description: string }[];
    libraryContexts: { name: string; description: string }[];
    languageBestPractices: string;
}) => {
    return `
# Language Context Module

## How to Use This Context
This language-specific context provides insights about the programming language, frameworks, and libraries detected in the code. When reviewing the code:
- Apply language-specific idioms and best practices instead of patterns from similar languages
- Consider framework-specific conventions when suggesting improvements
- Prioritize library-recommended approaches over generic solutions
- Refer to these contexts when evaluating potential issues or suggesting optimizations

## Language Identification
${payload.languageName}

## Detected Libraries and Frameworks
${payload.detectedLibraries.map((lib) => `- ${lib.name}`).join('\n')}

## Library-Specific Context
${payload.libraryContexts
    .map(
        (context) =>
            `### ${context.name}
${context.description}`,
    )
    .join('\n\n')}

## Language Best Practices
${payload.languageBestPractices}
    `;
};
