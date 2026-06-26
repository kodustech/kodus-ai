/**
 * Builds finder-RECALL test cases from the per-PR investigation datasets,
 * reusing their benchmark-grounded vars (real diff, goldenComments, deterministic
 * toolReplay) but swapping the tool-use assertion for recall-assertion.js.
 *
 * Default: one PR per repo (cheap smoke, matches the rollout plan). Override:
 *   RECALL_ALL=1                       → every per-PR case
 *   RECALL_CASES=caseId1,caseId2,...   → an explicit subset
 */
const fs = require('fs');
const path = require('path');

const DATASETS_DIR = path.join(__dirname, 'datasets');

// One per repo (cal.com / sentry / grafana-codex / keycloak / discourse-cursor).
const DEFAULT_CASES = [
    'feat-2fa-backup-codes-cal-com',
    'feat-upsampling-support-upsampled-error-count-with-performance-optimizations-sentry',
    'frontend-asset-optimization-grafana-codex',
    'fixing-re-authentication-with-passkeys-keycloak',
    'add-comprehensive-email-validation-for-blocked-users-discourse-cursor',
];

module.exports = async () => {
    const all = process.env.RECALL_ALL === '1';
    const only = (process.env.RECALL_CASES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const files = fs
        .readdirSync(DATASETS_DIR)
        .filter((f) => f.endsWith('.json') && f !== 'smoke.json');

    const tests = [];
    for (const file of files) {
        const caseId = file.replace(/\.json$/, '');
        const include = all
            ? true
            : only.length
              ? only.includes(caseId)
              : DEFAULT_CASES.includes(caseId);
        if (!include) continue;

        const raw = JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, file), 'utf8'));
        const c = Array.isArray(raw) ? raw[0] : raw;
        tests.push({
            description: `recall: ${caseId}`,
            vars: c.vars,
            assert: [{ type: 'javascript', value: 'file://recall-assertion.js' }],
        });
    }
    return tests;
};
