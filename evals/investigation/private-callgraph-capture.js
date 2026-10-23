const { extractCallGraph } = require('./callgraph-context');

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPT_TIMEOUT_MS = 30_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 60_000;
const MAX_OVERALL_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 5_000;

function traceRequests(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('private call graph manifest must be an object');
    }
    if (
        !manifest.cases ||
        typeof manifest.cases !== 'object' ||
        Array.isArray(manifest.cases)
    ) {
        throw new Error('private call graph manifest cases must be an object');
    }

    return Object.entries(manifest.cases).map(([caseId, entry]) => {
        if (
            !entry ||
            typeof entry.traceId !== 'string' ||
            !entry.traceId.trim()
        ) {
            throw new Error(`${caseId} must include a non-empty traceId`);
        }
        return { caseId, traceId: entry.traceId.trim() };
    });
}

function capturedCallGraph(request, trace) {
    const callGraph = extractCallGraph(trace?.input);
    return {
        caseId: request.caseId,
        traceId: request.traceId,
        captured: Boolean(callGraph),
        ...(callGraph ? { callGraph } : {}),
    };
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedOption(name, value, defaultValue, maximum, warn) {
    if (value === undefined) {
        return defaultValue;
    }

    if (!Number.isInteger(value) || value < 1 || value > maximum) {
        warn(
            `[capture] invalid ${name}=${String(value)}; using default ${defaultValue} (maximum ${maximum})`,
        );
        return defaultValue;
    }

    return value;
}

async function fetchTraceWithRetry(fetchTrace, url, options = {}) {
    const { headers, sleep = delay } = options;
    const warn = options.warn || console.warn;
    const attempts = boundedOption(
        'maxAttempts',
        options.maxAttempts,
        DEFAULT_MAX_ATTEMPTS,
        DEFAULT_MAX_ATTEMPTS,
        warn,
    );
    const attemptTimeoutMs = boundedOption(
        'attemptTimeoutMs',
        options.attemptTimeoutMs,
        DEFAULT_ATTEMPT_TIMEOUT_MS,
        MAX_ATTEMPT_TIMEOUT_MS,
        warn,
    );
    const overallTimeoutMs = boundedOption(
        'overallTimeoutMs',
        options.overallTimeoutMs,
        DEFAULT_OVERALL_TIMEOUT_MS,
        MAX_OVERALL_TIMEOUT_MS,
        warn,
    );
    const traceLabel =
        typeof options.traceLabel === 'string' && options.traceLabel.trim()
            ? options.traceLabel.trim()
            : 'unknown-trace';
    const onTimeout =
        options.onTimeout ||
        ((details) => {
            warn(
                `[capture] ${details.scope} timeout for ${details.traceLabel} on attempt ${details.attempt} after ${details.timeoutMs}ms`,
            );
        });
    let activeController = null;
    let activeAttempt = 0;
    let clearAttemptTimer = () => {};
    let didOverallTimeout = false;
    let rejectOverallTimeout;
    const overallDeadline = new Promise((_, reject) => {
        rejectOverallTimeout = reject;
    });
    const overallTimer = setTimeout(() => {
        didOverallTimeout = true;
        activeController?.abort();
        clearAttemptTimer();
        rejectOverallTimeout(new Error('Langfuse trace capture timed out'));
    }, overallTimeoutMs);

    try {
        return await Promise.race([
            (async () => {
                for (let attempt = 0; attempt < attempts; attempt += 1) {
                    activeAttempt = attempt + 1;
                    const controller = new AbortController();
                    activeController = controller;
                    let didAttemptTimeout = false;
                    const attemptTimer = setTimeout(() => {
                        didAttemptTimeout = true;
                        controller.abort();
                    }, attemptTimeoutMs);
                    clearAttemptTimer = () => clearTimeout(attemptTimer);
                    let response;

                    try {
                        response = await fetchTrace(url, {
                            headers,
                            signal: controller.signal,
                        });
                        if (response.ok) {
                            return await response.json();
                        }
                    } catch (error) {
                        if (didAttemptTimeout) {
                            onTimeout({
                                attempt: activeAttempt,
                                scope: 'attempt',
                                timeoutMs: attemptTimeoutMs,
                                traceLabel,
                            });
                            throw new Error('Langfuse trace request timed out');
                        }

                        throw error;
                    } finally {
                        clearAttemptTimer();
                        clearAttemptTimer = () => {};
                        if (activeController === controller) {
                            activeController = null;
                        }
                    }

                    if (response.status !== 429 || attempt === attempts - 1) {
                        throw new Error(
                            `Langfuse ${response.status} while capturing a trace`,
                        );
                    }

                    const retryAfter = Number(
                        response.headers?.get('retry-after'),
                    );
                    const retryMilliseconds = Number.isFinite(retryAfter)
                        ? Math.max(0, retryAfter * 1000)
                        : (attempt + 1) * 1000;
                    const waitMilliseconds = Math.min(
                        retryMilliseconds,
                        MAX_RETRY_DELAY_MS,
                    );
                    await Promise.race([
                        sleep(waitMilliseconds),
                        overallDeadline,
                    ]);
                }

                throw new Error('Langfuse trace capture exhausted retries');
            })(),
            overallDeadline,
        ]);
    } catch (error) {
        if (didOverallTimeout) {
            onTimeout({
                attempt: activeAttempt,
                scope: 'overall',
                timeoutMs: overallTimeoutMs,
                traceLabel,
            });
            throw new Error('Langfuse trace capture timed out');
        }

        throw error;
    } finally {
        clearTimeout(overallTimer);
        clearAttemptTimer();
    }
}

function pendingTraceRequests(requests, cases = {}) {
    return requests.filter((request) => !Object.hasOwn(cases, request.caseId));
}

module.exports = {
    capturedCallGraph,
    fetchTraceWithRetry,
    pendingTraceRequests,
    traceRequests,
};
