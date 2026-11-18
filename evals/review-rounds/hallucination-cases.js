// The review failure shapes from kodus-ai#2528, reduced to paired repositories.
// Each control differs only in the code that makes the same claim true.
const { filesBetween } = require('../shared/repo-mirror');

const lines = (...parts) => [...parts, ''].join('\n');

function pair(id, family, base, head, rule, claim, pr = {}) {
    return [false, true].map((violates) => {
        const previous = base(violates);
        const repo = head(previous, violates);
        return {
            id: `${id}-${violates ? 'violation' : 'control'}`,
            family,
            repo,
            changedFiles: filesBetween(previous, repo),
            kodyRules: rule ? [rule] : [],
            claims: [
                {
                    ...claim,
                    ...(violates && claim.missingBehavior ? { golden: claim.missingBehavior } : {}),
                    truth: violates ? 'true' : 'false',
                    expect: violates ? 'deliver' : 'not_deliver',
                },
            ],
            ...pr,
        };
    });
}

const access = pair(
    'H1',
    'incremental-rule-evidence',
    (violates) => ({
        'src/api/access.ts': lines(
            violates
                ? 'export const Access = { ReadReports: "reports.read" } as const;'
                : 'export const Access = { ExportReports: "reports.export" } as const;',
            violates
                ? 'export const grants = { admin: [Access.ReadReports], reader: [Access.ReadReports] };'
                : 'export const grants = { admin: [Access.ExportReports], reader: [] };',
        ),
        'src/api/export-controller.ts': lines(
            ...(violates
                ? ['import { controller, route } from "./http";']
                : [
                      'import { Access } from "./access";',
                      'import { controller, requirePolicy, route } from "./http";',
                  ]),
            '',
            '@controller("/reports")',
            'export class ReportsController {',
            '    @route("GET", "/export")',
            ...(violates ? [] : ['    @requirePolicy(Access.ExportReports)']),
            '    exportReports() { return "report export"; }',
            '}',
        ),
    }),
    (previous) => ({
        ...previous,
        'src/web/reports.ts':
            'export const exportButton = { title: "Export reports", url: "/reports/export" };\n',
    }),
    {
        uuid: 'eval-h1-access',
        scope: 'pull-request',
        title: 'New features must have a fitting permission model',
        rule: 'When a PR adds a user-facing feature or API, its endpoint must be protected by a policy using a resource specific to the feature and a matching entry in the roles matrix. Flag missing or unrelated policies.',
    },
    {
        id: 'endpoint-policy',
        ruleId: 'eval-h1-access',
        golden: 'The new Reports export GET endpoint lacks the feature-specific ExportReports policy; the endpoint itself must enforce the access rule.',
    },
    {
        prBase: {},
        prTitle: 'feat: export reports',
        prBody: 'Add a report export endpoint in ReportsController and a button that calls it.',
    },
);

const cloud = pair(
    'H2',
    'cross-file-rule-evidence',
    (violates) => ({
        'src/api/environment.production.ts': lines(
            'export const environment = {',
            violates
                ? '    cloud: (process.env.API_CLOUD_MODE || "true").toLowerCase() === "true",'
                : '    cloud: __BUILD_CLOUD_MODE__,',
            '};',
        ),
        'src/api/environment.dev.ts':
            'export const environment = { cloud: (process.env.API_CLOUD_MODE || "true").toLowerCase() === "true" };\n',
        'src/web/layout.ts':
            'import "server-only";\n\nexport function showReports() { return true; }\n',
    }),
    (previous) => ({
        ...previous,
        'src/web/layout.ts': lines(
            'import "server-only";',
            '',
            '// Like the API, hide reports outside cloud mode.',
            'export function showReports() {',
            '    return (process.env.API_CLOUD_MODE || "true").toLowerCase() === "true";',
            '}',
        ),
    }),
    {
        uuid: 'eval-h2-cloud',
        title: 'Keep shared policy in a single parameterized definition',
        path: 'src/web/**',
        rule: 'When production web and API independently implement the same cloud-mode decision, define it once and derive both callers from it. Do not flag development-only shims.',
    },
    {
        id: 'duplicated-cloud-policy',
        ruleId: 'eval-h2-cloud',
        golden: 'The web layout duplicates how the production API reads cloud mode and should derive that decision from a single definition.',
    },
    {
        prTitle: 'fix: hide reports outside cloud mode',
        prBody: 'The cloud image sets API_CLOUD_MODE (defaults to true). A server-only layout now hides the report page when the operator explicitly sets it to false.',
    },
);

