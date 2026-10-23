const { extractCallGraph } = require('./callgraph-context');

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

async function fetchTraceWithRetry(fetchTrace, url, options = {}) {
    const { headers, maxAttempts = 5, sleep = delay } = options;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const response = await fetchTrace(url, { headers });
        if (response.ok) {
            return response.json();
        }
        if (response.status !== 429 || attempt === maxAttempts - 1) {
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
