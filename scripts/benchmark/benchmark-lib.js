const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const REPO_DIR = path.resolve(SCRIPT_DIR, '../..');
const RUNS_DIR = path.join(SCRIPT_DIR, 'runs');
const RESULTS_DIR = path.join(SCRIPT_DIR, 'results');

function loadJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function runDockerExec(container, args, timeoutMs = 60000, attempts = 3) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return execFileSync(
                'docker',
                ['exec', container, ...args],
                {
                    encoding: 'utf8',
                    timeout: timeoutMs * attempt,
                    maxBuffer: 10 * 1024 * 1024,
                },
            ).trim();
        } catch (error) {
            lastError = error;
            const isTimeout =
                error?.code === 'ETIMEDOUT' ||
                error?.signal === 'SIGTERM' ||
                /ETIMEDOUT/i.test(error?.message || '');

            if (!isTimeout || attempt === attempts) {
                const stderr = error.stderr?.toString?.().trim();
                const stdout = error.stdout?.toString?.().trim();
                throw new Error(stderr || stdout || error.message);
            }
        }
    }

    const stderr = lastError?.stderr?.toString?.().trim();
    const stdout = lastError?.stdout?.toString?.().trim();
    throw new Error(stderr || stdout || lastError?.message || 'docker exec failed');
}

function mongoEval(jsCode) {
    return runDockerExec(
        'mongodb',
        [
            'mongosh',
            '-u',
            'kodusdev',
            '-p',
            '123456',
            '--authenticationDatabase',
            'admin',
            'kodus_db',
            '--quiet',
            '--eval',
            jsCode,
        ],
        60000,
    );
}

function psqlEval(sql) {
    return runDockerExec(
        'db_postgres',
        ['psql', '-U', 'kodusdev', '-d', 'kodus_db', '-t', '-A', '-c', sql],
        60000,
    );
}

function quoteSqlLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveManifestPath(runRef) {
    if (!runRef) {
        throw new Error('Run reference is required');
    }

    if (fs.existsSync(runRef)) {
        return path.resolve(runRef);
    }

    return path.join(RUNS_DIR, `${runRef}.json`);
}

function loadManifest(runRef) {
    const manifestPath = resolveManifestPath(runRef);
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Run manifest not found: ${manifestPath}`);
    }

    const manifest = loadJson(manifestPath);
    return {
        manifestPath,
        manifest,
        runName: path.basename(manifestPath, '.json'),
    };
}

function resolveResultsDir(runRef) {
    if (!runRef) {
        throw new Error('Run reference is required');
    }

    if (fs.existsSync(runRef)) {
        return path.resolve(runRef);
    }

    return path.join(RESULTS_DIR, runRef);
}

function makePrKey(entry) {
    return `${entry.repo}#${entry.prNumber}`;
}

function makeRepositoryPrKey(entry) {
    return `${entry.repositoryId}#${entry.prNumber}`;
}