const regression = pair(
    'H3',
    'regression-test-scope',
    () => ({
        'src/record.ts':
            'export function record(exit: number, elapsed: number) { return { executed: true, passed: exit === 0 }; }\n',
        'src/record.spec.ts': 'import { record } from "./record";\n',
    }),
    (previous, violates) => ({
        ...previous,
        'src/record.ts': lines(
            'export function record(exit: number, elapsed: number) {',
            '    if (exit !== 0 && elapsed >= 10_000) return { executed: false, passed: false };',
            '    return { executed: true, passed: exit === 0 };',
            '}',
        ),
        'src/record.spec.ts': lines(
            previous['src/record.spec.ts'].trimEnd(),
            '',
            'describe("recording work interrupted by the slice deadline", () => {',
            ...(violates
                ? []
                : [
                      '    it("does not record a cut-short run", () => {',
                      '        expect(record(124, 10_000)).toEqual({ executed: false, passed: false });',
                      '    });',
                  ]),
            '    it("records a failure that finished before the deadline", () => {',
            '        expect(record(1, 2_000)).toEqual({ executed: true, passed: false });',
            '    });',
            '    it("records a successful run", () => {',
            '        expect(record(0, 2_000)).toEqual({ executed: true, passed: true });',
            '    });',
            '});',
        ),
    }),
    {
        uuid: 'eval-h3-regression',
        path: '**/*.spec.ts',
        title: 'Pin regression tests against the previous revision',
        rule: 'A test added together with a fix must fail on the previous revision; a test that passes on the old code too does not pin the fix. Run the new spec against the pre-fix commit and replace cases that pass on both revisions with the exact input the old code broke.',
    },
    {
        id: 'uncovered-timeout',
        missingBehavior: 'No test calls record with a nonzero exit after the 10-second cutoff and asserts executed is false; the pre-fix implementation still passes the suite.',
        ruleId: 'eval-h3-regression',
        golden: 'The recording tests do not pin the cut-short behavior against the previous revision, or a contrast case is claimed to be insufficient because it also passes on the previous revision.',
    },
    { prTitle: 'fix: do not record interrupted work as executed' },
);

const resume = pair(
    'H4',
    'verify-complete-condition',
    (violates) => ({
        'src/worker/run.ts': lines(
            'import { saveStatus, reconcile } from "./store";',
            'export function finish(result: { checkedNow: number; inherited: number; errors: number }) {',
            '    if (result.checkedNow + result.inherited === 0 && result.errors > 0) {',
            '        return saveStatus("FAILED");',
            '    }',
            '    reconcile(result.checkedNow);',
            '    return saveStatus("COMPLETED");',
            '}',
        ),
        'src/worker/resume.ts': lines(
            'import { lastAttempt } from "./store";',
            '',
            'export function planForNextAttempt() {',
            '    const previous = lastAttempt();',
            '    const canResume =',
            ...(violates ? [] : ['        previous?.status === "FAILED" ||']),
            '        previous?.status === "PAUSED" ||',
            '        (previous?.status === "COMPLETED" && previous.hasPendingWork);',
            '    return canResume ? previous.progress : undefined;',
            '}',
        ),
        'src/worker/store.ts': lines(
            'type Attempt = { status: string; hasPendingWork: boolean; progress: number };',
            'let attempt: Attempt | undefined;',
            'export function lastAttempt() { return attempt; }',
            'export function saveStatus(status: string) {',
            '    attempt = { progress: attempt?.progress ?? 0, hasPendingWork: true, status };',
            '    return attempt;',
            '}',
            'export function reconcile(checked: number) { if (attempt) attempt.progress += checked; }',
        ),
    }),
    (previous) => ({
        ...previous,
        'src/worker/run.ts': previous['src/worker/run.ts'].replace(
            '    if (result.checkedNow + result.inherited',
            '    // A provider outage with no new work must fail this attempt, keep saved progress, and skip reconciliation.\n    if (result.checkedNow',
        ),
    }),
    null,
    {
        id: 'failed-resume-loses-progress',
        golden: 'When a resumed attempt checks nothing new and its remaining work fails, it is recorded FAILED; the retry can no longer resume its saved progress because FAILED is not resumable.',
    },
    { prTitle: 'fix: fail attempts where the provider checked nothing new' },
);

