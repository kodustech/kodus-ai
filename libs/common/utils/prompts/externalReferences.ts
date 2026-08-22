import z from 'zod';

export const externalReferencesDetectionSchema = z.object({
    references: z.array(
        z.object({
            fileName: z.string(),
            filePattern: z.string().optional(),
            description: z.string().optional(),
            repositoryName: z.string().optional(),
            originalText: z.string().optional(),
            lineRange: z
                .object({
                    start: z.number(),
                    end: z.number(),
                })
                .optional(),
        }),
    ),
});

export type ExternalReferencesDetectionSchema = z.infer<
    typeof externalReferencesDetectionSchema
>;

export const prompt_detect_external_references_system = () => {
    return `You are an expert at analyzing text to identify file references that require reading external content.

## Core Principle

A file reference exists when the text mentions a file whose CONTENT needs to be read to understand or apply the instructions.

## Two Types of File Mentions

**STRUCTURAL Mentions (DO NOT DETECT):**
References to code structure, imports, or file organization that don't need content.
Example: "Import UserService from services/user.ts" → DON'T DETECT (just an import path)

**CONTENT Mentions (DETECT):**
References where understanding requires reading the actual file content.
Examples:
- "Follow the guidelines in CONTRIBUTING.md" → DETECT (need to read guidelines)
- "Use patterns from docs/api-standards.md" → DETECT (need to read patterns)
- "Validate against schema.json" → DETECT (need to read schema)
- "Check rules in .eslintrc" → DETECT (need to read rules)
- "Follow @file:CONTRIBUTING.md" → DETECT (explicit reference)
- "Use [[file:docs/style.md]]" → DETECT (explicit reference)

## Detection Rules

1. Focus on intent: Does the text require reading the file's content?
2. Support multiple formats:
   - Natural language: "follow guidelines in FILE"
   - Explicit format: "@file:path" or "[[file:path]]"
   - With line ranges: "@file:path#L10-L50" or "[[file:path#L10-L50]]"
   - Cross-repo: "@file:repo-name:path" or "[[file:repo-name:path]]"
3. Be language-agnostic
4. If uncertain, do NOT detect (avoid false positives)
5. Extract line ranges when mentioned (e.g., #L10-L50 means lines 10 to 50)

## What to Extract

For each file requiring content:
- fileName: the file name or path
- filePattern: glob pattern if multiple files referenced
- description: what the file provides (guidelines, rules, examples, etc)
- repositoryName: repository name if explicitly mentioned
- originalText: the EXACT text from the input that mentions this file (for UI highlighting)
- lineRange: specific line range if mentioned (e.g., #L10-L50)

Output format:
{
  "references": [
    {
      "fileName": "file-name.ext",
      "filePattern": "optional-pattern",
      "description": "what content provides",
      "repositoryName": "optional-repo",
      "originalText": "the exact mention from input text",
      "lineRange": { "start": 10, "end": 50 }
    }
  ]
}

Output ONLY valid JSON. No explanations.`;
};

export const prompt_detect_external_references_user = (payload: {
    text: string;
    context?: 'rule' | 'instruction' | 'prompt';
}) => {
    const contextHint = payload.context
        ? `\n\nContext: This is a ${payload.context} that may reference external files.`
        : '';

    return `Text to analyze:

${payload.text}${contextHint}

Analyze if this text requires external file references.
Return JSON with detected file references or empty array if none exist.`;
};
