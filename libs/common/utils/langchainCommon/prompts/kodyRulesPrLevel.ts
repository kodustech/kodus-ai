import {
    AnalysisContext,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { getTextOrDefault, sanitizePromptText } from './prompt.helpers';

export type KodyRulesPrLevelPayload = {
    pr_title: string;
    pr_description: string;
    pr_author?: string;
    tags?: string[];
    stats: AnalysisContext['pullRequest']['stats'];
    files: FileChange[];
    rules?: any;
    rule?: any;
    language?: string;
    externalReferencesMap?: Map<string, any[]>;
    mcpResultsMap?: Map<string, Record<string, unknown>>;
    memories?: Array<{
        title?: string;
        rule?: string;
    }>;
};

function formatMemoriesSection(
    memories: KodyRulesPrLevelPayload['memories'],
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

function formatReferenceSection(references: unknown[] | undefined): string {
    if (!Array.isArray(references) || !references.length) {
        return '';
    }

    return (references as Array<Record<string, unknown>>)
        .filter(Boolean)
        .map((ref) => {
            const lineRangeInfo = ref.lineRange
                ? ` (lines ${(ref.lineRange as Record<string, unknown>).start}-${(ref.lineRange as Record<string, unknown>).end})`
                : '';
            const header = `### Source: File - ${ref.filePath}${lineRangeInfo}`;
            return `${header}\n${ref.content}`;
        })
        .join('\n\n');
}

function formatExternalReferencesMapSection(
    externalReferencesMap: KodyRulesPrLevelPayload['externalReferencesMap'],
): string {
    if (!externalReferencesMap || !externalReferencesMap.size) {
        return '';
    }

    const sections = Array.from(externalReferencesMap.entries())
        .map(([ruleUuid, refs]) => {
            const referencesSection = formatReferenceSection(refs);
            if (!referencesSection) {
                return '';
            }

            return `### Source: Rule References - ${ruleUuid}\n\n${referencesSection}`;
        })
        .filter(Boolean);

    return sections.join('\n\n---\n\n');
}

function formatMcpResultsSection(
    mcpResultsMap: KodyRulesPrLevelPayload['mcpResultsMap'],
): string {
    if (!mcpResultsMap || !mcpResultsMap.size) {
        return '';
    }

    const blocks = Array.from(mcpResultsMap.entries())
        .map(([ruleUuid, data]) => {
            const outputs = (data as Record<string, unknown>)?.outputs;
            if (!Array.isArray(outputs) || !outputs.length) {
                return '';
            }

            const entries = outputs
                .map((aug: unknown, index: number) => {
                    const output = (aug ?? {}) as Record<string, unknown>;
                    const provider = output.provider ?? 'unknown';
                    const toolName = output.toolName ?? 'unknown';
                    const outputContent = output.output ?? 'No output provided';

                    return `Tool Execution #${index + 1}:\nProvider: ${provider}\nTool: ${toolName}\nOutput:\n${outputContent}`;
                })
                .join('\n\n');

            return `### Source: MCP Tools - ${ruleUuid}\n\n${entries}`;
        })
        .filter(Boolean);

    return blocks.join('\n\n---\n\n');
}

function appendExternalContext(basePrompt: string, sections: string[]): string {
    const contextBlocks = sections.filter((section) => section?.trim().length);

    if (!contextBlocks.length) {
        return basePrompt;
    }

    return `${basePrompt}\n\n## External Context & Injected Knowledge\n\nThe following information is provided to ground your analysis in the broader system reality. Use this as your source of truth.\n\n---\n\n${contextBlocks.join('\n\n---\n\n')}`;
}

export const prompt_kodyrules_prlevel_analyzer = (
    payload: KodyRulesPrLevelPayload,
) => {
    const memoriesBlock = formatMemoriesSection(payload?.memories);
    const externalReferencesSection = formatExternalReferencesMapSection(
        payload?.externalReferencesMap,
    );
    const mcpSection = formatMcpResultsSection(payload?.mcpResultsMap);

    const basePrompt = `# Cross-File Rule Classification System

## Your Role
You are a code review expert specialized in identifying cross-file rule violations in Pull Requests. Your task is to analyze PR changes and determine which cross-file rules have been violated.

## Important Guidelines
- **Focus ONLY on cross-file rules** (rules that involve multiple files)
- **Only output rules that have actual violations** - if no violation exists, don't include the rule
- **Group violations intelligently** - multiple files violating the same rule should be grouped together
- **Consider file status** - for deleted files, only flag violations when rules explicitly mention file deletion restrictions
- **Memory rules precedence** - if a Memories section is present in external context, evaluate those rules first as high-priority guidance and surface applicable violations with concrete evidence

## Input Structure

### PR Information
- **Title**: ${payload?.pr_title}
- **Author**: ${payload?.pr_author || 'Unknown'}
- **Description**: ${payload?.pr_description}
- **Tags**: ${payload?.tags?.join(', ') || 'None'}
- **Stats**:
    - Total Additions: ${payload?.stats?.total_additions ?? 0}
    - Total Deletions: ${payload?.stats?.total_deletions ?? 0}
    - Total Files Changed: ${payload?.stats?.total_files ?? 0}
    - Total Lines Changed: ${payload?.stats?.total_lines_changed ?? 0}

### Files in PR
\`\`\`json
{
  "files": ${JSON.stringify(
      payload?.files.map((file: FileChange) => ({
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          filename: file.filename,
          codeDiff: file.patch,
      })) ?? [],
      null,
      2,
  )}
}
\`\`\`

### Available Rules
\`\`\`json
{
  "rules": ${JSON.stringify(payload?.rules || [])}
}
\`\`\`

## Analysis Process

### Step 0: Memory Compliance Pre-check
If external context contains **Memories**, evaluate each memory rule against the PR changes before rule applicability checks.
- Prioritize reporting violations that directly match applicable memory rules.
- Do not ignore applicable memory rules due to subtlety.
- If memory rule guidance conflicts with explicit visible code evidence, prioritize visible code evidence.

### Step 1: Rule Applicability
For each rule, determine:
1. Does this rule apply to any files in the PR?
2. Are there actual violations based on the changes?
3. Which files are involved in the violation?

### Step 2: Violation Classification
For each violation, identify:
- **Primary File**: The main file that triggered the rule (null if rule applies to PR level or multiple files equally)
- **Related Files**: All other files involved (including files that should exist but don't, or files outside the PR that are referenced by the rule)
- **Reason**: Clear explanation of why this is considered a violation

### Step 3: Grouping
- Group multiple violations of the same rule into a single rule entry
- Each violation within a rule should represent a logical grouping of related files

## Output Format

Return a JSON array containing only rules that have violations:

\`\`\`json
[
  {
    "ruleId": "rule-uuid-here",
    "violations": [
      {
        "violatedFileSha": ["file-sha-1", "file-sha-2"], // The file/files that violated the rule
        "relatedFileSha": ["file-sha-3", "file-sha-5"], // The file/files that are related to the violation
        "oneSentenceSummary": "Concise summary of what needs to be done",
        "suggestionContent": "Detailed explanation of the violation and specific steps to fix it. Always end with: Kody Rule violation: rule-id-here"
      }
    ]
  }
]
\`\`\`

## Examples

### Example 1: Route Documentation
**Scenario**: Controller adds new route but documentation missing
\`\`\`json
{
  "ruleId": "rule-uuid",
  "violations": [
    {
      "violatedFileSha": "user-controller",
      "relatedFileSha": ["routes-json"],
      "oneSentenceSummary": "Add documentation for the new /api/users route in routes.json",
      "suggestionContent": "The new route /api/users was added in the controller but routes.json was not updated. Please add an entry for this route in the routes.json file following the existing format. Kody Rule violation: route-documentation"
    }
  ]
}
\`\`\`

### Example 2: PR Level Rule
**Scenario**: PR missing description
\`\`\`json
[
  {
    "ruleId": "rule-uuid",
    "violations": [
      {
        "violatedFileSha": null,
        "relatedFileSha": [],
        "oneSentenceSummary": "Add a description to the pull request",
        "suggestionContent": "Pull request description is empty but is required for all PRs. Kody Rule violation: pr-description-required"
      }
    ]
  }
]
\`\`\`

### Example 3: Business Logic Separation
**Scenario**: Controller contains business logic that should be in service classes
\`\`\`json
{
  "ruleId": "rule-uuid",
  "violations": [
    {
      "violatedFileSha": ["user-controller", "product-controller"],
      "relatedFileSha": ["user-service", "product-service"],
      "oneSentenceSummary": "Move business logic from UserController to UserService and ProductController to ProductService",
      "suggestionContent": "The recoveryPassword method in UserController contains business logic (token generation, user update, sending email) that should be moved to UserService. Create or update UserService to handle this logic and have the controller call the service method instead. Kody Rule violation: business-logic-separation"
    }
  ]
}
\`\`\`

## Key Reminders
- **Empty output is valid** - if no cross-file rules are violated, return \`[]\`
- **Don't invent violations** - only flag actual rule violations based on the provided rules and PR changes
- **Consider file relationships** - a rule might reference files not in the PR (include them in relatedFileIds)
- **Be specific in reasons** - explain exactly what was expected vs what was found
- **Generate actionable suggestions** - provide oneSentenceSummary and detailed suggestionContent for each violation
- **Always include rule reference** - end suggestionContent with "Kody Rule violation: [rule-id]"
- **Base suggestions on actual context** - use the provided code diffs and file information to generate specific guidance
- **Language: All suggestions and feedback must be provided in ${payload?.language || 'en-US'} language**
- **Current date: ${new Date().toLocaleDateString('en-GB')}**
---

**Now analyze the provided PR and rules to identify cross-file rule violations.**`;

    return appendExternalContext(basePrompt, [
        memoriesBlock,
        externalReferencesSection,
        mcpSection,
    ]);
};

export const prompt_kodyrules_prlevel_group_rules = (payload: any) => {
    return `# Rule Violation Consolidation System

## Your Role
You are a specialized assistant for consolidating duplicate rule violations into cohesive comments.

## Task
Consolidate multiple violations of the same rule into a single, well-structured comment.

## Consolidation Rules
1. **Identical violations**: If violations contain identical text, return only once
2. **Different file/element references**: Combine all files/elements into a single comprehensive comment
3. **Preserve tone and format**: Maintain the original style and professional tone
4. **Preserve all important information**: Keep all file names, specific details, and context
5. **Logical grouping**: Group related violations naturally in the consolidated text

## Input Data
- **Rule Title**: ${payload?.rule?.title || 'Unknown Rule'}
- **Rule Description**: ${payload?.rule?.description || 'No description available'}
- **Language**: ${payload?.language || 'en-US'}

## Violations to Consolidate:
${(payload?.violations || [])
    .map(
        (v: any, i: number) => `
### Violation ${i + 1}
${v.reason}
Violated File Sha: ${v.violatedFileSha}
Related File Sha: ${v.relatedFileSha}
`,
    )
    .join('\n')}

## Output Instructions
- Return ONLY the output JSON in the following format:
\`\`\`json
{
  "ruleId": "rule-uuid-here",
  "violations": [
    {
      "violatedFileSha": ["file-sha-1", "file-sha-2"], // The file/files that violated the rule
      "relatedFileSha": ["file-sha-3", "file-sha-5"], // The file/files that are related to the violation
      "oneSentenceSummary": "Concise summary of what needs to be done",
      "suggestionContent": "Detailed explanation of the violation and specific steps to fix it. Always end with: Kody Rule violation: rule-id-here"
    }
  ]
}
\`\`\`
- Do NOT add extra formatting, headers, or explanations
- Keep the same professional tone as the original violations
- Ensure all file names and specific details are preserved
- Respond in the specified language (${payload?.language || 'en-US'})
- Maintain the existing "Kody Rule violation:" reference at the end if present

## Example Consolidation
**Input Violations**:
1. "O arquivo de serviço AcompanhamentoNutricionalService.cs foi adicionado, mas o arquivo de teste correspondente não foi encontrado. Kody Rule violation: service-test-required"
2. "O arquivo de serviço QuestionarioService.cs foi adicionado, mas o arquivo de teste correspondente não foi encontrado. Kody Rule violation: service-test-required"

**Expected Output**:
"Os arquivos de serviço AcompanhamentoNutricionalService.cs e QuestionarioService.cs foram adicionados, mas os arquivos de teste correspondentes não foram encontrados no Pull Request. É necessário adicionar testes para as novas funcionalidades de serviço para garantir a qualidade e o funcionamento correto. Kody Rule violation: service-test-required"

---

**Now consolidate the provided violations into a single coherent comment:**`;
};
