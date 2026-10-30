// What a production review round carries besides the problem under test, so a
// case does not pass only because its prompt is tiny. Sizes are the medians of
// 35 production reposts (2026-10-05→12, #2114): the Kody Rules judge saw 43
// rules and 10 earlier comments; the bug finder saw 10 earlier comments and 7
// commits, most of them answering review. Everything here is invented.

const TEAM_RULES = [
    ['rule-no-console', 'No console logging in application code', 'Use the shared logger (src/lib/logger.ts) instead of console.log/console.error in application code.'],
    ['rule-structured-logs', 'Structured log fields', 'Log calls pass context as an object of named fields, never interpolated into the message string.'],
    ['rule-no-any', 'Avoid explicit any', 'Do not annotate values as any; use unknown and narrow, or a concrete type.'],
    ['rule-no-non-null', 'No non-null assertions on external data', 'Do not use the ! operator on values that come from the network, the database or user input.'],
    ['rule-async-await', 'Await every promise', 'A promise returned by a call must be awaited, returned or explicitly voided with a comment.'],
    ['rule-error-cause', 'Keep the cause when rethrowing', 'When wrapping an error, pass the original as { cause } so the stack is not lost.'],
    ['rule-no-swallow', 'Do not swallow errors', 'A catch block must rethrow, return an explicit error result, or log with the shared logger.'],
    ['rule-http-timeout', 'Timeouts on outbound HTTP', 'Every outbound HTTP call sets an explicit timeout.'],
    ['rule-env-access', 'Read configuration through config.ts', 'Do not read process.env outside src/config.ts.'],
    ['rule-no-secrets', 'No secrets in source', 'Never hardcode API keys, tokens or passwords.'],
    ['rule-sql-params', 'Parameterized SQL', 'Never build SQL by string concatenation or template literals with values; use query parameters.'],
    ['rule-money-cents', 'Money in integer cents', 'Monetary amounts are integers in cents; never use floating point for money.'],
    ['rule-currency-format', 'Format money with formatMoney', 'Render monetary amounts with formatMoney from src/lib/money.ts, never toFixed.'],
    ['rule-pagination-cap', 'Cap page sizes', 'List endpoints cap the requested page size at 100.'],
    ['rule-idempotency-key', 'Idempotency keys on writes to providers', 'Calls that create resources at external providers send an idempotency key.'],
    ['rule-no-magic-numbers', 'Name magic numbers', 'Numeric literals other than 0, 1 and -1 in business logic are named constants.'],
    ['rule-pure-selectors', 'Selectors stay pure', 'Functions named select* never mutate their input or call I/O.'],
    ['rule-local-calendar-day', 'Format date-only values in local calendar time', 'Never derive a calendar day with toISOString().slice(0, 10): for users west of UTC it yields the previous day. Use formatLocalDate from src/reports/dates.ts.'],
    ['rule-date-library', 'One date library', 'Use date-fns for date arithmetic; do not add moment or dayjs.'],
    ['rule-utc-storage', 'Store timestamps in UTC', 'Timestamps written to the database are UTC instants (Date or ISO string with Z).'],
    ['rule-test-names', 'Test names state behavior', 'it(...) titles describe the observable behavior, not the function name.'],
    ['rule-no-only', 'No focused tests', 'Never commit it.only, describe.only or fit.'],
    ['rule-nth-called', 'Pin mock call arguments', 'Assert mock calls with toHaveBeenNthCalledWith when argument order matters.'],
    ['rule-fake-timers', 'Restore fake timers', 'Tests that call jest.useFakeTimers restore real timers in afterEach.'],
    ['rule-react-keys', 'Stable list keys', 'React list items use a stable id as key, never the array index.'],
    ['rule-effect-deps', 'Complete effect dependencies', 'useEffect/useMemo/useCallback list every value they read in the dependency array.'],
    ['rule-no-inline-styles', 'No inline styles', 'Use Tailwind classes or the design system; no style={{...}} in components.'],
    ['rule-a11y-buttons', 'Accessible icon buttons', 'Icon-only buttons have an aria-label.'],
    ['rule-i18n-strings', 'Translate user-facing strings', 'User-facing text goes through t(); no raw string literals in JSX.'],
    ['rule-feature-flags', 'Feature flags through useFlag', 'Read feature flags with useFlag/isEnabled, never from the raw tenant object, and default to off.'],
    ['rule-no-default-export', 'Named exports only', 'Modules use named exports; no export default.'],
    ['rule-barrel-imports', 'Import from the module, not the barrel', 'Inside a package, import from the file, not from its index barrel.'],
    ['rule-file-size', 'Keep modules small', 'A new module above 400 lines is split by responsibility.'],
    ['rule-dto-validation', 'Validate request bodies', 'Controllers validate request bodies with a zod schema before use.'],
    ['rule-authz-check', 'Authorize before reading', 'Handlers check the caller can access the resource before loading it.'],
    ['rule-no-n-plus-one', 'No queries inside loops', 'Do not issue a database query per item inside a loop; batch it.'],
    ['rule-transaction-scope', 'Keep transactions short', 'No network calls inside a database transaction.'],
    ['rule-migration-additive', 'Additive migrations', 'Migrations that already shipped are never edited; add a new one.'],
    ['rule-retry-backoff', 'Retries back off', 'Retry loops wait with exponential backoff between attempts.'],
    ['rule-queue-ack', 'Acknowledge after processing', 'Queue consumers acknowledge a message only after it was processed.'],
    ['rule-csv-injection', 'Escape CSV cells', 'Cells written to CSV exports that start with = + - @ are prefixed with a quote.'],
    ['rule-pii-logs', 'No personal data in logs', 'Never log emails, names, phone numbers or document ids.'],
    ['rule-docs-public-api', 'Document exported functions', 'Exported functions in src/lib have a one-line doc comment.'],
    ['rule-changelog', 'Changelog entry for user-visible changes', 'User-visible behavior changes add a line to CHANGELOG.md.'],
].map(([uuid, title, rule]) => ({ uuid, title, rule, path: 'src/**', severity: 'medium' }));

