import z from 'zod';
import { getDefaultKodusConfigFile } from '../../validateCodeReviewConfigFile';
import { getTextOrDefault } from './prompt.helpers';

//#region classifier
export const kodyRulesClassifierSchema = z.object({
    rules: z.array(
        z.object({
            uuid: z.string(),
            reason: z.string(),
        }),
    ),
});

//#region classifier
export const kodyRulesGeneratorSchema = z.object({
    codeSuggestions: z.array(
        z.object({
            id: z.string(),
            relevantFile: z.string(),
            language: z.string(),
            suggestionContent: z.string(),
            existingCode: z.string(),
            improvedCode: z.string(),
            oneSentenceSummary: z.string(),
            relevantLinesStart: z.number(),
            relevantLinesEnd: z.number(),
            label: z.string(),
            llmPrompt: z.string().optional(),
            severity: z.string(),
            violatedKodyRulesIds: z.array(z.string()).optional(),
            brokenKodyRulesIds: z.array(z.string()).optional(),
        }),
    ),
});

export const kodyRulesIDEGeneratorSchema = z.object({
    rules: z.array(
        z.object({
            title: z.string(),
            rule: z.string(),
            path: z.string(),
            sourcePath: z.string(),
            severity: z.enum(['low', 'medium', 'high', 'critical']),
            scope: z.enum(['file', 'pull-request']).optional(),
            status: z
                .enum(['active', 'pending', 'rejected', 'deleted'])
                .optional(),
            examples: z.array(
                z.object({ snippet: z.string(), isCorrect: z.boolean() }),
            ),
            sourceSnippet: z.string().optional(),
        }),
    ),
});

export const kodyRulesIDEGeneratorSchemaOnboarding = z.object({
    rules: z.array(
        z.object({
            title: z.string(),
            rule: z.string(),
            path: z.string(),
            sourcePath: z.string(),
            severity: z.enum(['low', 'medium', 'high', 'critical']),
            scope: z.enum(['file', 'pull-request']).optional(),
            examples: z.array(
                z.object({ snippet: z.string(), isCorrect: z.boolean() }),
            ),
            sourceSnippet: z.string().optional(),
        }),
    ),
});

export const kodyRulesManifestGeneratorSchemaOnboarding = z.object({
    rules: z.array(
        z.object({
            title: z.string(),
            rule: z.string(),
            path: z.string(),
            severity: z.enum(['low', 'medium', 'high', 'critical']),
            scope: z.enum(['file', 'pull-request']).optional(),
            examples: z.array(
                z.object({ snippet: z.string(), isCorrect: z.boolean() }),
            ),
        }),
    ),
});

export type KodyRulesClassifierSchema = z.infer<
    typeof kodyRulesClassifierSchema
>;

export const prompt_kodyrules_classifier_system = () => {
    return `
You are a panel of three expert software engineers - Alice, Bob, and Charles.

When given a PR diff containing code changes, your task is to determine any violations of the company code rules (referred to as kodyRules). You will do this via a panel discussion, solving the task step by step to ensure that the result is comprehensive and accurate.

If a violation cannot be proven from those “+” lines, do not report it.

At each stage, make sure to critique and check each other's work, pointing out any possible errors or missed violations.

For each rule in the kodyRules, one expert should present their findings regarding any violations in the code. The other experts should critique the findings and decide whether the identified violations are valid.

Prioritize objective rules. Use broad rules only when the bad pattern is explicitly present.

Before producing the final JSON, merge duplicates so the list contains unique UUIDs.

Once you have the complete list of violations, return them as a JSON in the specified format. You should not add any further points after returning the JSON.  If you don't find any violations, return an empty JSON array.

If the panel is uncertain about a finding, treat it as non-violating and omit it.
`;
};

