/**
 * Report-metrics parity / sanity check (Test type "A": are the numbers right?).
 *
 * Runs the cockpit warehouse queries the reports rely on against a REAL org +
 * period and verifies cross-query invariants — chiefly that the NEW rule-group
 * split and the category/severity breakdowns reconcile with the canonical
 * implementation-rate number (the one the cockpit dashboard shows, which we
 * treat as ground truth). It also prints the headline numbers so you can
 * eyeball them against the cockpit UI for the same org + window.
 *
 * Run (QA warehouse over VPN):
 *   DOTENV_CONFIG_PATH=.env.qa \
 *   TS_NODE_TRANSPILE_ONLY=1 TS_NODE_PROJECT=./tsconfig.json \
 *   node -r ts-node/register -r tsconfig-paths/register -r dotenv/config \
 *   scripts/analytics/report-metrics-parity.ts <organizationId> <start> <end> [repoFullName]
 *
 * Dates are YYYY-MM-DD. DB credentials come from the loaded env file, never
 * from argv.
 */
import { analyticsDataSource } from '@libs/ee/analytics-warehouse/infrastructure/ormconfig';
import { CockpitCodeHealthService } from '@libs/cockpit/infrastructure/services/cockpit-code-health.service';
import { CockpitReviewAnalyticsService } from '@libs/cockpit/infrastructure/services/cockpit-review-analytics.service';

type Check = { name: string; ok: boolean; detail: string };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const inRange = (r: number) => Number.isFinite(r) && r >= 0 && r <= 1;

const isoDaysAgo = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

