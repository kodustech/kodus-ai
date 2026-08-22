import z from 'zod';

export interface CrossFileContextSufficiencyPayload {
    changedFilenames: string[];
    diffSummary: string;
    language: string;
    originalQueries: Array<{
        symbolName: string;
        pattern: string;
        riskLevel: string;
        rationale: string;
        sourceFile: string;
        foundResults: boolean;
    }>;
    collectedSnippetsSummary: Array<{
        filePath: string;
        relatedSymbol?: string;
        rationale: string;
        riskLevel: string;
        hop: number;
    }>;
}

export const CrossFileContextSufficiencySchema = z.object({
    sufficient: z.boolean(),
    gaps: z.array(z.string()).max(5),
    additionalQueries: z
        .array(
            z.object({
                pattern: z.string().min(1),
                rationale: z.string().min(1),
                riskLevel: z.enum(['low', 'medium', 'high']),
                symbolName: z.string().min(1),
                fileGlob: z.string().optional(),
                sourceFile: z.string().min(1),
            }),
        )
        .max(5),
});

export type CrossFileContextSufficiencySchemaType = z.infer<
    typeof CrossFileContextSufficiencySchema
>;

export const prompt_cross_file_context_sufficiency = (
    payload: CrossFileContextSufficiencyPayload,
) => {
    const queriesWithResults = payload.originalQueries.filter(
        (q) => q.foundResults,
    );
    const queriesWithoutResults = payload.originalQueries.filter(
        (q) => !q.foundResults,
    );

    return `You are a code review context evaluator. You MUST respond with ONLY a raw JSON object — no markdown fences, no explanation, no text before or after the JSON.

## Goal
Given the PR diff, the search queries that were executed, and a summary of what was found, determine:
1. Whether the collected context is sufficient for a thorough cross-file review
2. If not, what specific gaps exist
3. Up to 5 additional search queries to fill those gaps

## Input

### Changed Files
${JSON.stringify(payload.changedFilenames, null, 2)}

### Diff Summary
${payload.diffSummary}

### Original Search Queries (${queriesWithResults.length} found results, ${queriesWithoutResults.length} found nothing)

#### Queries that found results:
${
    queriesWithResults.length > 0
        ? queriesWithResults
              .map(
                  (q) =>
                      `- **${q.symbolName}** (${q.riskLevel}): \`${q.pattern}\` — ${q.rationale}`,
              )
              .join('\n')
        : '(none)'
}

#### Queries that found NO results:
${
    queriesWithoutResults.length > 0
        ? queriesWithoutResults
              .map(
                  (q) =>
                      `- **${q.symbolName}** (${q.riskLevel}): \`${q.pattern}\` — ${q.rationale}`,
              )
              .join('\n')
        : '(none)'
}

### Collected Context Summary (${payload.collectedSnippetsSummary.length} snippets)
${
    payload.collectedSnippetsSummary.length > 0
        ? payload.collectedSnippetsSummary
              .map(
                  (s) =>
                      `- **${s.filePath}** — symbol: ${s.relatedSymbol || 'N/A'}, risk: ${s.riskLevel}, hop: ${s.hop} — ${s.rationale}`,
              )
              .join('\n')
        : '(no snippets collected)'
}

## Evaluation Criteria

Context is **sufficient** when:
1. All high-risk queries found at least some relevant results
2. Symmetric counterparts (create/validate, encode/decode, write/read) are covered
3. Direct consumers/callers of changed public APIs are present
4. No obvious gaps in coverage for the symbols that changed

Context is **insufficient** when:
1. High-risk queries returned nothing and the symbol is a public API, exported type, or shared constant
2. A symmetric counterpart operation was identified by the planner but no corresponding consumer/verifier was found
3. An imported upstream dependency's implementation was not found despite being needed to understand the changed code
4. Test files changed but no implementation was found (or vice versa)

## Rules for additional queries
- Generate at most 5 additional queries
- Do NOT repeat patterns that already ran (even if they found nothing — the codebase simply may not have those files)
- Focus on ALTERNATIVE search strategies: different symbol names, different patterns, broader/narrower globs
- Each query must follow the same format as the original planner queries
- Prefer high-risk gaps over low-risk ones

### CRITICAL: Ripgrep Pattern Rules
ripgrep searches LINE-BY-LINE. Patterns CANNOT span multiple lines.
- ❌ Do NOT use \`import\\s+{[^}]*symbol[^}]*}\` — multi-line imports will not match
- ✅ Use \`\\bsymbolName\\b\` for any reference, \`symbolName\\(\` for calls, \`from.*module\` for imports
- Keep patterns simple — a word-boundary match \`\\bsymbol\\b\` is more reliable than complex syntax patterns
- ❌ Do NOT use overly broad patterns like \`cross.*file.*context\` that match dozens of unrelated files — be specific with actual symbol names

## Output Format
You MUST return ONLY a JSON object with this exact schema — no other text:

\`\`\`
{"sufficient": <boolean>, "gaps": [<string>, ...], "additionalQueries": [<query>, ...]}
\`\`\`

Fields:
- sufficient: boolean — true if context is adequate, false if gaps exist
- gaps: string[] — brief descriptions of what is missing (max 5)
- additionalQueries: array of query objects (max 5). If sufficient is true, this MUST be an empty array. Each query object must have:
  - pattern: string — ripgrep-compatible regex (escape special chars like parentheses with \\\\)
  - rationale: string — why this search is needed
  - riskLevel: "low" | "medium" | "high"
  - symbolName: string — the symbol being searched for
  - sourceFile: string — the changed file that motivated this search
  - fileGlob: string (optional) — glob pattern to narrow the search

Example output when insufficient:
{"sufficient":false,"gaps":["Missing consumer of validateInput"],"additionalQueries":[{"pattern":"validateInput\\\\(","rationale":"Need callers","riskLevel":"high","symbolName":"validateInput","sourceFile":"src/auth.ts"}]}

Example output when sufficient:
{"sufficient":true,"gaps":[],"additionalQueries":[]}

## Language
All text must be in ${payload.language || 'en-US'}.

IMPORTANT: Your entire response must be a single valid JSON object. Do not include any text, markdown, or explanation outside the JSON.
`;
};