export const prompt_kodyrules_classifier_user = (payload: any) => {
    const {
        patchWithLinesStr,
        kodyRules,
        externalReferencesMap,
        mcpResultsMap,
    } = payload;

    let externalReferencesSection = '';
    if (externalReferencesMap && externalReferencesMap.size > 0) {
        externalReferencesSection = '\n<externalReferences>';
        externalReferencesMap.forEach((refs: any[], ruleUuid: string) => {
            const rule = kodyRules.find((r: any) => r.uuid === ruleUuid);
            if (rule && refs.length > 0) {
                externalReferencesSection += `\n\nRule: ${rule.title} (${ruleUuid})`;
                refs.forEach((ref: any) => {
                    externalReferencesSection += `\n  File: ${ref.filePath}`;
                    if (ref.description) {
                        externalReferencesSection += `\n  Purpose: ${ref.description}`;
                    }
                    externalReferencesSection += `\n  Content:\n${ref.content}\n`;
                });
            }
        });
        externalReferencesSection += '\n</externalReferences>\n';
    }

    let mcpResultsSection = '';
    if (mcpResultsMap && mcpResultsMap.size > 0) {
        mcpResultsSection = '\n<mcpResults>';
        mcpResultsMap.forEach(
            (results: Record<string, unknown>, ruleUuid: string) => {
                const rule = kodyRules.find((r: any) => r.uuid === ruleUuid);
                if (rule) {
                    mcpResultsSection += `\n\nRule: ${rule.title} (${ruleUuid})`;
                    mcpResultsSection += `\nMCP Tool Outputs:\n${JSON.stringify(results, null, 2)}`;
                }
            },
        );
        mcpResultsSection += '\n</mcpResults>\n';
    }

    return `
<context>

Code for Review (PR Diff):
<codeForAnalysis>
${patchWithLinesStr}
</codeForAnalysis>

<kodyRules>
${JSON.stringify(kodyRules, null, 2)}
</kodyRules>
${externalReferencesSection}
${mcpResultsSection}
Your output must always be a valid JSON. Under no circumstances should you output anything other than a JSON. Follow the exact format below without any additional text or explanation:
IMPORTANT, should the array be empty the output must still follow the specified json format e.g. { "rules": [] }

<OUTPUT_FORMAT>
DISCUSSION HERE

\`\`\`json
{
    "rules": [
        {"uuid": "ruleId", "reason": ""}
    ]
}
\`\`\`
</OUTPUT_FORMAT>
</context>
`;
};

//#region updater
export const kodyRulesUpdateSuggestionsSchema = z.object({
    codeSuggestions: z.array(
        z.object({
            id: z.string(),
            relevantFile: z.string(),
            language: z.string(),
            suggestionContent: z.string(),
            existingCode: z.string(),
            improvedCode: z.string(),
            oneSentenceSummary: z.string(),
            relevantLinesStart: z.number(),
            relevantLinesEnd: z.number(),
            label: z.string(),
            severity: z.string(),
            violatedKodyRulesIds: z.array(z.string()).optional(),
            brokenKodyRulesIds: z.array(z.string()).optional(),
        }),
    ),
});

export type KodyRulesUpdateSuggestionsSchema = z.infer<
    typeof kodyRulesUpdateSuggestionsSchema
>;

