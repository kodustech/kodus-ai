import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

export const prompt_severity_analysis_user = (
    codeSuggestions: Partial<CodeSuggestion>[],
) => {
    return `# Code Review Severity Analyzer
You are an expert code reviewer tasked with analyzing code suggestions and assigning accurate severity levels based on real impact.

## Flag-Based Severity System
For each suggestion, identify any of these severity flags:

## CRITICAL FLAGS
- Runtime failures or exceptions in normal operation
- Security vulnerabilities allowing unauthorized access
- Data corruption, loss, or integrity issues
- Core functionality not executing as intended
- Infinite loops or application freezes
- Operations that create values but never use them when required for functionality
- Transformations whose results are discarded when needed for program correctness
- Authentication/authorization bypass possibilities
- Missing validation on security-critical operations
- SQL Injection

## HIGH FLAGS
- Incorrect output with immediate crashes
- Resource leaks (memory, connections, files)
- Severe performance degradation under normal load
- Logic errors affecting business rules
- Missing validation on important data
- Potential null/undefined reference issues
- Race conditions in common scenarios

## MEDIUM FLAGS
- Code structure affecting maintainability
- Minor resource inefficiencies
- Inconsistent error handling in secondary paths
- Deprecated API usage
- Moderate performance inefficiencies
- Minor security best practices violations
- Edge cases without proper handling
- Improper error handling in primary workflows

## LOW FLAGS
- Style and formatting issues
- Documentation improvements
- Minor naming suggestions
- Unused imports or declarations
- Simple refactoring opportunities
- Alternative implementation suggestions

## Severity Decision Process
1. IF ANY Critical Flag is present → CRITICAL
2. IF ANY High Flag is present (and no Critical Flags) → HIGH
3. IF ANY Medium Flag is present (and no Critical/High Flags) → MEDIUM
4. IF ONLY Low Flags are present → LOW

## Important Principles
1. **Functionality comes first:** Any code that fails to perform its intended operation is CRITICAL.
2. **Security issues vary by exploitability:** All security issues are at least HIGH, becoming CRITICAL if easily exploitable.
3. **Runtime errors are serious:** Runtime exceptions are at minimum HIGH, becoming CRITICAL in main flows.
4. **Category is secondary to impact:** A style issue hiding a potential crash is not LOW.
5. **Flags override category:** Critical issues are CRITICAL regardless of their category label.
6. **Error handling context matters:** Missing try-catch blocks are generally MEDIUM severity since the error might be handled in another layer of the application that isn't visible in the code sample.

## Response Format
Respond ONLY with the suggestion ID and severity level in this exact format:
\`\`\`
{
  "codeSuggestions": [
    {
      "id": string,
      "severity": "high"
    },
    {
      "id": string,
      "severity": "critical"
    },
    {
      "id": string,
      "severity": "medium"
    },
    ...
  ]
}
\`\`\`
No explanations or additional text.

## Suggestions to Analyze
\`\`\`json
${JSON.stringify(codeSuggestions)}
\`\`\`
`;
};
