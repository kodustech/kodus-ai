const fs = require('fs');
const path = require('path');
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

function normalizePath(value) {
    return String(value || '')
        .replace(/^\/+/, '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');
}

function includesIgnoreCase(haystack, needle) {
    return String(haystack || '')
        .toLowerCase()
        .includes(String(needle || '').toLowerCase());
}

function matchToolCall(toolCall, expectation) {
    if (!expectation || typeof expectation !== 'object') return false;
    if (expectation.tool && toolCall.tool !== expectation.tool) return false;

    const args = toolCall.args || {};
    const actualPath =
        args.path || args.filePath || args.searchPath || args.directory;
    if (expectation.path) {
        if (normalizePath(actualPath) !== normalizePath(expectation.path)) {
            return false;
        }
    }

    if (
        expectation.pathEndsWith &&
        !normalizePath(actualPath).endsWith(normalizePath(expectation.pathEndsWith))
    ) {
        return false;
    }

    if (expectation.pattern && args.pattern !== expectation.pattern) {
        return false;
    }

    if (
        expectation.patternIncludes &&
        !String(args.pattern || '').includes(String(expectation.patternIncludes))
    ) {
        return false;
    }

    if (expectation.glob && args.glob !== expectation.glob) {
        return false;
    }

    return true;
}

function parsePositiveLine(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.trunc(parsed);
}

function normalizeReadSpan(toolCall) {
    const args = toolCall.args || {};
    const filePath = normalizePath(args.path);
    if (!filePath) return null;

    let startLine = parsePositiveLine(args.startLine);
    let endLine = parsePositiveLine(args.endLine);

    if (startLine === null && endLine !== null) startLine = 1;
    if (startLine !== null && endLine !== null && endLine < startLine) {
        endLine = startLine;
    }

    return {
        path: filePath,
        startLine,
        endLine,
    };
}

function getSpanLength(span) {
    if (span.startLine === null || span.endLine === null) return null;
    return span.endLine - span.startLine + 1;
}

function getOverlapMetrics(previousSpan, currentSpan) {
    const previousLength = getSpanLength(previousSpan);
    const currentLength = getSpanLength(currentSpan);
    if (previousLength === null || currentLength === null) return null;

    const overlapStart = Math.max(previousSpan.startLine, currentSpan.startLine);
    const overlapEnd = Math.min(previousSpan.endLine, currentSpan.endLine);
    if (overlapEnd < overlapStart) return null;

    const overlapLength = overlapEnd - overlapStart + 1;
    return {
        overlapLength,
        overlapRatioOfPrevious: overlapLength / previousLength,
        overlapRatioOfCurrent: overlapLength / currentLength,
        newLinesInCurrent: currentLength - overlapLength,
    };
}

function isRedundantRead(previousSpan, currentSpan) {
    if (
        previousSpan.startLine !== null &&
        previousSpan.endLine !== null &&
        currentSpan.startLine !== null &&
        currentSpan.endLine !== null &&
        previousSpan.startLine === currentSpan.startLine &&
        previousSpan.endLine === currentSpan.endLine
    ) {
        return true;
    }

    const overlap = getOverlapMetrics(previousSpan, currentSpan);
    if (!overlap) return false;

    return (
        overlap.overlapRatioOfCurrent >= 0.9 ||
        overlap.overlapRatioOfPrevious >= 0.9 ||
        (overlap.overlapRatioOfCurrent >= 0.75 && overlap.newLinesInCurrent <= 25)
    );
}

