#!/usr/bin/env node

const {
    attachPullRequestMetadata,
    getProcessedPairs,
    loadManifest,
    makeRepositoryPrKey,
    resolvePullRequestMetadata,
} = require('./benchmark-lib');

function parseArgs(argv) {
    const args = {
        runName: argv[2],
        intervalSec: 20,
        timeoutMin: 90,
        quiet: false,
    };

    for (let i = 3; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--quiet') {
            args.quiet = true;
            continue;
        }
        if (arg === '--interval-sec') {
            args.intervalSec = Number(argv[i + 1] || 20);
            i += 1;
            continue;
        }
        if (arg === '--timeout-min') {
            args.timeoutMin = Number(argv[i + 1] || 90);
            i += 1;
            continue;
        }
    }

    return args;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStatus(entries) {
    const metadata = resolvePullRequestMetadata(entries);
    const enriched = attachPullRequestMetadata(entries, metadata);
    const processedPairs = new Set(
        getProcessedPairs(enriched).map((item) => makeRepositoryPrKey(item)),
    );

    const statuses = enriched.map((entry) => ({
        ...entry,
        processed: entry.repositoryId
            ? processedPairs.has(makeRepositoryPrKey(entry))
            : false,
        mappedInManifest: Boolean(entry.prNumber),
        resolvedInMongo: Boolean(entry.repositoryId),
    }));

    const mapped = statuses.filter((entry) => entry.mappedInManifest);
    const resolved = mapped.filter((entry) => entry.resolvedInMongo);
    const processed = mapped.filter((entry) => entry.processed);

    return {
        statuses,
        summary: {
            total: entries.length,
            mapped: mapped.length,
            resolved: resolved.length,
            processed: processed.length,
            pending: mapped.length - processed.length,
        },
    };
}

function printSummary(runName, status) {
    const { summary, statuses } = status;
    process.stdout.write(
        `[benchmark:${runName}] mapped=${summary.mapped}/${summary.total} resolved=${summary.resolved}/${summary.mapped} processed=${summary.processed}/${summary.mapped} pending=${summary.pending}\n`,
    );

    const pending = statuses.filter(
        (entry) => entry.mappedInManifest && !entry.processed,
    );

    for (const entry of pending.slice(0, 6)) {
        const state = !entry.resolvedInMongo
            ? 'awaiting-mongo'
            : 'awaiting-finished-stage';
        process.stdout.write(
            `  - ${entry.repo} PR#${entry.prNumber} ${entry.head || ''} [${state}]\n`,
        );
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (!args.runName) {
        process.stderr.write(
            'Usage: node wait-for-run.js <run-name> [--interval-sec 20] [--timeout-min 90] [--quiet]\n',
        );
        process.exit(1);
    }

    const { manifest, runName } = loadManifest(args.runName);
    const entries = manifest.prs || [];
    const mappedEntries = entries.filter((entry) => entry.prNumber);

    if (!mappedEntries.length) {
        process.stderr.write(
            `Run ${runName} has no mapped PR numbers in its manifest.\n`,
        );
        process.exit(1);
    }

    const deadline = Date.now() + args.timeoutMin * 60 * 1000;
    let lastFingerprint = '';

    while (Date.now() < deadline) {
        let status;
        try {
            status = buildStatus(entries);
        } catch (error) {
            if (!args.quiet) {
                process.stdout.write(
                    `[benchmark:${runName}] transient polling error: ${error.message}\n`,
                );
            }
            await sleep(args.intervalSec * 1000);
            continue;
        }
        const fingerprint = JSON.stringify(status.summary);

        if (!args.quiet && fingerprint !== lastFingerprint) {
            printSummary(runName, status);
            lastFingerprint = fingerprint;
        }

        if (
            status.summary.mapped > 0 &&
            status.summary.processed === status.summary.mapped
        ) {
            if (!args.quiet) {
                process.stdout.write(
                    `[benchmark:${runName}] completed: all ${status.summary.mapped} mapped PRs reached "Kody Review Finished = success".\n`,
                );
            }
            process.exit(0);
        }

        await sleep(args.intervalSec * 1000);
    }

    const finalStatus = buildStatus(entries);
    printSummary(runName, finalStatus);
    process.stderr.write(
        `[benchmark:${runName}] timeout after ${args.timeoutMin} minutes.\n`,
    );
    process.exit(2);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    });
}