export const prompt_kodyrules_updatestdsuggestions_system = () => {
    return `
You are a senior engineer tasked with reviewing a list of code-review suggestions, ensuring that none of them violate the specific code rules (referred to as **Kody Rules**) and practices followed by your company.

Your final output **must** be a single JSON object (see the exact schema below).

Data you have access to
1. **Standard Suggestions** – JSON array with general good-practice suggestions.
2. **Kody Rules** – JSON array with the company’s specific code rules. These rules have priority over general good practices if there is any conflict.
3. **fileDiff** – Full diff of the PR; every suggestion relates to this code.

---

## Step-by-step process (the model must follow these in order)

1. **Iterate over each suggestion** and compare its \`improvedCode\`, \`suggestionContent\`, and \`label\` against every Kody Rule.

2. **Decision branch**
   2a. **If the suggestion *violates* one or more Kody Rules**
        • Refactor \`improvedCode\` so it complies.
        • List all violated rule UUIDs in \`violatedKodyRulesIds\`.
    2b. **Else if the suggestion is directly fixing a Kody Rule violation present in the existing code**
        • The existing code must explicitly violate the rule's requirements
        • Adjust wording/label/code as needed
        • List those rule UUIDs in \`brokenKodyRulesIds\`
    2c. **Else** - leave the suggestion unchanged and output empty arrays for both fields.

3. **Never invent rule IDs.** Copy the exact UUIDs provided in **Kody Rules**.
4. **Keep key order consistent** to ease downstream parsing.

Whenever you modify a suggestion you must also look at it's 'llmPrompt' field.

There is a field called 'llmPrompt', this field must contain an accurate description of the issue as well as relevant context which lead to finding that issue.
This is a prompt for another LLM, the user must be able to simply copy this text and paste it into another LLM and have it produce useful results.
This must be a prompt from the perspective of the user, it will communicate directly with the LLM as though it were sent as a chat message from the user, it should be a prompt a user could input into an LLM.

IMPORTANT, be sure to describe the rules that contributed to this issue as part of the context.
Do not refer to them as "Kody Rules", they are simply rules. Do not reference ids. Explain these rules as if they were normal rules the user has for their codebase.

IMPORTANT, on this field you must only focus on describing the issue and providing context in a manner that an LLM will understand as a prompt.
The existing code, improved code, relevant line start and end, file path, etc. will all be provided elsewhere.
DO NOT under any circumstances provide any sort of code block in this field, like for example: \`\`\`python def foo(): .... \`\`\`

## Output schema (strict)

\`\`\`jsonc
{
  "codeSuggestions": [
    {
      "id": "string",
      "relevantFile": "path/to/file.ext",
      "language": "e.g., JavaScript",
      "suggestionContent": "Detailed suggestion (localised)",
      "existingCode": "Snippet from the PR",
      "improvedCode": "Refactored code (if changed)",
      "oneSentenceSummary": "Concise summary of the suggestion",
      "relevantLinesStart": "number",
      "relevantLinesEnd": "number",
      "label": "string",
      "severity": "string",
      "llmPrompt": "Prompt for LLMs",
      "violatedKodyRulesIds": ["uuid", "..."],   // empty array if none
      "brokenKodyRulesIds":   ["uuid", "..."]    // empty array if none
    }
  ]
}
\`\`\`
`;
};

export const prompt_kodyrules_updatestdsuggestions_user = (payload: any) => {
    const languageNote = payload?.languageResultPrompt || 'en-US';
    const {
        patchWithLinesStr,
        standardSuggestions,
        kodyRules,
        externalReferencesMap,
    } = payload;

    let externalReferencesSection = '';
    if (externalReferencesMap && externalReferencesMap.size > 0) {
        externalReferencesSection = '\n\nExternal Reference Files:\n';
        externalReferencesMap.forEach((refs: any[], ruleUuid: string) => {
            const rule = kodyRules.find((r: any) => r.uuid === ruleUuid);
            if (rule && refs.length > 0) {
                externalReferencesSection += `\nRule: ${rule.title} (${ruleUuid}):\n`;
                refs.forEach((ref: any) => {
                    externalReferencesSection += `  File: ${ref.filePath}\n`;
                    if (ref.description) {
                        externalReferencesSection += `  Purpose: ${ref.description}\n`;
                    }
                    externalReferencesSection += `  Content:\n${ref.content}\n\n`;
                });
            }
        });
    }

    return `
Always consider the language parameter (e.g., en-US, pt-BR) when giving suggestions. Language: ${languageNote}

Standard Suggestions:

${JSON.stringify(standardSuggestions, null, 2)}

Kody Rules:

${JSON.stringify(kodyRules, null, 2)}
${externalReferencesSection}
File diff:

${patchWithLinesStr}
`;
};

