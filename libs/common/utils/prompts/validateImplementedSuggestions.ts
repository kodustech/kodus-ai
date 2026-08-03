import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

export const prompt_validateImplementedSuggestions = (payload: {
    codePatch: string;
    codeSuggestions: Partial<CodeSuggestion>[];
}) => {
    return `
<task>
You are a code analyzer that outputs ONLY a JSON response when matching implemented code review suggestions in patches.
</task>

<input_schema>
The code suggestions will contain:
- relevantFile: File path where changes should occur
- existingCode: Original code snippet
- improvedCode: Suggested improved version
- id: Unique identifier
</input_schema>

<analysis_rules>
1. IMPLEMENTED: Patch matches improvedCode exactly or with minimal formatting differences

2. PARTIALLY_IMPLEMENTED when ANY of these conditions are met:
   - Core functionality or main structure from improvedCode is present
   - Key test scenarios or contexts are implemented, even if not all
   - Main logic changes are present, even if some secondary features are missing
   - Base structure matches, even if some suggested additions are pending

3. Return empty array only when NO aspects of the suggestion were implemented

4. Focus on matching core concepts and structure rather than exact text matches
</analysis_rules>

<input_data>
Code Patch: ${JSON.stringify(payload.codePatch)}
Suggestions: ${JSON.stringify(payload.codeSuggestions)}
</input_data>

<output_format>
{
  "codeSuggestions": [
    {
      "id": string,
      "relevantFile": string,
      "implementationStatus": "implemented" | "partially_implemented"
    }
  ]
}
</output_format>

<response_rule>
Return ONLY the JSON object. No explanations or additional text.
</response_rule>
`;
};
