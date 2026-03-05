import z from 'zod';

import { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { SeverityLevel } from '../../enums/severityLevel.enum';
import { getDefaultKodusConfigFile } from '../../validateCodeReviewConfigFile';
import { getTextOrDefault, sanitizePromptText } from './prompt.helpers';

export interface CrossFileContextForPrompt {
    filePath: string;
    content: string;
    rationale: string;
    relationship: string;
    relatedSymbol?: string;
}

export interface CrossFileAnalysisPayload {
    files: {
        file: {
            filename: string;
            codeDiff: string;
        };
    }[];
    language: string;
    v2PromptOverrides: Omit<
        CodeReviewConfig['v2PromptOverrides'],
        'categories'
    >;
    crossFileContexts?: CrossFileContextForPrompt[];
    memories?: Array<{
        title?: string;
        rule?: string;
    }>;
    externalReferences?: unknown[];
    externalReferenceErrors?: unknown[] | string;
}

function formatSyncErrors(errors: unknown[] | string | undefined): string {
    if (!errors) {
        return '';
    }

    const normalized = Array.isArray(errors) ? errors : [errors];
    const formatted = normalized
        .map((error) => {
            if (!error) {
                return null;
            }
            if (typeof error === 'string') {
                return `- ${error}`;
            }
            if (typeof error === 'object') {
                const message =
                    typeof (error as Record<string, unknown>).message ===
                    'string'
                        ? ((error as Record<string, unknown>).message as string)
                        : 'Unknown reference error';
                return `- ${message}`;
            }
            return null;
        })
        .filter((line): line is string => Boolean(line));

    if (!formatted.length) {
        return '';
    }

    return `### Source: System Messages\n**Reference issues detected:**\n${formatted.join('\n')}`;
}

function formatReferenceSection(references: unknown[] | undefined): string {
    if (!Array.isArray(references) || !references.length) {
        return '';
    }

    return (references as Array<Record<string, unknown>>)
        .map((ref) => {
            const lineRangeInfo = ref.lineRange
                ? ` (lines ${(ref.lineRange as Record<string, unknown>).start}-${(ref.lineRange as Record<string, unknown>).end})`
                : '';
            const header = `### Source: File - ${ref.filePath}${lineRangeInfo}`;
            return `${header}\n${ref.content}`;
        })
        .join('\n\n');
}

function appendExternalContext(basePrompt: string, sections: string[]): string {
    const contextBlocks = sections.filter((section) => section?.trim().length);

    if (!contextBlocks.length) {
        return basePrompt;
    }

    return `${basePrompt}\n\n## External Context & Injected Knowledge\n\nThe following information is provided to ground your analysis in the broader system reality. Use this as your source of truth.\n\n---\n\n${contextBlocks.join('\n\n---\n\n')}`;
}

function formatMemoriesSection(
    memories: CrossFileAnalysisPayload['memories'],
): string {
    if (!Array.isArray(memories) || !memories.length) {
        return '';
    }

    const formattedMemories = memories
        .map((memory) => {
            const title = getTextOrDefault(memory?.title, '').trim();
            const rule = getTextOrDefault(memory?.rule, '').trim();

            if (!title || !rule) {
                return null;
            }

            return `- Title: ${sanitizePromptText(title)}\n  Rule: ${sanitizePromptText(rule)}`;
        })
        .filter((entry): entry is string => Boolean(entry));

    if (!formattedMemories.length) {
        return '';
    }

    return `## Memories\n\nAdditional context from past learnings in Kody Rules format.\n\n${formattedMemories.join('\n\n')}`;
}

export const CrossFileAnalysisSchema = z.object({
    suggestions: z.array(
        z.object({
            relevantFile: z.string().min(1),
            relatedFile: z.string().min(1),
            language: z.string().min(1),
            suggestionContent: z.string().min(1),
            existingCode: z.string().min(1),
            improvedCode: z.string().min(1),
            oneSentenceSummary: z.string().min(1),
            relevantLinesStart: z.number().min(1),
            relevantLinesEnd: z.number().min(1),
            severity: z.enum(
                Object.values(SeverityLevel) as [string, ...string[]],
            ),
            llmPrompt: z.string().optional(),
        }),
    ),
});

export type CrossFileAnalysisSchemaType = z.infer<
    typeof CrossFileAnalysisSchema
>;

export const prompt_codereview_cross_file_analysis = (
    payload: CrossFileAnalysisPayload,
) => {
    const overrides = payload?.v2PromptOverrides || {};
    const defaults = getDefaultKodusConfigFile()?.v2PromptOverrides;

    const defaultSeverity = defaults?.severity?.flags;

    const defaultCritical = defaultSeverity?.critical;
    const defaultHigh = defaultSeverity?.high;
    const defaultMedium = defaultSeverity?.medium;
    const defaultLow = defaultSeverity?.low;

    const sev = overrides?.severity?.flags || {};
    const criticalText = getTextOrDefault(sev.critical, defaultCritical);
    const highText = getTextOrDefault(sev.high, defaultHigh);
    const mediumText = getTextOrDefault(sev.medium, defaultMedium);
    const lowText = getTextOrDefault(sev.low, defaultLow);

    const defaultGeneration = defaults?.generation;

    const mainGenText = getTextOrDefault(
        overrides?.generation?.main,
        defaultGeneration?.main,
    );
    const memoriesBlock = formatMemoriesSection(payload?.memories);

    const basePrompt = `You are Kody PR-Reviewer, a senior engineer specialized in understanding and reviewing code, with deep knowledge of how LLMs function. You are **context-aware** and prioritize **developer intent** over rigid rule-following.

# Cross-File Code Analysis
Analyze the following PR files for patterns that require multiple file context: duplicate implementations, inconsistent error handling, configuration drift, interface inconsistencies, and redundant operations.
## Input Data
- Array of files with their respective code diffs from a Pull Request
- Each file contains metadata (filename, codeDiff content)

## Input Files
${JSON.stringify(
    payload?.files?.map((file) => ({
        fileName: file?.file?.filename,
        codeDiff: file?.file?.codeDiff,
    })),
    null,
    2,
)}

${
    payload?.crossFileContexts?.length
        ? `## Retrieved Cross-File Context

The following code snippets were retrieved from files OUTSIDE this PR that consume or depend on the changed code. Use these to detect real breakage, inconsistencies, or missed updates.

${payload.crossFileContexts
    .map(
        (ctx) => `### ${ctx.filePath}
**Relationship:** ${ctx.relationship}${ctx.relatedSymbol ? ` (symbol: ${ctx.relatedSymbol})` : ''}
**Rationale:** ${ctx.rationale}

\`\`\`
${ctx.content}
\`\`\``,
    )
    .join('\n\n')}

### Cross-File Context Analysis Rules
- **PRIORITIZE** real breakage detected in the retrieved snippets (e.g., callers using removed parameters, consumers expecting old return types)
- Issues backed by retrieved context evidence should be rated at least **HIGH** severity
- Do not re-report issues that are already visible in the PR diff alone — focus on cross-file impact revealed by the retrieved context
`
        : ''
}
## Analysis Focus

Look for cross-file issues that require multiple file context **AND represent an unintentional oversight**:
- Same logic implemented across multiple files in the diff
- Different error handling patterns for similar scenarios across files
- Hardcoded values duplicated across files that should use shared constants
- Same business operation with different validation rules
- Missing validations in one implementation while present in another
- Unnecessary database calls when data already validated elsewhere
- Duplicate validations across different components
- Operations already handled by other layers
- Similar functions/methods that could be consolidated
- Repeated patterns indicating need for shared utilities
- Inconsistent error propagation between components
- Mixed approaches to validation/exception handling
- Similar configurations with different values
- Magic numbers/strings repeated in multiple files
- Redundant null checks when validation exists in another layer

## Suppression Criteria (MANDATORY)

**You MUST IGNORE and SUPPRESS suggestions in the following scenarios. Silence is better than noise.**

1.  **Documented Intent / Technical Debt:**
    - Code explicitly commented with \`TODO\`, \`FIXME\`, \`HACK\`, or \`Legacy\`.
    - Comments explaining why duplication exists (e.g., "// Decoupled for microservice architecture", "// Kept for backward compatibility").
    - Explicit deprecation warnings (e.g., \`@deprecated\`).

2.  **Testing & Mocks:**
    - Hardcoded values or duplications found inside \`test/\`, \`spec/\`, or \`mock/\` files.
    - Configuration drift between \`prod\` configs and \`test\` configs (this is expected behavior).
    - Security "issues" (like hardcoded tokens) inside test files that are clearly fake data.

3.  **Auto-Generated Code:**
    - Files with headers like \`GENERATED CODE\`, \`DO NOT EDIT\`, or extensions like \`.pb.js\`, \`.min.js\`.

4.  **Feature Flags / Progressive Rollout:**
    - Duplicate logic wrapped in feature flag conditionals (e.g., \`if (flags.v2_enabled) ... else ...\`). This is a temporary and valid state.

## Analysis Instructions

0. **Memory Compliance Pre-check (CRITICAL):**
    - If a **Memories** section is present in external context, evaluate every memory rule against the changed files before any other analysis step.
    - Treat applicable memory rules as high-priority signals and report their violations with concrete cross-file evidence.

1.  **Exhaustive Cross-Reference (CRITICAL):**
    - You MUST compare **every file against every other file** in the input.
    - Do not stop after finding the first issue. Keep scanning until all file combinations are checked.
    - Expect to find multiple distinct issues in a single review.
    - List **ALL** valid cross-file issues found.

2.  **Verify Context & Suppression:**
    - For EACH potential issue identified in step 1, check strictly against the **Suppression Criteria**.
    - If a specific issue is suppressed (e.g., by a TODO), discard ONLY that specific issue and keep the others.

3.  **Impact Filtering:**
    - Focus only on issues that require multiple file context.
    - Discard trivial single-file findings.

4.  **Provide specific evidence:**
    - Reference exact file names and line ranges.
    - Show concrete code examples.

5.  **Final Output Generation:**
    - If multiple valid issues remain after suppression, include ALL of them in the \`suggestions\` array.
    - If all are suppressed, return an empty array.

## Severity Assessment

For each confirmed issue, evaluate severity based on impact and scope:

**CRITICAL** - Immediate and severe impact
${criticalText}

**HIGH** - Significant but not immediate impact
${highText}

**MEDIUM** - Moderate impact
${mediumText}

**LOW** - Minimal impact
${lowText}

## Line-number constraints (MANDATORY)
- Numbering starts at **1** inside the corresponding __new_block__.
- relevantLinesStart = first "+" line that contains the issue.
- relevantLinesEnd = last "+" line that belongs to the same issue.
- Never use a number outside the __new_block__ range.
- If you cannot determine the correct numbers, discard the suggestion.
- Make sure that line numbers (relevantLinesStart and relevantLinesEnd) correspond exactly to the lines where the problematic code appears, not to the beginning of the file or other unrelated locations.

## Output Requirements

1. **JSON format must be strictly valid**
2. **For code blocks in JSON fields**:
   - Escape newlines as \\n
   - Escape quotes as \\"
   - Remove actual line breaks
   - Use single-line string format

Example format for code fields:
\`\`\`json
"existingCode": "function example() {\\n  const x = 1;\\n  return x;\\n}"
\`\`\`

## Output Format

### Issue description

Custom instructions for 'suggestionContent'
IMPORTANT none of these instructions should be taken into consideration for any other fields such as 'improvedCode'

${mainGenText}

### LLM Prompt

Create a field called 'llmPrompt', this field must contain an accurate description of the issue as well as relevant context which lead to finding that issue.
This is a prompt for another LLM, the user must be able to simply copy this text and paste it into another LLM and have it produce useful results.
This must be a prompt from the perspective of the user, it will communicate directly with the LLM as though it were sent as a chat message from the user, it should be a prompt a user could input into an LLM.

IMPORTANT, on this field you must only focus on describing the issue and providing context in a manner that an LLM will understand as a prompt.
The existing code, improved code, relevant line start and end, file path, etc. will all be provided elsewhere.
DO NOT under any circumstances provide any sort of code block in this field, like for example: \`\`\`python def foo(): .... \`\`\`

### Response format

Generate suggestions in JSON format:

\`\`\`json
{
    "suggestions": [
        "relevantFile": "primary affected file where suggestion will be posted",
        "relatedFile": "secondary file that shows the pattern/inconsistency",
        "language": "detected language",
        "suggestionContent": "concise description with affected files and line numbers"
        "existingCode": "problematic code pattern from multiple files",
        "improvedCode": "proposed consolidated/consistent solution",
        "oneSentenceSummary": "brief description of the cross-file issue",
        "relevantLinesStart": number,
        "relevantLinesEnd": number,
        "severity": "low | medium | high | critical",
        "llmPrompt": "Prompt for LLMs"
    ]
}
\`\`\`

## Important Notes

- **Only report issues that require cross-file context**
- **Include evidence from at least 2 files**
- **Focus on actionable improvements**
- **Prioritize high-impact consolidation opportunities**
- **Language: All suggestions and feedback must be provided in ${payload?.language || 'en-US'} language**
- **Current date: ${new Date().toLocaleDateString('en-GB')}**
`;

    const referenceSection = formatReferenceSection(
        payload?.externalReferences,
    );
    const referenceErrors = formatSyncErrors(payload?.externalReferenceErrors);

    return appendExternalContext(basePrompt, [
        memoriesBlock,
        referenceSection,
        referenceErrors,
    ]);
};