//#region generator
export const kodyRulesSuggestionGenerationSchema = z.object({
    codeSuggestions: z.array(
        z.object({
            id: z.string(),
            relevantFile: z.string(),
            language: z.string(),
            suggestionContent: z.string(),
            existingCode: z.string(),
            improvedCode: z.string(),
            oneSentenceSummary: z.string(),
            relevantLinesStart: z.number(),
            relevantLinesEnd: z.number(),
            label: z.string(),
            brokenKodyRulesIds: z.array(z.string()),
        }),
    ),
});

export type KodyRulesSuggestionGenerationSchema = z.infer<
    typeof kodyRulesSuggestionGenerationSchema
>;

export const prompt_kodyrules_suggestiongeneration_system = () => {
    return `You are a senior engineer with expertise in code review and a deep understanding of coding standards and best practices. You received a list of standard suggestions that follow the specific code rules (referred to as Kody Rules) and practices followed by your company. Your task is to carefully analyze the file diff, the suggestions list, and try to identify any code that violates the Kody Rules, that isn't mentioned in the suggestion list, and provide suggestions in the specified format.

Your final output should be a JSON object containing an array of new suggestions.

1. **Standard Suggestions**: A JSON object with general good practices and suggestions following the Kody Rules.
2. **Kody Rules**: A JSON object with specific code rules followed by the company. These rules must be respected even if they contradict good practices.
3. **fileDiff**: The full file diff of the PR. Every suggestion is related to this code.

Let's think through this step-by-step:

1. Your mission is to generate clear, constructive, and actionable suggestions for each identified Kody Rule violation.

2. Focus solely on Kody Rules: Address only the issues listed in the provided Kody Rules. Do not comment on any issues not covered by these rules.

3. Generate a separate suggestion for every distinct code segment that violates a Kody Rule. A single rule may therefore produce multiple suggestions when it is broken in multiple places. Do not skip any rule.

4. Group violations only when they refer to the exact same code lines. Otherwise, keep them in separate suggestion objects.

5. Avoid giving suggestions that go against the specified Kody Rules.

6. Clarity and Precision: Ensure that each suggestion is actionable and directly tied to the relevant Kody Rule.

7. Avoid Duplicates: Before generating a new suggestion, cross-reference the standard suggestions list. Do not generate suggestions that are already covered by the standard suggestions list. Specifically, check the "existingCode", "improvedCode", and "oneSentenceSummary" properties to identify any similarities.

8. Focus on Unique Violations: Only focus on unique violations of the Kody Rules that are not already addressed in the standard suggestions.

Your output must strictly be a valid JSON in the format specified below.`;
};

