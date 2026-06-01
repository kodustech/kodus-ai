const fs = require('fs');
const path = require('path');
const { parseOutput } = require('./parse-output');

function parseExpected(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (Array.isArray(value) || typeof value === 'boolean') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function includesIgnoreCase(haystack, needle) {
    return String(haystack || '')
        .toLowerCase()
        .includes(String(needle || '').toLowerCase());
}

module.exports = (output, context) => {
    const parsed = parseOutput(output);
    if (!parsed) {
        const result = {
            pass: false,
            score: 0,
            reason: 'Failed to parse provider output.',
        };
        writeAssertionArtifact({
            caseId: context?.vars?.caseId || 'unknown-case',
            ...result,
        });
        return result;
    }

    const decision = parsed.decision || {};
    const trace = parsed.trace || {};
    const expectedKeep = Boolean(parseExpected(context?.vars?.expectedKeep, false));
    const expectedConfidenceAnyOf = parseExpected(
        context?.vars?.expectedConfidenceAnyOf,
        [],
    );
    const expectedRationaleIncludes = parseExpected(
        context?.vars?.expectedRationaleIncludes,
        [],
    );
    const expectedRationaleExcludes = parseExpected(
        context?.vars?.expectedRationaleExcludes,
        [],
    );
    const expectedMaxSteps = Number.parseInt(
        context?.vars?.expectedMaxSteps,
        10,
    );

    const failures = [];

    if (typeof decision.keep !== 'boolean') {
        failures.push('missing-decision-keep');
    } else if (decision.keep !== expectedKeep) {
        failures.push(`keep=${decision.keep} expected=${expectedKeep}`);
    }

    if (
        expectedConfidenceAnyOf.length > 0 &&
        !expectedConfidenceAnyOf.includes(decision.confidence)
    ) {
        failures.push(
            `unexpected-confidence=${decision.confidence || 'missing'}`,
        );
    }

    const rationale = String(decision.rationale || '');
    const missingRationaleTerms = expectedRationaleIncludes.filter(
        (term) => !includesIgnoreCase(rationale, term),
    );
    const presentExcludedTerms = expectedRationaleExcludes.filter((term) =>
        includesIgnoreCase(rationale, term),
    );

    if (missingRationaleTerms.length > 0) {
        failures.push(
            `missing-rationale-terms=${missingRationaleTerms.join(',')}`,
        );
    }

    if (presentExcludedTerms.length > 0) {
        failures.push(
            `excluded-rationale-terms=${presentExcludedTerms.join(',')}`,
        );
    }

    if (
        Number.isFinite(expectedMaxSteps) &&
        Number.isFinite(trace.steps) &&
        trace.steps > expectedMaxSteps
    ) {
        failures.push(`steps=${trace.steps}>${expectedMaxSteps}`);
    }

    const result = {
        pass: failures.length === 0,
        score: failures.length === 0 ? 1 : 0,
        reason: [
            `keep=${decision.keep}`,
            `confidence=${decision.confidence || 'missing'}`,
            `steps=${trace.steps ?? 'n/a'}`,
            failures.length ? `failures=${failures.join(' | ')}` : 'failures=none',
        ].join('\n'),
    };

    writeAssertionArtifact({
        caseId: context?.vars?.caseId || parsed.caseId || 'unknown-case',
        pass: result.pass,
        score: result.score,
        reason: result.reason,
        failures,
        decision,
        trace,
        expectedKeep,
    });

    return result;
};

function writeAssertionArtifact(payload) {
    try {
        fs.writeFileSync(
            path.join(__dirname, 'results', 'last-assertion.json'),
            JSON.stringify(payload, null, 2),
        );
    } catch {}
}
