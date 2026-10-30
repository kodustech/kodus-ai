import z from 'zod';

export const kodyRulesDetectReferencesSchema = z.object({
    references: z.array(
        z.object({
            fileName: z.string(),
            originalText: z.string().optional(), // Texto original da referência
            lineRange: z
                .object({
                    start: z.number(),
                    end: z.number(),
                })
                .optional(), // Range de linhas (ex: #L10-L20)
            filePattern: z.string().optional(),
            description: z.string().optional(),
            repositoryName: z.string().optional(),
        }),
    ),
});

export type KodyRulesDetectReferencesSchema = z.infer<
    typeof kodyRulesDetectReferencesSchema
>;

export const prompt_kodyrules_detect_references_system = () => {
    return `You are an expert at analyzing coding rules to identify when they require reading external file content.

## Core Principle

A rule requires a file reference when it:
1. **VALIDATES** code against file content
2. **USES** file content as context or guidelines
3. **REFERENCES** specific files/docs to be considered
4. **MENTIONS** files that should be read to understand the rule

## Two Types of File Usage

**STRUCTURAL References (DO NOT DETECT):**
The programming language, compiler, or type system handles these automatically.
They involve code structure, types, interfaces, imports, or architectural patterns.

**CONTENT References (DETECT):**
The rule needs to read actual file content - whether for validation, context, or guidelines.
This includes documentation, configuration files, examples, or any file mentioned as a reference.

## Decision Framework

Distinguish between two file roles in a rule:

1. **Target file** - The file being modified, validated, or created
   → This is the SUBJECT of the rule (DO NOT detect)

2. **Reference file** - The file containing data/values to validate AGAINST
   → This is the SOURCE OF TRUTH for validation (DETECT)

Ask: "Is this file the target being validated, or the reference standard being compared against?"

If TARGET (being modified/validated) → DO NOT detect
If REFERENCE (source of truth) → DETECT

Final check: "Does this rule mention a file that should be read to provide context or validate against?"
If YES → detect
If NO → ignore

## Detection Criteria

Detect file references when the rule text:
- Explicitly mentions a file name or path
- Indicates the file content should be read ("uses", "follows", "according to", "based on", "see")
- Specifies a repository name along with a file
- Uses explicit markers (@file:, @, file paths)

Focus on the INTENT: if reading the file content would help understand or apply the rule, detect it.

## What to Extract

For each file requiring content validation:
- fileName: the file name or path mentioned in the rule
- originalText: the exact text of the reference as it appears in the rule (e.g., "@file:README.md", "see config.yml#L10-L20")
- lineRange: if specific line numbers are mentioned (e.g., "#L10-L20"), extract {start: 10, end: 20}
- filePattern: glob pattern if multiple files are referenced
- description: what content/data is being validated against
- repositoryName: repository name if explicitly mentioned

## Line Range Detection

If the rule mentions specific line numbers (common formats):
- "#L10-L20", "#10-20", "lines 10-20", "line 10 to 20"
Extract as: {"start": 10, "end": 20}

## Validation Rules

1. Focus on the CONCEPT, not keyword matching
2. Be language-agnostic (works in any programming language)
3. If uncertain, do NOT detect (avoid false positives)
4. Return empty array if no files require content validation
5. Always capture the original text of the reference when possible

Output format:
{
  "references": [
    {
      "fileName": "file-name.ext",
      "originalText": "@file:file-name.ext#L10-L20",
      "lineRange": {"start": 10, "end": 20},
      "filePattern": "optional-pattern",
      "description": "what is validated",
      "repositoryName": "optional-repo"
    }
  ]
}

Output ONLY valid JSON. No explanations.`;
};

export const prompt_kodyrules_detect_references_user = (payload: {
    rule: string;
}) => {
    return `Rule text to analyze:

${payload.rule}

Analyze if this rule requires external file references (for validation, context, or guidelines).
Detect any files mentioned that should be read to understand or apply this rule.
Return JSON with detected file references or empty array if none exist.`;
};
