const { parseOutput } = require('./parse-output');

module.exports = (output) => {
    const parsed = parseOutput(output);
    if (!parsed) {
        return { pass: false, score: 0, reason: 'Failed to parse provider output.' };
    }

    const hasTrace =
        parsed.trace &&
        typeof parsed.trace.steps === 'number' &&
        Array.isArray(parsed.trace.toolCalls);

    if (!hasTrace) {
        return {
            pass: false,
            score: 0,
            reason: 'Missing trace payload with steps/toolCalls.',
        };
    }

    return {
        pass: true,
        score: 1,
        reason: `steps=${parsed.trace.steps} toolCalls=${parsed.trace.toolCalls.length} findings=${parsed.findings?.length || 0}`,
    };
};
