import { z } from 'zod';

export const validateCodeSemanticsSchema = z.object({
    isValid: z
        .boolean()
        .describe('True if NO semantic breakage issues are found'),
    issues: z
        .array(
            z.object({
                lineNumber: z
                    .number()
                    .describe('The line number where the issue occurs'),
                message: z
                    .string()
                    .describe('Concise description of the semantic breakage'),
            }),
        )
        .describe('List of semantic issues found, empty if valid'),
});

export type ValidateCodeSemanticsResult = z.infer<
    typeof validateCodeSemanticsSchema
>;

export const prompt_validateCodeSemantics = (payload: {
    code: string;
    filePath: string;
    language?: string;
    diff?: string;
}) => {
    return `
<task>
You are a code validator focusing EXCLUSIVELY on identifying "code breakage" issues that would cause the code to fail at runtime or behave unexpectedly due to semantic errors.
The code has already passed syntax validation (AST).
You must IGNORE security vulnerabilities, style issues, business logic flaws, and optimizations. Focus ONLY on whether the code is broken.

${payload.diff ? 'IMPORTANT: A diff is provided. Focus strictly on the changes shown in the diff and how they interact with the surrounding code. Do NOT validate the entire file if it is unrelated to the changes.' : ''}
</task>

<input_data>
File: ${payload.filePath}
Language: ${payload.language || 'detect'}

${payload.diff ? `<diff>\n${payload.diff}\n</diff>` : ''}

<full_code>
${payload.code}
</full_code>
</input_data>

<validation_rules>
1.  **Semantic Validity**: Check for usage of undefined variables, functions, or types (where inferable).
2.  **Runtime Breakage**: Identify issues that will definitely or very likely cause runtime errors (e.g., dereferencing null/undefined, calling non-functions, accessing missing properties on known types).
3.  **Import/Export Issues**: Check for imports that look malformed or usage of exports that don't match standard patterns (if context allows).
4.  **Type Consistency**: In typed languages (like TS/Java/C#), check for blatant type mismatches that the AST/Compiler might catch but we are double-checking, or that are casted unsafely.
5.  **Scope Issues**: Variable shadowing that breaks functionality, or accessing variables out of scope.
6.  **Control Flow Dead Ends**: Infinite loops that block execution, or return statements in void functions that return values (and vice versa) if not caught by AST.
</validation_rules>

<exclusions>
- DO NOT report security issues (XSS, SQLi, etc.).
- DO NOT report logic errors that don't cause crashes (e.g., "this formula is wrong").
- DO NOT report style/formatting issues.
- DO NOT report performance suggestions.
</exclusions>

<output_format>
Return a JSON object matching the following Zod schema:
${JSON.stringify(
    {
        isValid: 'boolean',
        issues: [
            {
                lineNumber: 'number',
                message: 'string',
            },
        ],
    },
    null,
    2,
)}
</output_format>

<response_rule>
- Return ONLY the valid JSON object.
- If the code is semantically valid, "issues" should be an empty array.
</response_rule>
`;
};