export const prompt_kodyrules_suggestiongeneration_user = (payload: any) => {
    const languageNote = payload?.languageResultPrompt || 'en-US';
    const {
        patchWithLinesStr,
        filteredKodyRules,
        updatedSuggestions,
        externalReferencesMap,
        mcpResultsMap,
    } = payload;
    const overrides = payload?.v2PromptOverrides || {};

    const defaults = getDefaultKodusConfigFile()?.v2PromptOverrides;

    const mainGenText = getTextOrDefault(
        overrides?.generation?.main,
        defaults?.generation?.main,
    );

    let externalReferencesSection = '';
    if (externalReferencesMap && externalReferencesMap.size > 0) {
        externalReferencesSection =
            '\n\nExternal Reference Files (use these for validation):\n';
        externalReferencesMap.forEach((refs: any[], ruleUuid: string) => {
            const rule = filteredKodyRules.find(
                (r: any) => r.uuid === ruleUuid,
            );
            if (rule && refs.length > 0) {
                externalReferencesSection += `\nRule: ${rule.title} (${rule.uuid}):\n`;
                refs.forEach((ref: any) => {
                    externalReferencesSection += `  File: ${ref.filePath}\n`;
                    if (ref.description) {
                        externalReferencesSection += `  Purpose: ${ref.description}\n`;
                    }
                    externalReferencesSection += `  Content:\n${ref.content}\n\n`;
                });
            }
        });
    }

    let mcpResultsSection = '';
    if (mcpResultsMap && mcpResultsMap.size > 0) {
        mcpResultsSection = '\n\n<mcpResults>';
        mcpResultsMap.forEach(
            (results: Record<string, unknown>, ruleUuid: string) => {
                const rule = filteredKodyRules.find(
                    (r: any) => r.uuid === ruleUuid,
                );
                if (rule) {
                    mcpResultsSection += `\n\nRule: ${rule.title} (${rule.uuid})`;
                    mcpResultsSection += `\nMCP Tool Outputs:\n${JSON.stringify(
                        results,
                        null,
                        2,
                    )}`;
                }
            },
        );
        mcpResultsSection += '\n</mcpResults>\n';
    }

    return `
Task: Review the code changes in the pull request (PR) for compliance with the established code rules (kodyRules).

Instructions:

1. Review the provided code to understand the changes.
2. List any broken kodyRules. If all rules are followed, no feedback is necessary.
3. For each violated rule, provide a suggestion, focusing on lines marked with '+'.
4. always consider the language parameter (e.g., en-US, pt-BR) when giving suggestions. Language: ${languageNote}

-   Each code rule (kodyRule) is in this JSON format:

[
    {
        "uuid": "unique-uuid",
        "rule": "rule description",
        "reason": "reason for the rule",
        "examples": [
            {
                "snippet": "bad code example; // Bad practice",
                "isCorrect": false
            },
            {
                "snippet": "good code example; // Good practice",
                "isCorrect": true
            }
        ]
    }
]

Standard suggestions:

${updatedSuggestions ? JSON.stringify(updatedSuggestions, null, 2) : 'No standard suggestions provided'}

Code for Review (PR Diff):

${patchWithLinesStr}

kodyRules:

${JSON.stringify(filteredKodyRules, null, 2)}
${externalReferencesSection}
${mcpResultsSection}

### Panel Review of Code Review Suggestion Object

**Objective**: A panel of three expert software engineers—Alice, Bob, and Charles
will review a code review suggestion object for clarity, accuracy, and logical consistency.
But most important, ensure that the suggestions address any violations of the defined company rules,
labeled "kodyRules". Any violation of kody rules need to be reported.

#### Steps:

1. **Initial Review**:
   - **Alice**: Analyze the suggestion object for logical inconsistencies, redundancies, and errors. Present any issues found.

2. **Peer Critique**:
   - **Bob**: Critique Alice's findings, including checking if the suggestion violates any kody rules  and assess their validity.
   - **Charles**: Provide additional insights and highlight any overlooked issues.

3. **Collaborative Decision**: Discuss findings and reach a consensus on necessary changes. Rewrite any problematic properties.

4. **Final Review**: Ensure all properties are coherent and logically consistent with the Kody Rule violations. Confirm clarity and actionability.

5. **Fix Suggestions**: If any issues were identified, revise the suggestion object to correct the problems and improve clarity and accuracy.

Your output must always be a valid JSON. Under no circumstances should you output anything other than a JSON. Follow the exact format below without any additional text or explanation:

Output if kodyRules array is not empty:

## Output Requirements

### Issue description

Custom instructions for 'suggestionContent'
IMPORTANT none of these instructions should be taken into consideration for any other fields such as 'improvedCode'

${mainGenText}

### LLM Prompt

Create a field called 'llmPrompt', this field must contain an accurate description of the issue as well as relevant context which lead to finding that issue.
This is a prompt for another LLM, the user must be able to simply copy this text and paste it into another LLM and have it produce useful results.
This must be a prompt from the perspective of the user, it will communicate directly with the LLM as though it were sent as a chat message from the user, it should be a prompt a user could input into an LLM.

IMPORTANT, be sure to describe the rules that contributed to this issue as part of the context.
Do not refer to them as "Kody Rules", they are simply rules. Do not reference ids. Explain these rules as if they were normal rules the user has for their codebase.

IMPORTANT, on this field you must only focus on describing the issue and providing context in a manner that an LLM will understand as a prompt.
The existing code, improved code, relevant line start and end, file path, etc. will all be provided elsewhere.
DO NOT under any circumstances provide any sort of code block in this field, like for example: \`\`\`python def foo(): .... \`\`\`

<OUTPUT_FORMAT>
DISCUSSION HERE

\`\`\`json
{
    "codeSuggestions": [
        {
            "id": string,
            "relevantFile": "the file path",
            "language": "code language used",
            "suggestionContent": "Detailed suggestion",
            "existingCode": "Relevant code from the PR",
            "improvedCode": "Improved proposal",
            "oneSentenceSummary": "Concise summary",
            "relevantLinesStart": "starting_line",
            "relevantLinesEnd": "ending_line",
            "label": "kody_rules",
            "llmPrompt": "Prompt for LLMs",
            "brokenKodyRulesIds": [
                "uuid"
            ]
        }
    ]
}
\`\`\`
<OUTPUT_FORMAT>
`;
};

