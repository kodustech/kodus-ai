const { extractCallGraph } = require('./callgraph-context');

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;

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

function boundedMaxAttempts(maxAttempts) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        return DEFAULT_MAX_ATTEMPTS;
    }

    return Math.min(maxAttempts, DEFAULT_MAX_ATTEMPTS);
}

function boundedAttemptTimeout(attemptTimeoutMs) {
    if (!Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
        return DEFAULT_ATTEMPT_TIMEOUT_MS;
    }

    return attemptTimeoutMs;
}

async function fetchTraceWithRetry(fetchTrace, url, options = {}) {
    const {
        headers,
        maxAttempts,
        sleep = delay,
        attemptTimeoutMs,
        onTimeout = (timeout) => {
            console.warn(
                `[capture] Langfuse trace request timed out after ${timeout}ms`,
            );
        },
    } = options;
    const attempts = boundedMaxAttempts(maxAttempts);
    const timeout = boundedAttemptTimeout(attemptTimeoutMs);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const controller = new AbortController();
        let didTimeout = false;
        const timer = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeout);
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
            if (didTimeout) {
                onTimeout(timeout);
                throw new Error('Langfuse trace request timed out');
            }

            throw error;
        } finally {
            clearTimeout(timer);
        }

        if (response.status !== 429 || attempt === attempts - 1) {
            throw new Error(
                `Langfuse ${response.status} while capturing a trace`,
            );
        }

        const retryAfter = Number(response.headers?.get('retry-after'));
        const waitMilliseconds = Number.isFinite(retryAfter)
            ? Math.max(0, retryAfter * 1000)
            : (attempt + 1) * 1000;
        await sleep(waitMilliseconds);
    }

    throw new Error('Langfuse trace capture exhausted retries');
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
