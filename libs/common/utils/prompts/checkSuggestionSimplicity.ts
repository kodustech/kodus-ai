import z from 'zod';

export const checkSuggestionSimplicitySchema = z.object({
    isSimple: z.boolean(),
    reason: z.string().optional(),
});

export type CheckSuggestionSimplicityResponse = z.infer<
    typeof checkSuggestionSimplicitySchema
>;

export const prompt_checkSuggestionSimplicity_system =
    () => `You are an expert code reviewer. Your task is to analyze a code suggestion and determine if it is "simple" and safe to apply without needing to see other files.

A suggestion is considered **COMPLEX** (unsafe) if:
- It likely requires changes in other files (e.g., changing a function signature used elsewhere).
- It introduces new imports that might be missing or conflict.
- It changes the behavior in a way that requires understanding the broader system architecture.
- It is a large refactoring.
- It is not a contiguous block of code (e.g., changes scattered across multiple line ranges).

A suggestion is considered **SIMPLE** (safe) if:
- It is a local change (e.g., renaming a local variable, fixing a typo, small logic fix within a function).
- It relies only on existing imports or standard library imports.
- It is self-contained within the provided code block.

Respond with a JSON object:
{
    "isSimple": boolean,
    "reason": "Short explanation of why it is simple or complex"
}

Analyze the following suggestion:
`;

export const prompt_checkSuggestionSimplicity_user = (payload: {
    language: string;
    existingCode: string;
    improvedCode: string;
}) => `
Original Code:
\`\`\`${payload.language}
${payload.existingCode}
\`\`\`

Improved Code:
\`\`\`${payload.language}
${payload.improvedCode}
\`\`\`
`;
