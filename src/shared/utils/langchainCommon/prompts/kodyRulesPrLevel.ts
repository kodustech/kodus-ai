import {
    AnalysisContext,
    FileChange,
} from '@/config/types/general/codeReview.type';

export type KodyRulesPrLevelPayload = {
    pr_title: string;
    pr_description: string;
    stats: AnalysisContext['pullRequest']['stats'];
    files: Partial<FileChange>[];
    rules?: any;
    rule?: any;
    language?: string;
    externalReferencesMap?: Map<string, any[]>;
    mcpResultsMap?: Map<string, Record<string, unknown>>;
};

export const prompt_kodyrules_prlevel_analyzer = (
    payload: KodyRulesPrLevelPayload,
) => {
    return `# Cross-File Rule Classification System

## Your Role
You are a code review expert specialized in identifying cross-file rule violations in Pull Requests. Your task is to analyze PR changes and determine which cross-file rules have been violated.

## Important Guidelines
- **Focus ONLY on cross-file rules** (rules that involve multiple files)
- **Only output rules that have actual violations** - if no violation exists, don't include the rule
- **Group violations intelligently** - multiple files violating the same rule should be grouped together
- **Consider file status** - for deleted files, only flag violations when rules explicitly mention file deletion restrictions

## Input Structure

### PR Information
- **Title**: ${payload?.pr_title}
- **Description**: ${payload?.pr_description}
- **Stats**:
    - Total Additions: ${payload?.stats?.total_additions ?? 0}
    - Total Deletions: ${payload?.stats?.total_deletions ?? 0}
    - Total Files Changed: ${payload?.stats?.total_files ?? 0}
    - Total Lines Changed: ${payload?.stats?.total_lines_changed ?? 0}

### Files in PR
\`\`\`json
{
  "files": ${JSON.stringify(payload?.files || [], null, 2)}
}
\`\`\`

### Available Rules
\`\`\`json
{
  "rules": ${JSON.stringify(payload?.rules || [], null, 2)}
}
\`\`\`
${
    payload?.externalReferencesMap && payload.externalReferencesMap.size > 0
        ? `
### External Reference Files
${Array.from(payload.externalReferencesMap.entries())
    .map(([ruleUuid, refs]: [string, any[]]) => {
        const rule = payload.rules?.find((r: any) => r.uuid === ruleUuid);
        if (!rule || !refs.length) return '';
        return `
Rule: ${rule.title} (${ruleUuid})
${refs
    .map(
        (ref: any) => `  File: ${ref.filePath}
  ${ref.description ? `Purpose: ${ref.description}\n  ` : ''}Content:
${ref.content}
`,
    )
    .join('\n')}`;
    })
    .join('\n')}
`
        : ''
}
${
    payload?.mcpResultsMap && payload.mcpResultsMap.size > 0
        ? `
### External Tool Outputs
${Array.from(payload.mcpResultsMap.entries())
    .map(([ruleUuid, data]) => {
        const rule = payload.rules?.find((r: any) => r.uuid === ruleUuid);
        const outputs = (data as any)?.outputs;

        if (
            !rule ||
            !outputs ||
            !Array.isArray(outputs) ||
            outputs.length === 0
        ) {
            return '';
        }

        return `
Rule: ${rule.title} (${ruleUuid})
${outputs
    .map((aug: any, index: number) => {
        const provider = aug?.provider ?? 'unknown';
        const toolName = aug?.toolName ?? 'unknown';
        let outputContent = 'No output provided';

        if (aug?.output) {
            try {
                const parsedOutput = JSON.parse(aug.output);
                outputContent = JSON.stringify(parsedOutput, null, 2);
            } catch (e) {
                outputContent = aug.output;
            }
        }

        return `  Tool Execution #${index + 1}:
    Provider: ${provider}
    Tool: ${toolName}
    Output:
${outputContent}
`;
    })
    .join('\n')}`;
    })
    .join('\n')}
`
        : ''
}

## Analysis Process

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
---

**Now analyze the provided PR and rules to identify cross-file rule violations.**`;
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