// Independent examples scored with the same production review and paired labels.
const registry = pair(
    'G1', 'incremental-registration',
    (violates) => ({
        'src/tasks.ts': lines(
            'export async function purgeExpired() { return 0; }',
            violates ? 'export const tasks: Record<string, () => Promise<number>> = {};' : 'export const tasks: Record<string, () => Promise<number>> = { purgeExpired };',
        ),
        'src/dispatch.ts': lines('import { tasks } from "./tasks";', 'export function run(name: string) { return tasks[name]?.(); }'),
    }),
    (previous) => ({ ...previous, 'config/nightly.ts': lines('export const nightly = { task: "purgeExpired", hour: 3 };') }),
    { uuid: 'eval-g1-task', scope: 'pull-request', title: 'Register scheduled tasks', rule: 'A new schedule in config must reference a task registered by name in the dispatcher task table. A function declaration alone does not register it.' },
    { id: 'missing-task-registration', ruleId: 'eval-g1-task', golden: 'The new purgeExpired schedule cannot dispatch because the tasks table has no purgeExpired entry.' },
    { prBase: {}, prTitle: 'Schedule the expired-item cleanup overnight' },
);

const grace = pair(
    'G2', 'cross-file-semantics',
    (violates) => ({
        'src/billing/invoice.ts': lines('export function due(day: number) { return day; }'),
        'src/support/reminder.ts': lines(violates
            ? 'export function invoiceDueDay(day: number) { return day + 5; }'
            : 'export function retrySupportEmail(day: number) { return day + 5; }'),
    }),
    (previous) => ({ ...previous, 'src/billing/invoice.ts': lines('export function due(day: number) { return day + 5; }') }),
    { uuid: 'eval-g2-policy', path: 'src/billing/**', title: 'Share invoice deadlines', rule: 'Two implementations of the invoice due date must use the same policy function. An unrelated timer with the same number of days is a separate policy.' },
    { id: 'duplicated-deadline', ruleId: 'eval-g2-policy', golden: 'The invoice due date is independently computed as day plus five in billing and support. Share the invoice deadline calculation.' },
    { prTitle: 'Allow a grace period on invoices' },
);

const freeShipping = pair(
    'G3', 'behavioral-regression',
    () => ({
        'src/shipping.ts': lines('export const freeShipping = (cents: number) => cents > 5000;'),
        'tests/shipping.spec.ts': lines('import { freeShipping } from "../src/shipping";'),
    }),
    (previous, violates) => ({
        ...previous,
        'src/shipping.ts': lines('export const freeShipping = (cents: number) => cents >= 5000;'),
        'tests/shipping.spec.ts': lines(previous['tests/shipping.spec.ts'].trimEnd(),
            'describe("free shipping threshold", () => {',
            '    it("charges below the threshold", () => expect(freeShipping(4999)).toBe(false));',
            ...(violates ? [] : ['    it("ships free at the threshold", () => expect(freeShipping(5000)).toBe(true));']),
            '    it("ships free above the threshold", () => expect(freeShipping(5001)).toBe(true));',
            '});'),
    }),
    { uuid: 'eval-g3-boundary', path: 'tests/**', title: 'Pin the changed behavior', rule: 'A regression suite accompanying a fix must fail on the previous implementation and pass with the fix.' },
    { id: 'missing-equality-test', missingBehavior: 'No test asserts freeShipping(5000) is true; the old strict greater-than implementation passes all tests.', ruleId: 'eval-g3-boundary', golden: 'The suite lacks a test for exactly 5000 cents, the only input whose free-shipping outcome changes, or incorrectly claims the suite fails to pin the fix because an adjacent contrast case passes on the old implementation.' },
    { prTitle: 'Include purchases of exactly fifty dollars in free shipping' },
);

const archive = pair(
    'G4', 'generalist-consumer-contract',
    (violates) => ({
        'src/export.ts': lines('import { snapshot } from "./list";', 'export function exportNames(names: string[]) { return snapshot([...names]); }'),
        'src/list.ts': lines('export function snapshot(names: string[]) {',
            violates ? '    return names.sort();' : '    return [...names].sort();', '}'),
    }),
    (previous) => ({ ...previous, 'src/export.ts': lines(
        'import { snapshot } from "./list";',
        '// Export must leave the caller-owned list in its original order.',
        'export function exportNames(names: string[]) { return snapshot(names); }',
    ) }),
    null,
    { id: 'caller-list-mutated', golden: 'Removing the defensive copy lets snapshot sort the caller-owned input array in place, changing its order.' },
    { prTitle: 'Reduce allocations while exporting names' },
);

module.exports = [...access, ...cloud, ...regression, ...resume, ...registry, ...grace, ...freeShipping, ...archive];
