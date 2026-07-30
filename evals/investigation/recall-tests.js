/**
 * Builds finder-RECALL test cases from the per-PR investigation datasets,
 * reusing their benchmark-grounded vars (real diff, goldenComments, deterministic
 * toolReplay) but swapping the tool-use assertion for recall-assertion.js.
 *
 * Default: the PR-balanced set (8 cases / 38 goldens). Override:
 *   RECALL_SET=smoke                   → 5 high-signal cases / 25 goldens
 *   RECALL_SET=pr                      → 8 PR-gate cases / 38 goldens
 *   RECALL_ALL=1                       → every per-PR case
 *   RECALL_CASES=caseId1,caseId2,...   → an explicit subset
 */
const fs = require('fs');
const path = require('path');

const DATASETS_DIR = path.join(__dirname, 'datasets');

// One high-signal case per repo (cal.com / sentry / grafana-codex / keycloak /
// discourse-cursor). 5 cases / 25 goldens, useful for quick local checks.
const SMOKE_CASES = [
    'add-guest-management-functionality-to-existing-bookings-cal-com',
    'span-buffer-multiprocess-enhancement-with-health-monitoring-sentry',
    'anonymous-add-configurable-device-limit-grafana-codex',
    'add-html-sanitizer-for-translated-message-resources-keycloak',
    'enhance-embed-url-handling-and-validation-system-discourse-cursor',
];

// PR-balanced set: 8 cases / 38 goldens, ~16% of cases but ~28% of goldens.
// This is the default CI/local gate: materially stronger than smoke without the
// cost of the 51-case corpus.
const PR_CASES = [
    ...SMOKE_CASES,
    'oauth-credential-sync-and-app-integration-enhancements-cal-com',
    'feat-ecosystem-implement-cross-system-issue-synchronization-sentry',
    'implement-access-token-context-encoding-framework-keycloak',
];

const CASE_SETS = {
    smoke: SMOKE_CASES,
    pr: PR_CASES,
};

module.exports = async () => {
    const all = process.env.RECALL_ALL === '1';
    const setName = process.env.RECALL_SET || 'pr';
    const selectedSet = CASE_SETS[setName] || CASE_SETS.pr;
    const only = (process.env.RECALL_CASES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const files = fs
        .readdirSync(DATASETS_DIR)
        .filter((f) => f.endsWith('.json') && f !== 'smoke.json');

    const tests = [];
    for (const file of files) {
        // The include filter keys on the dataset's INTERNAL caseId (vars.caseId),
        // which for 7/50 files differs from the filename — so we must parse to
        // filter. Guard the parse so a single corrupt/unreadable dataset (even an
        // unselected one) skips instead of aborting the whole run.
        let raw;
        try {
            raw = JSON.parse(
                fs.readFileSync(path.join(DATASETS_DIR, file), 'utf8'),
            );
        } catch (err) {
            console.warn(`[recall-tests] skipping unreadable dataset ${file}: ${err.message}`);
            continue;
        }
        const c = Array.isArray(raw) ? raw[0] : raw;
        const caseId = c?.vars?.caseId || file.replace(/\.json$/, '');
        const include = all
            ? true
            : only.length
              ? only.includes(caseId)
              : selectedSet.includes(caseId);
        if (!include) continue;

        tests.push({
            description: `recall: ${caseId}`,
            vars: c.vars,
            assert: [{ type: 'javascript', value: 'file://recall-assertion.js' }],
        });
    }
    return tests;
};