// The larger rule sets production DeepSeek reposts carried (78 and 86 rules).
const EXTRA_RULES = [
    ['rule-early-return', 'Return early on invalid input', 'Validate and return early instead of nesting the happy path.'],
    ['rule-no-nested-ternary', 'No nested ternaries', 'Do not nest conditional expressions; use if/else or a lookup.'],
    ['rule-enum-exhaustive', 'Exhaustive switches', 'A switch over a union or enum handles every member or asserts never.'],
    ['rule-readonly-params', 'Do not mutate parameters', 'Functions do not mutate objects or arrays they receive as parameters.'],
    ['rule-prefer-const', 'Prefer const', 'Use const unless the binding is reassigned.'],
    ['rule-no-floating-ui-state', 'Derive UI state', 'Do not mirror props into state; derive the value during render.'],
    ['rule-suspense-boundaries', 'Loading states through Suspense', 'Data-loading components use the shared Suspense boundary, not ad-hoc spinners.'],
    ['rule-error-boundaries', 'Error boundaries per route', 'Each route renders inside an error boundary.'],
    ['rule-query-keys', 'Query keys from the factory', 'React Query keys come from src/lib/queryKeys.ts.'],
    ['rule-invalidate-return', 'Return invalidation promises', 'Mutation callbacks return the promise from invalidateQueries.'],
    ['rule-form-schema', 'Forms validated by schema', 'Forms use a zod schema through the shared resolver.'],
    ['rule-date-input-local', 'Date inputs are local dates', 'Values from date inputs are parsed as local calendar dates, never with new Date(string).'],
    ['rule-timezone-display', 'Show times in the account time zone', 'Render timestamps in the account time zone with formatInZone.'],
    ['rule-cron-utc', 'Schedules in UTC', 'Cron expressions are written for UTC and say so in a comment.'],
    ['rule-feature-cleanup', 'Remove dead flags', 'When a flag is fully rolled out, delete the flag and the old branch in the same PR.'],
    ['rule-log-levels', 'Log levels mean something', 'error for failures needing action, warn for degraded paths, info for state changes only.'],
    ['rule-metrics-names', 'Metric names', 'Metrics are snake_case with a unit suffix (_ms, _bytes, _total).'],
    ['rule-trace-spans', 'Span per external call', 'Wrap each external call in a tracing span named after the provider operation.'],
    ['rule-cache-ttl', 'Caches have a TTL', 'Every cache entry sets an explicit TTL.'],
    ['rule-cache-keys', 'Cache keys include the tenant', 'Cache keys start with the workspace id.'],
    ['rule-rate-limit', 'Rate-limit public endpoints', 'Public endpoints declare a rate limit.'],
    ['rule-webhook-signature', 'Verify webhook signatures', 'Webhook handlers verify the provider signature before parsing the body.'],
    ['rule-file-upload-size', 'Limit upload size', 'Upload handlers enforce a maximum size before buffering.'],
    ['rule-mime-check', 'Check upload types by content', 'Validate uploaded file types by magic bytes, not by extension.'],
    ['rule-redirect-allowlist', 'Allowlist redirects', 'Redirect targets come from an allowlist, never straight from a query parameter.'],
    ['rule-cookie-flags', 'Secure cookies', 'Cookies set Secure, HttpOnly and SameSite.'],
    ['rule-jwt-expiry', 'Short-lived tokens', 'Access tokens expire in 15 minutes or less.'],
    ['rule-password-hash', 'Hash passwords with argon2', 'Passwords are hashed with argon2id through src/lib/password.ts.'],
    ['rule-audit-log', 'Audit admin actions', 'Admin mutations write an audit log entry with actor, target and before/after.'],
    ['rule-soft-delete', 'Soft delete customer data', 'Customer-facing records are soft-deleted with deletedAt.'],
    ['rule-index-queries', 'Index filtered columns', 'A new query filtering on a column ships with an index for it.'],
    ['rule-select-columns', 'Select only needed columns', 'Queries select explicit columns, not *.'],
    ['rule-batch-size', 'Bounded batches', 'Batch jobs process at most 500 rows per transaction.'],
    ['rule-job-idempotent', 'Idempotent jobs', 'Background jobs can run twice without duplicating side effects.'],
    ['rule-test-factories', 'Use test factories', 'Tests build entities with the factories in test/factories, not inline literals.'],
    ['rule-snapshot-scope', 'Small snapshots', 'Snapshot tests snapshot a single component, never a whole page.'],
].map(([uuid, title, rule]) => ({ uuid, title, rule, path: 'src/**', severity: 'medium' }));

