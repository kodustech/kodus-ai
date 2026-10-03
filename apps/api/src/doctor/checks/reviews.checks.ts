import {
    DoctorCheck,
    DoctorContext,
    DoctorResult,
    DoctorTeam,
    RECENT_DAYS,
    reviewableTeams,
    teamScope,
} from '../doctor.types';

/**
 * A cause turns a line into ! only when it hit at least this many runs AND at
 * least DEGRADED_SHARE of them (#2066): one transient clone failure in 200
 * reviews must not flip the whole install to DEGRADED (doctor-report.ts:18).
 */
export const MIN_DEGRADED_RUNS = 3;
export const DEGRADED_SHARE = 0.1;

/** One finished code review run (in-progress runs are not counted). */
export interface ReviewRun {
    status: 'success' | 'partial_error' | 'error' | 'skipped';
    errorMessage?: string | null;
    /** `reviewWarnings[].kind` the run recorded (dataExecution). */
    warningKinds: string[];
    /** An agent stopped at its time or step limit, or failed. */
    agentCutShort: boolean;
}

export interface SuggestionCounts {
    sent: number;
    /** Posting failed (`failed`, `failed_lines_mismatch`). */
    deliveryFailed: number;
    /** Held back on purpose: severity, verification, outside the diff… */
    heldBack: number;
    implemented: number;
}

export interface FeedbackCounts {
    thumbsUp: number;
    thumbsDown: number;
}

export interface ReviewsDeps {
    runs(team: DoctorTeam): Promise<ReviewRun[]>;
    suggestions(organizationId: string): Promise<SuggestionCounts>;
    feedback(organizationId: string): Promise<FeedbackCounts>;
}

/** The context-window counter-measures, reported as one line. */
const CONTEXT_WINDOW_KINDS = new Set([
    'PROMPT_COMPACTED',
    'CALLGRAPH_DROPPED',
    'HUNK_HEADERS_ONLY',
    'DIFF_TRUNCATED',
    'HEAVY_PASSES_SKIPPED',
]);

interface Loss {
    /** Matches the run, or counts it. */
    matches(run: ReviewRun): boolean;
    title(count: number, total: number): string;
    impact: string;
    fix: string;
}

const kind = (k: string) => (run: ReviewRun) => run.warningKinds.includes(k);

const LOSSES: Record<string, Loss> = {
    'reviews.sandbox': {
        matches: kind('SANDBOX_UNAVAILABLE'),
        title: (n, t) =>
            `${n} of ${t} reviews ran without the repository checked out.`,
        impact: 'Kody read only the diff: no tools, no cross-file context, no call graph.',
        fix: 'Check the sandbox lines above, then the worker logs for "Failed to acquire sandbox lease".',
    },
    'reviews.callgraph': {
        matches: kind('CALLGRAPH_FAILED'),
        title: (n, t) =>
            `${n} of ${t} reviews ran without the call graph, although the repository was checked out.`,
        impact: 'Kody did not know who calls the changed code.',
        fix: 'Check the worker logs for "Call graph failed".',
    },
    'reviews.fallback': {
        matches: kind('PROVIDER_FALLBACK'),
        title: (n, t) =>
            `${n} of ${t} reviews ran on the fallback model because the main model failed.`,
        impact: 'Those reviews ran on a different model, with different cost and quality.',
        fix: "Check the main model's key, quota and model name in the BYOK page (user menu > BYOK).",
    },
    'reviews.context_window': {
        matches: (run) =>
            run.warningKinds.some((k) => CONTEXT_WINDOW_KINDS.has(k)),
        title: (n, t) =>
            `${n} of ${t} reviews were cut down to fit the model's context window.`,
        impact: 'Kody saw less of those pull requests.',
        fix: 'Use a model with a larger context window, or set its real limit in the BYOK page (user menu > BYOK).',
    },
    'reviews.low_signal': {
        matches: kind('LOW_SIGNAL_FILES_DROPPED'),
        title: (n, t) =>
            `${n} of ${t} reviews left tests, docs and styles out to fit the pull request.`,
        impact: 'Findings in those files were not looked for.',
        fix: 'Expected on very large pull requests: split them, or use a model with a larger context window.',
    },
    'reviews.kody_rules': {
        matches: (run) =>
            run.warningKinds.includes('KODY_RULES_PARTIAL') ||
            run.warningKinds.includes('RULE_CONTEXT_UNAVAILABLE'),
        title: (n, t) => `${n} of ${t} reviews did not apply every Kody Rule.`,
        impact: 'The rules that were skipped could not flag anything on those pull requests.',
        fix: 'Rules that need the repository fail without it (see the sandbox line); otherwise check the worker logs for "PARTIAL judge-shard failure".',
    },
    'reviews.path_mismatch': {
        matches: kind('SUGGESTIONS_DROPPED_PATH_MISMATCH'),
        title: (n, t) =>
            `${n} of ${t} reviews dropped findings that named a file outside the pull request.`,
        impact: 'Those findings never reached the pull request.',
        fix: 'Not a setting: report it to Kodus with the pull request numbers.',
    },
    'reviews.cut_short': {
        matches: (run) => run.agentCutShort,
        title: (n, t) =>
            `${n} of ${t} reviews had an agent stop before it finished (time or step limit, or an error).`,
        impact: 'Part of those pull requests was not reviewed.',
        fix: 'Check the review timeline of those pull requests in the dashboard; a slow model or a very large pull request causes it.',
    },
};

