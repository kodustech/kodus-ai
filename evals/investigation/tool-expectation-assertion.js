const { parseOutput } = require('./parse-output');

function parseExpected(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (Array.isArray(value) || typeof value === 'number') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

module.exports = (output, context) => {
    const parsed = parseOutput(output);
    if (!parsed) {
        return { pass: false, score: 0, reason: 'Failed to parse provider output.' };
    }

    const expectedRequiredTools = parseExpected(
        context.vars.expectedRequiredTools,
        [],
    );
    const expectedForbiddenTools = parseExpected(
        context.vars.expectedForbiddenTools,
        [],
    );
    const expectedMaxSteps = parseExpected(
        context.vars.expectedMaxSteps,
        null,
    );

    const usedTools = new Set(
        (parsed.trace?.toolCalls || []).map((toolCall) => toolCall.tool),
    );

    const missing = expectedRequiredTools.filter((tool) => !usedTools.has(tool));
    const forbidden = expectedForbiddenTools.filter((tool) => usedTools.has(tool));
    const stepOverflow =
        typeof expectedMaxSteps === 'number' &&
        (typeof parsed.trace?.steps !== 'number' ||
            parsed.trace.steps > expectedMaxSteps);

    const score =
        missing.length === 0 && forbidden.length === 0 && !stepOverflow ? 1 : 0;

    return {
        pass: score === 1,
        score,
        reason: [
            `usedTools=${Array.from(usedTools).join(', ') || 'none'}`,
            missing.length ? `missing=${missing.join(', ')}` : 'missing=none',
            forbidden.length
                ? `forbidden=${forbidden.join(', ')}`
                : 'forbidden=none',
            stepOverflow
                ? `steps=${parsed.trace?.steps} > expectedMaxSteps=${expectedMaxSteps}`
                : `steps=${parsed.trace?.steps}`,
        ].join('\n'),
    };
};
