#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
    attachPullRequestMetadata,
    getLatestExecutionStageRows,
    loadJson,
    loadManifest,
    resolvePullRequestMetadata,
    resolveResultsDir,
    writeJson,
} = require('./benchmark-lib');

function parseArgs(argv) {
    const args = {
        runName: argv[2],
        outputDir: null,
    };

    for (let i = 3; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--output-dir') {
            args.outputDir = argv[i + 1] ? path.resolve(argv[i + 1]) : null;
            i += 1;
        }
    }

    return args;
}

function tryParseJson(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function normalizePath(value) {
    if (!value || typeof value !== 'string') return null;
    return value.replace(/^\.\//, '');
}

function basename(value) {
    const normalized = normalizePath(value);
    if (!normalized) return null;
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || normalized;
}

function matchesChangedFile(readPath, changedFile) {
    const normalizedRead = normalizePath(readPath);
    const normalizedChanged = normalizePath(changedFile);
    if (!normalizedRead || !normalizedChanged) return false;

    if (normalizedRead === normalizedChanged) return true;
    if (normalizedRead.endsWith(`/${normalizedChanged}`)) return true;
    if (normalizedChanged.endsWith(`/${normalizedRead}`)) return true;

    const readBase = basename(normalizedRead);
    const changedBase = basename(normalizedChanged);
    return Boolean(readBase && changedBase && readBase === changedBase);
}

function extractFileCandidates(toolCall) {
    const parsed = tryParseJson(toolCall.args);
    if (!parsed || typeof parsed !== 'object') return [];

    const candidates = [];
    for (const key of ['filePath', 'path', 'relativePath', 'targetFile']) {
        if (typeof parsed[key] === 'string') {
            candidates.push(parsed[key]);
        }
    }

    return candidates.map(normalizePath).filter(Boolean);
}

function buildAgentMetrics(agentRow, changedFiles) {
    const trace = agentRow.stageMetadata?.agentTrace || {};
    const toolCalls = Array.isArray(trace.toolCalls) ? trace.toolCalls : [];
    const toolSummary =
        trace.toolSummary && typeof trace.toolSummary === 'object'
            ? trace.toolSummary
            : {};

    const filesRead = new Set();
    for (const toolCall of toolCalls) {
        if (toolCall.tool !== 'readFile') continue;
        for (const candidate of extractFileCandidates(toolCall)) {
            filesRead.add(candidate);
        }
    }

    const normalizedChangedFiles = [
        ...new Set((changedFiles || []).map(normalizePath).filter(Boolean)),
    ];
    const coverage =
        trace.coverage && typeof trace.coverage === 'object'
            ? trace.coverage
            : null;
    const verification =
        trace.verification && typeof trace.verification === 'object'
            ? trace.verification
            : null;
    const anomalies =
        trace.anomalies && typeof trace.anomalies === 'object'
            ? trace.anomalies
            : null;
    const touchedChangedFiles = coverage?.touchedFiles?.length
        ? normalizedChangedFiles.filter((changedFile) =>
              coverage.touchedFiles.some((touchedFile) =>
                  matchesChangedFile(touchedFile, changedFile),
              ),
          )
        : normalizedChangedFiles.filter((changedFile) =>
              [...filesRead].some((readFilePath) =>
                  matchesChangedFile(readFilePath, changedFile),
              ),
          );

    return {
        status: agentRow.stageStatus,
        message: agentRow.stageMessage || '',
        category: trace.category || null,
        replicaIndex: trace.replicaIndex ?? null,
        replicaTotal: trace.replicaTotal ?? null,
        steps: trace.steps ?? null,
        findings: trace.findings ?? null,
        durationMs: trace.durationMs ?? null,
        totalTokens: trace.totalTokens ?? null,
        toolCalls: toolCalls.length,
        toolSummary,
        suggestionsPreview: Array.isArray(trace.suggestionsPreview)
            ? trace.suggestionsPreview
            : [],
        filesRead: [...filesRead].sort(),
        changedFilesTouched: touchedChangedFiles.sort(),
        changedFilesTouchedCount: touchedChangedFiles.length,
        changedFilesTouchedPct:
            normalizedChangedFiles.length > 0
                ? touchedChangedFiles.length / normalizedChangedFiles.length
                : 0,
        coverage,
        verification,
        anomalies,
        finishedAtMaxSteps:
            typeof agentRow.stageMessage === 'string' &&
            agentRow.stageMessage.includes('step limit'),
        recoveredViaSecondChance:
            typeof agentRow.stageMessage === 'string' &&
            agentRow.stageMessage.includes('second-chance'),
    };
}

function getBaseAgentName(agentName, metrics) {
    if (metrics?.category) return metrics.category;

    return agentName.replace(/-r\d+$/i, '').replace(/-\d+of\d+$/i, '');
}

function aggregateReplicaMetrics(agentName, replicas) {
    if (!replicas.length) return null;
    if (replicas.length === 1) return replicas[0].metrics;

    const changedFilesTouched = new Set();
    const filesRead = new Set();
    const suggestionsPreview = [];
    let maxReplicaTotal = 0;

    for (const replica of replicas) {
        for (const file of replica.metrics.changedFilesTouched || []) {
            changedFilesTouched.add(file);
        }
        for (const file of replica.metrics.filesRead || []) {
            filesRead.add(file);
        }
        for (const preview of replica.metrics.suggestionsPreview || []) {
            suggestionsPreview.push(preview);
        }
        maxReplicaTotal = Math.max(
            maxReplicaTotal,
            replica.metrics.replicaTotal || 0,
        );
    }

    const sortedReplicas = [...replicas].sort((left, right) =>
        left.name.localeCompare(right.name),
    );
    const primary = sortedReplicas[0].metrics;

    return {
        ...primary,
        category: primary.category || agentName,
        status: sortedReplicas.every(
            (replica) => replica.metrics.status === 'success',
        )
            ? 'success'
            : sortedReplicas.some(
                    (replica) => replica.metrics.status === 'error',
                )
              ? 'mixed'
              : primary.status,
        replicaIndex: null,
        replicaTotal: maxReplicaTotal || sortedReplicas.length,
        replicaNames: sortedReplicas.map((replica) => replica.name),
        steps: sortedReplicas.reduce(
            (sum, replica) => sum + (replica.metrics.steps || 0),
            0,
        ),
        findings: sortedReplicas.reduce(
            (sum, replica) => sum + (replica.metrics.findings || 0),
            0,
        ),
        durationMs: sortedReplicas.reduce(
            (sum, replica) => sum + (replica.metrics.durationMs || 0),
            0,
        ),
        totalTokens: sortedReplicas.reduce(
            (sum, replica) => sum + (replica.metrics.totalTokens || 0),
            0,
        ),
        toolCalls: sortedReplicas.reduce(
            (sum, replica) => sum + (replica.metrics.toolCalls || 0),
            0,
        ),
        filesRead: [...filesRead].sort(),
        changedFilesTouched: [...changedFilesTouched].sort(),
        changedFilesTouchedCount: changedFilesTouched.size,
        changedFilesTouchedPct:
            primary.coverage?.totalCount && primary.coverage.totalCount > 0
                ? changedFilesTouched.size / primary.coverage.totalCount
                : primary.changedFilesTouchedPct,
        suggestionsPreview: suggestionsPreview.slice(0, 20),
        replicas: sortedReplicas.map((replica) => ({
            name: replica.name,
            ...replica.metrics,
        })),
    };
}

function main() {
    const { runName, outputDir } = parseArgs(process.argv);
    if (!runName) {
        process.stderr.write(
            'Usage: node export-trace-metrics.js <run-name> [--output-dir <dir>]\n',
        );
        process.exit(1);
    }

    const { manifest } = loadManifest(runName);
    const resultsDir = resolveResultsDir(runName);
    const prMetadataPath = path.join(resultsDir, 'pr-metadata.json');
    const prMetadataPayload = fs.existsSync(prMetadataPath)
        ? loadJson(prMetadataPath)
        : null;
    const prMetadata = prMetadataPayload?.prs || null;

    const baseEntries = prMetadata || manifest.prs;
    const metadata = resolvePullRequestMetadata(baseEntries);
    const enriched = attachPullRequestMetadata(baseEntries, metadata).filter(
        (entry) => entry.prNumber && entry.repositoryId,
    );

    const stageRows = getLatestExecutionStageRows(enriched);
    const stageGroups = new Map();

    for (const row of stageRows) {
        const key = `${row.repositoryId}#${row.prNumber}`;
        if (!stageGroups.has(key)) {
            stageGroups.set(key, []);
        }
        stageGroups.get(key).push(row);
    }

    const prSummaries = enriched.map((entry) => {
        const key = `${entry.repositoryId}#${entry.prNumber}`;
        const rows = stageGroups.get(key) || [];
        const changedFiles = entry.changedFiles || [];
        const rawAgents = {};
        const agentReplicas = {};
        const agentReviewStage = rows.find(
            (row) => row.stageName === 'AgentReviewStage',
        );
        const dedup =
            agentReviewStage?.stageMetadata?.dedupTrace &&
            typeof agentReviewStage.stageMetadata.dedupTrace === 'object'
                ? agentReviewStage.stageMetadata.dedupTrace
                : null;

        for (const row of rows) {
            if (!row.stageName?.startsWith('AgentReview::')) continue;
            const agentName = row.stageName.replace('AgentReview::', '');
            const metrics = buildAgentMetrics(row, changedFiles);
            rawAgents[agentName] = metrics;

            const baseAgentName = getBaseAgentName(agentName, metrics);
            if (!agentReplicas[baseAgentName]) {
                agentReplicas[baseAgentName] = [];
            }
            agentReplicas[baseAgentName].push({
                name: agentName,
                metrics,
            });
        }

        const agents = { ...rawAgents };
        for (const [baseAgentName, replicas] of Object.entries(agentReplicas)) {
            if (agents[baseAgentName]) continue;
            const aggregate = aggregateReplicaMetrics(baseAgentName, replicas);
            if (aggregate) {
                agents[baseAgentName] = aggregate;
            }
        }

        const finishedStage = rows.find(
            (row) => row.stageName === 'Kody Review Finished',
        );

        return {
            repo: entry.repo,
            head: entry.head,
            title: entry.title,
            prNumber: entry.prNumber,
            repositoryId: entry.repositoryId,
            changedFiles,
            changedFilesCount: changedFiles.length,
            execution: {
                uuid: rows[0]?.executionUuid || null,
                status: rows[0]?.executionStatus || null,
                createdAt: rows[0]?.executionCreatedAt || null,
            },
            dedup,
            finishedStage: finishedStage
                ? {
                      status: finishedStage.stageStatus,
                      finishedAt: finishedStage.stageFinishedAt,
                  }
                : null,
            agents,
            agentReplicas,
        };
    });

    const summary = {
        generatedAt: new Date().toISOString(),
        runName,
        benchmarkConfig:
            prMetadataPayload?.benchmarkConfig ||
            manifest.benchmarkConfig ||
            null,
        prs: prSummaries,
        aggregates: {
            prs: prSummaries.length,
            bug: {
                avgSteps:
                    prSummaries.reduce(
                        (sum, pr) => sum + (pr.agents.bug?.steps || 0),
                        0,
                    ) / (prSummaries.length || 1),
            },
            security: {
                avgSteps:
                    prSummaries.reduce(
                        (sum, pr) => sum + (pr.agents.security?.steps || 0),
                        0,
                    ) / (prSummaries.length || 1),
            },
            performance: {
                avgSteps:
                    prSummaries.reduce(
                        (sum, pr) => sum + (pr.agents.performance?.steps || 0),
                        0,
                    ) / (prSummaries.length || 1),
            },
            dedup: {
                runsWithTrace: prSummaries.filter((pr) => pr.dedup).length,
                totalRemoved: prSummaries.reduce(
                    (sum, pr) => sum + (pr.dedup?.removedCount || 0),
                    0,
                ),
                totalGroups: prSummaries.reduce(
                    (sum, pr) => sum + (pr.dedup?.groupsCount || 0),
                    0,
                ),
            },
        },
    };

    const targetDir = outputDir || resultsDir;
    fs.mkdirSync(targetDir, { recursive: true });
    writeJson(path.join(targetDir, `${runName}-trace-metrics.json`), summary);

    process.stdout.write(
        `trace metrics exported to ${path.join(targetDir, `${runName}-trace-metrics.json`)}\n`,
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }
}
