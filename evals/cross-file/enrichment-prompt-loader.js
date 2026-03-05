/**
 * Prompt loader for the enrichRationales() eval.
 * Constructs the exact same prompt used in production
 * (CollectCrossFileContextsService.enrichRationales).
 */
module.exports = function (context) {
    const vars = context.vars || {};
    const systemPrompt = `You are a code review context analyst. For each snippet, rewrite the rationale to describe the concrete mechanism the code uses and what concerns it eliminates.

RULES:
- Describe the MECHANISM: what the snippet code does concretely (e.g., "delegates to pg Pool.query with parameterized placeholders", "enforces ArrayMaxSize via NestJS ValidationPipe")
- If the mechanism refutes a common concern, state it: "[Concern] is not an issue because [mechanism]"
- NEVER mention concerns the snippet does NOT refute. If you cannot refute a concern from the snippet, do not mention it at all.
- Keep each rationale to 1-2 sentences. Be specific — name functions, classes, patterns visible in the code.

Diff summary:
${vars.diffSummary}

Snippets:
${vars.snippetDescriptions}

Return a JSON array: [{"index": 0, "rationale": "enriched rationale"}, ...]`;

    return [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content:
                'Analyze each snippet and rewrite its rationale based on the actual code content. Return the response as a JSON array.',
        },
    ];
};