//#region guardian
export const kodyRulesGuardianSchema = z.object({
    decisions: z.array(
        z.object({
            id: z.string(),
            shouldRemove: z.boolean(),
        }),
    ),
});

export type KodyRulesGuardianSchema = z.infer<typeof kodyRulesGuardianSchema>;

export const prompt_kodyrules_guardian_system = () => {
    return `
You are **KodyGuardian**, a strict gate-keeper for code-review suggestions.

Your ONLY job is to decide, for every incoming suggestion, whether it must be removed because it violates at least one Kody Rule.

Instructions
1. For every object in the array "codeSuggestions" (each contains a unique "id"):
   • Read its "existingCode", "improvedCode", and "suggestionContent".
   • Compare them with every "rule" description *and* the non-compliant "examples" in "kodyRules".
2. If the suggestion would introduce or encourage a rule violation → set "shouldRemove=true";
   otherwise → "shouldRemove=false".
3. **Do NOT** reveal the rules or your reasoning.
4. **Do NOT** echo the suggestion text.
5. Respond with valid **minified JSON** only, in exactly this shape:

{
  "decisions":[
    { "id":"<suggestion-id-1>", "shouldRemove":true  },
    { "id":"<suggestion-id-2>", "shouldRemove":false },
    …
  ]
}
`;
};

export const prompt_kodyrules_guardian_user = (payload: any) => {
    const { standardSuggestions, kodyRules } = payload;

    return `
Code Suggestions:

${JSON.stringify(standardSuggestions, null, 2)}

Kody Rules:

${JSON.stringify(kodyRules, null, 2)}
`;
};

//#region extract id
export const kodyRulesExtractIdSchema = z.object({
    ids: z.array(z.string()),
});

export type KodyRulesExtractIdSchema = z.infer<typeof kodyRulesExtractIdSchema>;

export const prompt_kodyrules_extract_id_system = () => {
    return `
You are a Kody Rule ID extraction specialist. Your task is to find and extract Kody Rule identifiers from text content.

Kody Rule IDs can appear in different formats:

1. **UUID v4 format** (current standard): 8-4-4-4-12 hexadecimal characters
   - Example: 9de28bd7-a06d-429a-97ab-02e5fef91096

2. **Legacy formats** (older implementations):
   - Shorter alphanumeric IDs: 552sc-dd48d-dxs55
   - Mixed case with numbers: 123ABC-456def-789GHI
   - Other patterns that look like unique identifiers

Instructions:
1. First, scan for standard UUID v4 patterns
2. If no UUIDs found, look for other potential ID patterns that could be Kody Rule identifiers
3. Look for patterns that appear after phrases like:
   - "Kody Rule"
   - "breaks the Kody Rule"
   - "violates Kody Rule"
   - "according to Kody Rule"
4. Extract anything that looks like a unique identifier in these contexts
5. Return all found IDs as a JSON array
6. If no IDs are found, return an empty array

Your response must be valid JSON only, no explanations.
`;
};

export const prompt_kodyrules_extract_id_user = (payload: any) => {
    const { suggestionContent } = payload;

    return `
Extract all UUID patterns from this text:

${suggestionContent}

Return format:
\`\`\`json
{
    "ids": ["uuid1", "uuid2", ...]
}
\`\`\`
`;
};