function mostCommon(
    values: Array<string | null | undefined>,
): string | undefined {
    const counts = new Map<string, number>();
    for (const v of values) {
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function isDegraded(count: number, total: number): boolean {
    return count >= MIN_DEGRADED_RUNS && count / total >= DEGRADED_SHARE;
}

/**
 * Whether the reviews of the last RECENT_DAYS ran in full (#2066). Read from
 * what each run recorded; it never judges whether a finding was right.
 */
export function recentReviewsCheck(deps: ReviewsDeps): DoctorCheck {
    return {
        id: 'reviews.recent',
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];
            const organizations = new Map<string, string>();

            for (const team of reviewableTeams(ctx)) {
                organizations.set(team.organizationId, team.organizationName);
                const scope = teamScope(team);
                const runs = await deps.runs(team);
                const reviewed = runs.filter((r) => r.status !== 'skipped');

                if (!reviewed.length) {
                    results.push({
                        check: 'reviews.none',
                        status: 'info',
                        scope,
                        title: `No pull request was reviewed in the last ${RECENT_DAYS} days${runs.length ? ` (${runs.length} skipped by your settings)` : ''}.`,
                        fix: runs.length
                            ? 'See the "skipped by your settings" lines below.'
                            : 'If pull requests were opened, check the webhook lines above.',
                    });
                    continue;
                }

                const failed = reviewed.filter((r) => r.status === 'error');
                const topError = mostCommon(failed.map((r) => r.errorMessage));
                if (
                    failed.length === reviewed.length &&
                    reviewed.length >= MIN_DEGRADED_RUNS
                ) {
                    results.push({
                        check: 'reviews.failed',
                        status: 'fail',
                        scope,
                        title: `Every review in the last ${RECENT_DAYS} days failed (${failed.length}).`,
                        impact: "No pull request gets Kody's comments.",
                        fix: `Most common error: ${topError ?? 'none recorded'}. Check the worker logs.`,
                    });
                    continue;
                }
                if (failed.length) {
                    results.push({
                        check: 'reviews.failed',
                        status: isDegraded(failed.length, reviewed.length)
                            ? 'warn'
                            : 'info',
                        scope,
                        title: `${failed.length} of ${reviewed.length} reviews in the last ${RECENT_DAYS} days failed.`,
                        impact: 'Those pull requests got no review.',
                        fix: `Most common error: ${topError ?? 'none recorded'}. Check the worker logs.`,
                    });
                }

                const completed = reviewed.filter((r) => r.status !== 'error');
                let lossLines = 0;
                for (const [check, loss] of Object.entries(LOSSES)) {
                    const count = completed.filter((r) =>
                        loss.matches(r),
                    ).length;
                    if (!count) continue;
                    lossLines++;
                    results.push({
                        check,
                        status: isDegraded(count, completed.length)
                            ? 'warn'
                            : 'info',
                        scope,
                        title: loss.title(count, completed.length),
                        impact: loss.impact,
                        fix: loss.fix,
                    });
                }
                if (!lossLines && completed.length) {
                    results.push({
                        check: 'reviews.full',
                        status: 'ok',
                        scope,
                        title: `${completed.length} review(s) in the last ${RECENT_DAYS} days ran in full.`,
                    });
                }
            }

            for (const [organizationId, organizationName] of organizations) {
                const s = await deps.suggestions(organizationId);
                const attempted = s.sent + s.deliveryFailed;
                if (s.deliveryFailed) {
                    results.push({
                        check: 'suggestions.delivery',
                        status: isDegraded(s.deliveryFailed, attempted)
                            ? 'warn'
                            : 'info',
                        scope: organizationName,
                        title: `${s.deliveryFailed} of ${attempted} findings in the last ${RECENT_DAYS} days could not be posted on the pull request.`,
                        impact: 'Those findings are lost.',
                        fix: 'Check that the Git token can comment (see the Git lines above). A "lines mismatch" means the pull request changed while it was being reviewed.',
                    });
                }
                if (attempted || s.heldBack) {
                    results.push({
                        check: 'suggestions.summary',
                        status: 'info',
                        scope: organizationName,
                        title: `Last ${RECENT_DAYS} days: ${s.sent} finding(s) posted, ${s.heldBack} held back by design (severity filter, verification, outside the diff, limit per pull request), ${s.implemented} implemented.`,
                    });
                }

                if (!ctx.env.API_CRON_SYNC_CODE_REVIEW_REACTIONS) {
                    results.push({
                        check: 'feedback.reactions',
                        status: 'info',
                        scope: organizationName,
                        title: "👍/👎 on Kody's comments are not collected.",
                        fix: 'Optional: set API_CRON_SYNC_CODE_REVIEW_REACTIONS (for example "0 0 * * *").',
                    });
                } else {
                    const f = await deps.feedback(organizationId);
                    results.push({
                        check: 'feedback.reactions',
                        status: 'info',
                        scope: organizationName,
                        title: `Last ${RECENT_DAYS} days: ${f.thumbsUp} 👍 and ${f.thumbsDown} 👎 on Kody's comments.`,
                    });
                }
            }

            return results;
        },
    };
}