// Earlier Kody comments on OTHER files of the same PR, in the shapes and
// statuses production shows. `count` of them, most recent last.
const OTHER_COMMENTS = [
    ['src/reports/export.ts', 41, 'kody_rules', ['rule-csv-injection'], 'implemented', 'exportRows writes the customer name straight into a CSV cell; a name starting with = runs as a formula in Excel. Prefix such cells with a quote, per the rule "Escape CSV cells".'],
    ['src/reports/export.ts', 77, 'bug', undefined, 'not_implemented', 'The export loop reads every report into memory before writing; for a large tenant this holds tens of thousands of rows at once. Stream the rows to the writer.'],
    ['src/reports/api.ts', 18, 'kody_rules', ['rule-dto-validation'], 'implemented', 'The handler reads req.body.range without validating it, against the rule "Validate request bodies". Parse it with the RangeQuery zod schema first.'],
    ['src/reports/api.ts', 33, 'kody_rules', ['rule-authz-check'], 'partially_implemented', 'getReport loads the report before checking the caller belongs to its workspace, against the rule "Authorize before reading". Check access first.'],
    ['src/reports/api.ts', 52, 'bug', undefined, 'implemented', 'pageSize from the query string is used as is, so ?pageSize=100000 loads the whole table. Cap it at 100.'],
    ['src/reports/summary.ts', 12, 'kody_rules', ['rule-money-cents'], 'implemented', 'totalRevenue sums amounts as floats (0.1 + 0.2), against the rule "Money in integer cents". Keep cents as integers and divide only when formatting.'],
    ['src/reports/summary.ts', 29, 'kody_rules', ['rule-no-magic-numbers'], 'not_implemented', 'The 0.85 threshold in isHealthy is unexplained, against the rule "Name magic numbers". Name it HEALTHY_RATIO.'],
    ['src/reports/summary.test.ts', 14, 'kody_rules', ['rule-nth-called'], 'pending', 'The test asserts fetchTotals with toHaveBeenCalledWith; with two calls in the test it passes even if the arguments are swapped, against the rule "Pin mock call arguments". Use toHaveBeenNthCalledWith.'],
    ['src/reports/chart.tsx', 58, 'kody_rules', ['rule-react-keys'], 'implemented', 'The bars are keyed by array index, against the rule "Stable list keys"; reordering the series re-mounts every bar. Key them by day.'],
    ['src/reports/chart.tsx', 23, 'kody_rules', ['rule-effect-deps'], 'not_implemented', 'The resize effect reads `series` but lists only [width], against the rule "Complete effect dependencies"; the chart keeps stale data after a range change.'],
    ['src/reports/schedule.ts', 9, 'bug', undefined, 'implemented', 'nextRun adds 24 hours to the last run, so on a daylight-saving change the report runs an hour early or late. Add one calendar day with addDays.'],
    ['src/reports/schedule.ts', 31, 'kody_rules', ['rule-transaction-scope'], 'not_implemented', 'scheduleReport calls the mailer inside the transaction, against the rule "Keep transactions short"; a slow mail server holds the row lock. Send after commit.'],
    ['src/reports/share.ts', 14, 'security', undefined, 'implemented', 'The share link embeds the report id in the URL with no expiry, so anyone holding an old link keeps access after the report is unshared. Sign the link with an expiry and check it on open.'],
    ['src/reports/share.ts', 40, 'kody_rules', ['rule-redirect-allowlist'], 'not_implemented', 'After login the handler redirects to req.query.next as is, against the rule "Allowlist redirects"; next=https://evil.example sends the user off-site. Check it against the allowlist.'],
    ['src/reports/cache.ts', 7, 'kody_rules', ['rule-cache-keys'], 'implemented', 'The report cache is keyed by report id only, against the rule "Cache keys include the tenant"; two workspaces with the same id share entries. Prefix the key with the workspace id.'],
];

function otherComments(count, start = '2026-10-06T09:00:00Z') {
    const t0 = Date.parse(start);
    return OTHER_COMMENTS.slice(0, count).map(([file, line, label, rules, outcome, text], i) => ({
        suggestionId: `round-a-other-${i + 1}`,
        relevantFile: file,
        relevantLinesStart: line,
        relevantLinesEnd: line,
        suggestionContent: text,
        label,
        ...(rules ? { brokenKodyRulesIds: rules } : {}),
        outcome,
        decidedAt: new Date(t0 + i * 7 * 60e3).toISOString(),
    }));
}

/** The PR's commit list as the pipeline passes it (oldest first). */
function commitList(messages, start = '2026-10-06T08:00:00Z') {
    const t0 = Date.parse(start);
    return messages.map((message, i) => ({
        sha: (0x5e1a00 + i * 4099).toString(16).padStart(7, '0') + 'c0ffee'.slice(0, 1 + (i % 5)),
        message,
        date: new Date(t0 + i * 41 * 60e3).toISOString(),
    }));
}

module.exports = { TEAM_RULES, EXTRA_RULES, otherComments, commitList };