function countRedundantReadRanges(toolCalls) {
    const counts = new Map();
    const seenByPath = new Map();

    for (const toolCall of toolCalls) {
        if (toolCall.tool !== 'readFile') continue;
        const span = normalizeReadSpan(toolCall);
        if (!span) continue;

        const previousSpans = seenByPath.get(span.path) || [];
        if (previousSpans.some((previousSpan) => isRedundantRead(previousSpan, span))) {
            counts.set(span.path, (counts.get(span.path) || 0) + 1);
        }
        previousSpans.push(span);
        seenByPath.set(span.path, previousSpans);
    }

    return counts;
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

    const trace = parsed.trace || {};
    const toolCalls = Array.isArray(trace.toolCalls) ? trace.toolCalls : [];
    const touchedFiles = (trace.coverage?.touchedFiles || []).map(normalizePath);
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const reasoning = String(parsed.reasoning || '');
    const mode = String(context?.vars?.mode || 'planner').trim().toLowerCase();
    const enforceFindingAssertions =
        mode === 'promotion' || mode === 'hybrid' || mode === 'full';

    const expectedRequiredTools = parseExpected(
        context.vars.expectedRequiredTools,
        [],
    );
    const expectedForbiddenTools = parseExpected(
        context.vars.expectedForbiddenTools,
        [],
    );
    const expectedRequiredToolCalls = parseExpected(
        context.vars.expectedRequiredToolCalls,
        [],
    );
    const expectedForbiddenToolCalls = parseExpected(
        context.vars.expectedForbiddenToolCalls,
        [],
    );
    const expectedAnyRequiredToolCalls = parseExpected(
        context.vars.expectedAnyRequiredToolCalls,
        [],
    );
    const expectedTouchedFiles = parseExpected(
        context.vars.expectedTouchedFiles,
        [],
    ).map(normalizePath);
    const expectedReasoningIncludes = parseExpected(
        context.vars.expectedReasoningIncludes,
        [],
    );
    const expectedReasoningExcludes = parseExpected(
        context.vars.expectedReasoningExcludes,
        [],
    );
    const expectedFindingFiles = parseExpected(
        context.vars.expectedFindingFiles,
        [],
    ).map(normalizePath);
    const expectedFindingLabels = parseExpected(
        context.vars.expectedFindingLabels,
        [],
    );
    const expectedMaxSteps = parseExpected(
        context.vars.expectedMaxSteps,
        null,
    );
    const expectedMinFindings = parseExpected(
        context.vars.expectedMinFindings,
        null,
    );
    const expectedMaxFindings = parseExpected(
        context.vars.expectedMaxFindings,
        null,
    );
    const expectedMaxRepeatedReadPerFile = parseExpected(
        context.vars.expectedMaxRepeatedReadPerFile,
        null,
    );

    const usedTools = new Set(toolCalls.map((toolCall) => toolCall.tool));
    const findingFiles = findings.map((finding) =>
        normalizePath(finding.relevantFile),
    );
    const findingLabels = findings.map((finding) => finding.label).filter(Boolean);
    const redundantReadCounts = countRedundantReadRanges(toolCalls);

    const missingTools = expectedRequiredTools.filter((tool) => !usedTools.has(tool));
    const forbiddenTools = expectedForbiddenTools.filter((tool) =>
        usedTools.has(tool),
    );

    const missingToolCalls = expectedRequiredToolCalls.filter(
        (expectation) => !toolCalls.some((toolCall) => matchToolCall(toolCall, expectation)),
    );
    const missingAnyToolCallGroups = expectedAnyRequiredToolCalls.filter((group) => {
        if (!Array.isArray(group) || group.length === 0) return false;
        return !group.some((expectation) =>
            toolCalls.some((toolCall) => matchToolCall(toolCall, expectation)),
        );
    });
    const forbiddenToolCalls = expectedForbiddenToolCalls.filter((expectation) =>
        toolCalls.some((toolCall) => matchToolCall(toolCall, expectation)),
    );

    const missingTouchedFiles = expectedTouchedFiles.filter(
        (filePath) => !touchedFiles.includes(filePath),
    );

    const missingReasoning = expectedReasoningIncludes.filter(
        (term) => !includesIgnoreCase(reasoning, term),
    );
    const forbiddenReasoning = expectedReasoningExcludes.filter((term) =>
        includesIgnoreCase(reasoning, term),
    );

    const missingFindingFiles = enforceFindingAssertions
        ? expectedFindingFiles.filter((filePath) => !findingFiles.includes(filePath))
        : [];
    const missingFindingLabels = enforceFindingAssertions
        ? expectedFindingLabels.filter((label) => !findingLabels.includes(label))
        : [];

    const stepOverflow =
        typeof expectedMaxSteps === 'number' && trace.steps > expectedMaxSteps;
    const tooFewFindings =
        enforceFindingAssertions &&
        typeof expectedMinFindings === 'number' &&
        findings.length < expectedMinFindings;
    const tooManyFindings =
        enforceFindingAssertions &&
        typeof expectedMaxFindings === 'number' &&
        findings.length > expectedMaxFindings;

    const repeatedReadOverflow =
        typeof expectedMaxRepeatedReadPerFile === 'number'
            ? Array.from(redundantReadCounts.entries()).filter(
                  ([, count]) => count > expectedMaxRepeatedReadPerFile,
              )
            : [];

    const failures = [];

    if (
        !trace ||
        typeof trace.steps !== 'number' ||
        !Array.isArray(trace.toolCalls)
    ) {
        failures.push('missing-trace');
    }
    if (missingTools.length) failures.push(`missing-tools=${missingTools.join(',')}`);
    if (forbiddenTools.length)
        failures.push(`forbidden-tools=${forbiddenTools.join(',')}`);
    if (missingToolCalls.length)
        failures.push(
            `missing-tool-calls=${missingToolCalls
                .map((item) => JSON.stringify(item))
                .join(';')}`,
        );
    if (missingAnyToolCallGroups.length)
        failures.push(
            `missing-any-tool-call-group=${missingAnyToolCallGroups
                .map((group) => JSON.stringify(group))
                .join(';')}`,
        );
    if (forbiddenToolCalls.length)
        failures.push(
            `forbidden-tool-calls=${forbiddenToolCalls
                .map((item) => JSON.stringify(item))
                .join(';')}`,
        );
    if (missingTouchedFiles.length)
        failures.push(`missing-touched-files=${missingTouchedFiles.join(',')}`);
    if (missingReasoning.length)
        failures.push(`missing-reasoning=${missingReasoning.join(',')}`);
    if (forbiddenReasoning.length)
        failures.push(`forbidden-reasoning=${forbiddenReasoning.join(',')}`);
    if (missingFindingFiles.length)
        failures.push(`missing-finding-files=${missingFindingFiles.join(',')}`);
    if (missingFindingLabels.length)
        failures.push(`missing-finding-labels=${missingFindingLabels.join(',')}`);
    if (stepOverflow)
        failures.push(`steps=${trace.steps}>${expectedMaxSteps}`);
    if (tooFewFindings)
        failures.push(`findings=${findings.length}<${expectedMinFindings}`);
    if (tooManyFindings)
        failures.push(`findings=${findings.length}>${expectedMaxFindings}`);
    if (repeatedReadOverflow.length) {
        failures.push(
            `repeated-read-overflow=${repeatedReadOverflow
                .map(([filePath, count]) => `${filePath}:${count}`)
                .join(',')}`,
        );
    }

    const result = {
        pass: failures.length === 0,
        score: failures.length === 0 ? 1 : 0,
        reason: [
            `mode=${mode}`,
            `steps=${trace.steps}`,
            `tools=${toolCalls.map((toolCall) => toolCall.tool).join(',') || 'none'}`,
            `touched=${touchedFiles.join(',') || 'none'}`,
            `findings=${findings.length}`,
            failures.length ? `failures=${failures.join(' | ')}` : 'failures=none',
        ].join('\n'),
    };
    writeAssertionArtifact({
        caseId: context?.vars?.caseId || parsed.caseId || 'unknown-case',
        pass: result.pass,
        score: result.score,
        reason: result.reason,
        failures,
        mode,
        toolCalls,
        touchedFiles,
        findings,
        reasoning,
        redundantReadCounts: Object.fromEntries(redundantReadCounts),
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
