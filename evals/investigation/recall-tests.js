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

const LIGHT_CASES = [
    'fix-handle-collective-multiple-host-on-destinationcalendar-cal-com',
    'add-guest-management-functionality-to-existing-bookings-cal-com',
    'oauth-credential-sync-and-app-integration-enhancements-cal-com',
    'sms-workflow-reminder-retry-count-tracking-cal-com',
    'feat-2fa-backup-codes-cal-com',
    'feat-convert-insightsbookingservice-to-use-prisma-sql-raw-queries-cal-com',
    'enhance-embed-url-handling-and-validation-system-discourse-cursor',
    'feature-can-edit-category-host-relationships-for-embedding-discourse-cursor',
    'optimize-header-layout-performance-with-flexbox-mixins-discourse-cursor',
    'feature-automatically-downsize-large-images-discourse-cursor',
    'fix-proper-handling-of-group-memberships-discourse-cursor',
    'feature-localization-fallbacks-server-side-discourse-cursor',
    'anonymous-add-configurable-device-limit-grafana-codex',
    'frontend-asset-optimization-grafana-codex',
    'plugins-chore-renamed-instrumentation-middleware-to-metrics-middleware-grafana-codex',
    'dual-storage-architecture-grafana-codex',
    'unified-storage-performance-optimizations-grafana-codex',
    'notification-rule-processing-engine-grafana-codex',
    'implement-access-token-context-encoding-framework-keycloak',
    'fix-concurrent-group-access-to-prevent-nullpointerexception-keycloak',
    'add-html-sanitizer-for-translated-message-resources-keycloak',
    'add-client-resource-type-and-scopes-to-authorization-schema-keycloak',
    'fixing-re-authentication-with-passkeys-keycloak',
    'add-caching-support-for-identityproviderstorageprovider-getforlogin-operations-keycloak',
    'replays-self-serve-bulk-delete-system-sentry',
    'span-buffer-multiprocess-enhancement-with-health-monitoring-sentry',
    'feat-ecosystem-implement-cross-system-issue-synchronization-sentry',
    'github-oauth-security-enhancement-sentry',
    'feat-workflow-engine-add-in-hook-for-producing-occurrences-from-the-stateful-det-sentry',
    'ref-crons-reorganize-incident-creation-issue-occurrence-logic-sentry',
];

const CASE_SETS = {
    smoke: SMOKE_CASES,
    pr: PR_CASES,
    light: LIGHT_CASES,
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
