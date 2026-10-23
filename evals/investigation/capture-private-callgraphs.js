#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { loadLangfuseConfig } = require('./langfuse-config');
const {
    capturedCallGraph,
    fetchTraceWithRetry,
    pendingTraceRequests,
    traceRequests,
} = require('./private-callgraph-capture');

const ROOT = path.resolve(__dirname, '../..');

function argument(name) {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? null : process.argv[index + 1] || null;
}

function outsideRepository(file) {
    const resolved = path.resolve(file);
    const relative = path.relative(ROOT, resolved);
    return relative === '..' || relative.startsWith(`..${path.sep}`);
}

function writePrivateJson(file, payload) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
        directory,
        `.${path.basename(file)}.${process.pid}.tmp`,
    );
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), {
        mode: 0o600,
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
}

function checkpointCases(file, requests) {
    if (!fs.existsSync(file)) {
        return {};
    }

    const checkpoint = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!checkpoint.cases || typeof checkpoint.cases !== 'object') {
        throw new Error(
            'private call graph checkpoint cases must be an object',
        );
    }
    for (const request of requests) {
        const captured = checkpoint.cases[request.caseId];
        if (captured && captured.traceId !== request.traceId) {
            throw new Error(
                `private call graph checkpoint does not match ${request.caseId}`,
            );
        }
    }
    return checkpoint.cases;
}

async function main() {
    const manifestPath = argument('manifest');
    const outputPath = argument('out');
    if (!manifestPath || !outputPath) {
        throw new Error(
            'usage: --manifest <private.json> --out <private.json>',
        );
    }
    if (!outsideRepository(outputPath)) {
        throw new Error('--out must be outside the repository');
    }

    const langfuse = loadLangfuseConfig({ root: ROOT });
    if (!langfuse.publicKey || !langfuse.secretKey) {
        throw new Error(
            'missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (env, ~/.kodus-dev/config, or .env)',
        );
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const requests = traceRequests(manifest);
    const authorization = `Basic ${Buffer.from(
        `${langfuse.publicKey}:${langfuse.secretKey}`,
    ).toString('base64')}`;
    const cases = checkpointCases(path.resolve(outputPath), requests);

    for (const request of pendingTraceRequests(requests, cases)) {
        const trace = await fetchTraceWithRetry(
            fetch,
            `${langfuse.baseUrl}/api/public/traces/${encodeURIComponent(request.traceId)}`,
            {
                headers: { Authorization: authorization },
                traceLabel: request.caseId,
            },
        );
        cases[request.caseId] = capturedCallGraph(request, trace);
        writePrivateJson(path.resolve(outputPath), {
            capturedAt: new Date().toISOString(),
            cases,
        });
    }
    const captured = Object.values(cases).filter(
        (entry) => entry.captured,
    ).length;
    console.log(
        `captured call graph context for ${captured}/${requests.length} private cases`,
    );
}

main().catch((error) => {
    console.error(
        `INFRA: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
});
