#!/usr/bin/env node
/**
 * Check if a PR was processed by querying automation_execution in Postgres.
 *
 * Usage:
 *   node check-processed.js <prNumber>
 *   node check-processed.js <prNumber> <repoName>
 *
 * Outputs: "true" or "false"
 */

const {
    attachPullRequestMetadata,
    getProcessedPairs,
    psqlEval,
    resolvePullRequestMetadata,
} = require('./benchmark-lib');

function main() {
    const prNumber = Number(process.argv[2]);
    const repo = process.argv[3];

    if (!Number.isInteger(prNumber) || prNumber <= 0) {
        console.log('false');
        process.exit(0);
    }

    try {
        if (!repo) {
            // Backward-compatible fallback when only PR number is available.
            const sql = `
SELECT COUNT(*)
FROM automation_execution ae
JOIN code_review_execution cre
  ON cre.automation_execution_id = ae.uuid
WHERE ae."pullRequestNumber" = ${prNumber}
  AND cre.stage_name = 'Kody Review Finished'
  AND cre.status = 'success';
`;
            const result = Number(psqlEval(sql));
            console.log(result > 0 ? 'true' : 'false');
            process.exit(0);
        }

        const entries = attachPullRequestMetadata(
            [{ prNumber, repo }],
            resolvePullRequestMetadata([{ prNumber, repo }]),
        );

        if (!entries[0]?.repositoryId) {
            console.log('false');
            process.exit(0);
        }

        const processed = getProcessedPairs(entries);
        console.log(processed.length > 0 ? 'true' : 'false');
    } catch {
        console.log('false');
    }
}

if (require.main === module) {
    main();
}