async function main() {
    let [organizationId, startDate, endDate, repository] =
        process.argv.slice(2);

    await analyticsDataSource.initialize();
    const review = new CockpitReviewAnalyticsService(analyticsDataSource);
    const codeHealth = new CockpitCodeHealthService(analyticsDataSource);

    // No org given → auto-pick the highest-implemented org in the last 120
    // days and default to a 90-day window. Lets you run with zero args.
    if (!organizationId) {
        const [top] = (await analyticsDataSource.query(
            `SELECT "organizationId" AS org
               FROM analytics.suggestions_mv
              WHERE "suggestionCreatedAt" > now() - interval '120 days'
              GROUP BY 1
             HAVING COUNT(*) FILTER (WHERE "suggestionImplementationStatus"
                    IN ('implemented','partially_implemented')) > 0
              ORDER BY COUNT(*) FILTER (WHERE "suggestionImplementationStatus"
                    IN ('implemented','partially_implemented')) DESC
              LIMIT 1`,
        )) as Array<{ org: string }>;
        if (!top) {
            console.error('no org with implemented suggestions found');
            await analyticsDataSource.destroy();
            process.exit(2);
        }
        organizationId = top.org;
        startDate = startDate ?? isoDaysAgo(90);
        endDate = endDate ?? isoDaysAgo(0);
        console.log(`(auto-picked org=${organizationId})`);
    }

    if (!startDate || !endDate) {
        console.error(
            'usage: report-metrics-parity [organizationId] [start YYYY-MM-DD] [end YYYY-MM-DD] [repoFullName]',
        );
        await analyticsDataSource.destroy();
        process.exit(2);
    }

    const q = { organizationId, startDate, endDate, repository };

    const [impl, groups, severity, categories, rules, ops] = await Promise.all([
        codeHealth.getImplementationRate(q),
        review.getReviewQualityByRuleGroup(q),
        review.getImplementationRateBySeverity(q),
        review.getImplementationRateByCategory(q),
        review.getKodyRulesUsage(q),
        review.getReviewOperationalMetrics(q),
    ]);

    const checks: Check[] = [];
    const add = (name: string, ok: boolean, detail = '') =>
        checks.push({ name, ok, detail });

    // 1. The rule-group split (NEW query) must cover exactly the same
    //    delivered-on-closed-PR universe as the canonical implementation rate.
    const groupSent = sum(groups.map((g) => g.sent));
    const groupImpl = sum(groups.map((g) => g.implemented));
    add(
        'group split sent == impl-rate sent',
        groupSent === impl.suggestionsSent,
        `groups=${groupSent} vs impl=${impl.suggestionsSent}`,
    );
    add(
        'group split implemented == impl-rate implemented',
        groupImpl === impl.suggestionsImplemented,
        `groups=${groupImpl} vs impl=${impl.suggestionsImplemented}`,
    );

    // 2. Category and severity breakdowns must reconcile to the same total.
    const catSent = sum(categories.map((c) => c.sent));
    add(
        'category sent == impl-rate sent',
        catSent === impl.suggestionsSent,
        `categories=${catSent} vs impl=${impl.suggestionsSent}`,
    );
    const sevSent = sum(severity.map((s) => s.sent));
    add(
        'severity sent == impl-rate sent',
        sevSent === impl.suggestionsSent,
        `severity=${sevSent} vs impl=${impl.suggestionsSent}`,
    );

    // 3. No breakdown can implement more than it sent; rates stay in [0,1].
    add(
        'implemented <= sent everywhere',
        severity.every((s) => s.implemented <= s.sent) &&
            categories.every((c) => c.implemented <= c.sent) &&
            groups.every((g) => g.implemented <= g.sent) &&
            impl.suggestionsImplemented <= impl.suggestionsSent,
    );
    add(
        'all rates within [0,1]',
        inRange(impl.implementationRate) &&
            severity.every((s) => inRange(s.rate)) &&
            categories.every((c) => inRange(c.rate)) &&
            groups.every((g) => inRange(g.rate)),
    );

    // 4. The canonical rate must equal implemented/sent (recomputed).
    const recomputed =
        impl.suggestionsSent === 0
            ? 0
            : Number(
                  (
                      impl.suggestionsImplemented / impl.suggestionsSent
                  ).toFixed(2),
              );
    add(
        'implementation rate == implemented/sent',
        Math.abs(recomputed - impl.implementationRate) < 0.01,
        `recomputed=${recomputed} vs reported=${impl.implementationRate}`,
    );

    // ── Human-readable snapshot (eyeball vs the cockpit UI) ──────────────
    const critical = severity.find((s) => s.severity === 'critical');
    console.log('\n══ report metrics ══');
    console.log(`org=${organizationId} repo=${repository ?? '(all)'}`);
    console.log(`window=${startDate}..${endDate}\n`);
    console.log(`reviews (processed)     : ${ops.currentPeriod.processedReviews}`);
    console.log(`suggestions sent        : ${impl.suggestionsSent}`);
    console.log(`suggestions implemented : ${impl.suggestionsImplemented}`);
    console.log(
        `implementation rate     : ${(impl.implementationRate * 100).toFixed(1)}%`,
    );
    console.log(
        `critical implemented    : ${critical?.implemented ?? 0} / ${critical?.sent ?? 0} sent`,
    );
    console.log('\nrule-group split:');
    for (const g of groups) {
        console.log(
            `  ${g.group.padEnd(11)} sent=${g.sent} impl=${g.implemented} (${(g.rate * 100).toFixed(0)}%) 👍${g.thumbsUp} 👎${g.thumbsDown}`,
        );
    }
    console.log('\ntop categories:');
    for (const c of categories.slice(0, 6)) {
        console.log(
            `  ${c.category.padEnd(28)} sent=${c.sent} (${(c.rate * 100).toFixed(0)}%)`,
        );
    }
    console.log(`\nkody rules that triggered: ${rules.length}`);
    for (const r of rules.slice(0, 8)) {
        console.log(
            `  ${r.ruleId.slice(0, 8)} triggers=${r.triggers} impl=${(r.rate * 100).toFixed(0)}% 👎${r.thumbsDown}`,
        );
    }

    // ── Verdict ─────────────────────────────────────────────────────────
    console.log('\n══ invariants ══');
    let failed = 0;
    for (const c of checks) {
        if (!c.ok) failed++;
        console.log(
            `  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`,
        );
    }
    console.log(
        `\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)\n`,
    );

    await analyticsDataSource.destroy();
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
    console.error('parity check failed to run:', e?.message ?? e);
    try {
        if (analyticsDataSource.isInitialized) await analyticsDataSource.destroy();
    } catch {
        /* ignore */
    }
    process.exit(1);
});