function uniqueTargets(entries) {
    const seen = new Set();
    const targets = [];

    for (const entry of entries) {
        if (!entry?.repo || !entry?.prNumber) continue;
        const prNumber = Number(entry.prNumber);
        if (!Number.isInteger(prNumber)) continue;

        const key = `${entry.repo}#${prNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);

        targets.push({
            repo: entry.repo,
            prNumber,
        });
    }

    return targets;
}

function resolvePullRequestMetadata(entries) {
    const targets = uniqueTargets(entries);
    if (!targets.length) return [];

    const jsCode = `
const targets = ${JSON.stringify(targets)};
const ors = targets.map((t) => ({ number: t.prNumber, "repository.name": t.repo }));
const docs = ors.length
  ? db.pullRequests.find(
      { $or: ors },
      { number: 1, headBranchRef: 1, createdAt: 1, updatedAt: 1, repository: 1, files: 1 }
    ).toArray()
  : [];
const best = new Map();
for (const doc of docs) {
  const key = String(doc.repository?.name || "") + "#" + String(doc.number);
  const prev = best.get(key);
  const prevTs = prev ? new Date(prev.updatedAt || prev.createdAt || 0).getTime() : 0;
  const currTs = new Date(doc.updatedAt || doc.createdAt || 0).getTime();
  if (!prev || currTs >= prevTs) best.set(key, doc);
}
print(JSON.stringify(Array.from(best.values()).map((doc) => ({
  repo: doc.repository?.name || null,
  prNumber: doc.number,
  repositoryId: doc.repository?.id ? String(doc.repository.id) : null,
  head: doc.headBranchRef || null,
  changedFiles: Array.isArray(doc.files) ? doc.files.map((f) => f.filename).filter(Boolean) : [],
  mongoCreatedAt: doc.createdAt || null,
  mongoUpdatedAt: doc.updatedAt || null,
}))));
`;

    const raw = mongoEval(jsCode);
    if (!raw) return [];
    return JSON.parse(raw);
}

function attachPullRequestMetadata(entries, metadataList) {
    const byKey = new Map(
        metadataList.map((item) => [makePrKey(item), item]),
    );

    return entries.map((entry) => ({
        ...entry,
        ...(byKey.get(makePrKey(entry)) || {}),
    }));
}

function getProcessedPairs(entries) {
    const resolved = entries.filter(
        (entry) => entry?.repositoryId && Number.isInteger(Number(entry.prNumber)),
    );
    if (!resolved.length) return [];

    const values = resolved
        .map(
            (entry) =>
                `(${quoteSqlLiteral(entry.repositoryId)}, ${Number(entry.prNumber)})`,
        )
        .join(', ');

    const sql = `
WITH targets(repository_id, pull_request_number) AS (
  VALUES ${values}
),
success AS (
  SELECT DISTINCT
    ae."repositoryId" AS repository_id,
    ae."pullRequestNumber" AS pull_request_number
  FROM automation_execution ae
  JOIN code_review_execution cre
    ON cre.automation_execution_id = ae.uuid
  JOIN targets t
    ON t.repository_id = ae."repositoryId"
   AND t.pull_request_number = ae."pullRequestNumber"
  WHERE cre.stage_name = 'Kody Review Finished'
    AND cre.status = 'success'
)
SELECT COALESCE(
  json_agg(
    json_build_object(
      'repositoryId', repository_id,
      'prNumber', pull_request_number
    )
  ),
  '[]'::json
)
FROM success;
`;

    const raw = psqlEval(sql);
    if (!raw) return [];
    return JSON.parse(raw);
}

function getLatestExecutionStageRows(entries) {
    const resolved = entries.filter(
        (entry) => entry?.repositoryId && Number.isInteger(Number(entry.prNumber)),
    );
    if (!resolved.length) return [];

    const values = resolved
        .map(
            (entry) =>
                `(${quoteSqlLiteral(entry.repositoryId)}, ${Number(entry.prNumber)})`,
        )
        .join(', ');

    const sql = `
WITH targets(repository_id, pull_request_number) AS (
  VALUES ${values}
),
latest_exec AS (
  SELECT DISTINCT ON (ae."repositoryId", ae."pullRequestNumber")
    ae.uuid AS execution_uuid,
    ae."repositoryId" AS repository_id,
    ae."pullRequestNumber" AS pull_request_number,
    ae.status AS execution_status,
    ae."createdAt" AS execution_created_at
  FROM automation_execution ae
  JOIN targets t
    ON t.repository_id = ae."repositoryId"
   AND t.pull_request_number = ae."pullRequestNumber"
  ORDER BY ae."repositoryId", ae."pullRequestNumber", ae."createdAt" DESC
)
SELECT COALESCE(
  json_agg(
    json_build_object(
      'repositoryId', le.repository_id,
      'prNumber', le.pull_request_number,
      'executionUuid', le.execution_uuid,
      'executionStatus', le.execution_status,
      'executionCreatedAt', le.execution_created_at,
      'stageName', cre.stage_name,
      'stageStatus', cre.status,
      'stageMessage', cre.message,
      'stageMetadata', cre.metadata,
      'stageFinishedAt', cre."finishedAt"
    )
    ORDER BY le.repository_id, le.pull_request_number, cre.stage_name
  ),
  '[]'::json
)
FROM latest_exec le
LEFT JOIN code_review_execution cre
  ON cre.automation_execution_id = le.execution_uuid;
`;

    const raw = psqlEval(sql);
    if (!raw) return [];
    return JSON.parse(raw);
}

module.exports = {
    REPO_DIR,
    RESULTS_DIR,
    RUNS_DIR,
    SCRIPT_DIR,
    attachPullRequestMetadata,
    getLatestExecutionStageRows,
    getProcessedPairs,
    loadJson,
    loadManifest,
    makePrKey,
    makeRepositoryPrKey,
    mongoEval,
    psqlEval,
    resolvePullRequestMetadata,
    resolveResultsDir,
    writeJson,
};
