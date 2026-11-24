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
 * reviews must not flip the whole install to DEGRADED (verdictOf).
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

export interface ReviewRunsDeps {
    runs(team: DoctorTeam): Promise<ReviewRun[]>;
}

/** Read from Mongo, so a slow aggregation only costs these lines. */
export interface SuggestionsDeps {
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
    /** A quality note the admin cannot act on: never turns the verdict DEGRADED. */
    infoOnly?: true;
}

const kind = (k: string) => (run: ReviewRun) => run.warningKinds.includes(k);
const anyKind = (kinds: string[]) => (run: ReviewRun) =>
    run.warningKinds.some((k) => kinds.includes(k));

const KNOWLEDGE_KINDS = [
    'SKILL_NOT_FOUND',
    'SKILL_INVALID',
    'DOC_NOT_FOUND',
    'KNOWLEDGE_UNAVAILABLE',
    'KNOWLEDGE_TRUNCATED',
    'SKILL_COMPATIBILITY',
];
const AGENT_TOOL_KINDS = ['CLI_INSTALL_FAILED', 'AST_GREP_UNAVAILABLE'];
/** Recorded by design, nothing was lost (review-warnings.ts). */
const BENIGN_KINDS = new Set(['SKILL_CHANGED_IN_PR']);

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
    'reviews.partial': {
        matches: (run) => run.status === 'partial_error',
        title: (n, t) =>
            `${n} of ${t} reviews finished with issues: a step around the review failed.`,
        impact: 'Part of those reviews may be missing, for example the summary or the pull-request-level comments.',
        fix: 'Open the review timeline of those pull requests in the dashboard to see which step failed.',
    },
    'reviews.cut_short': {
        matches: (run) => run.agentCutShort,
        title: (n, t) =>
            `${n} of ${t} reviews had an agent stop before it finished (time or step limit, or an error).`,
        impact: 'Part of those pull requests was not reviewed.',
        fix: 'Check the review timeline of those pull requests in the dashboard; a slow model or a very large pull request causes it.',
    },
    'reviews.verify': {
        matches: kind('VERIFY_UNAVAILABLE'),
        title: (n, t) =>
            `${n} of ${t} reviews discarded findings because their verification failed.`,
        impact: 'Those findings were never posted.',
        fix: 'Verification calls the review model: check the model lines above, then the worker logs for "verify".',
    },
    'reviews.knowledge': {
        matches: anyKind(KNOWLEDGE_KINDS),
        title: (n, t) =>
            `${n} of ${t} reviews ran without some of the skills or docs linked to your custom agents.`,
        impact: 'Those agents reviewed without the guidance you linked.',
        fix: "Check that each linked skill and doc exists on the pull request's target branch (Settings > Custom agents); the review timeline names the missing ones.",
    },
    'reviews.agent_tools': {
        matches: anyKind(AGENT_TOOL_KINDS),
        title: (n, t) =>
            `${n} of ${t} reviews ran a custom agent without one of its tools (a CLI or ast-grep).`,
        impact: 'Those agents could not run the checks that need the tool.',
        fix: 'Check the worker logs for "CLI install"; the sandbox needs network access to install a CLI.',
    },
    'reviews.cross_repo': {
        matches: kind('CROSS_REPO_UNAVAILABLE'),
        title: (n, t) =>
            `${n} of ${t} reviews could not read the linked repositories.`,
        impact: 'Those reviews stayed single-repository.',
        fix: 'Linked repositories are read from the checkout: see the sandbox lines.',
    },
    'reviews.config_file': {
        matches: kind('CONFIG_FILE_KEY_IGNORED'),
        title: (n, t) =>
            `${n} of ${t} reviews ignored keys of kodus-config.yml that are set only in the app (customAgents, knowledge).`,
        impact: 'What those keys say did not apply.',
        fix: 'Configure custom agents and their knowledge in the app, and remove those keys from kodus-config.yml.',
        infoOnly: true,
    },
    'reviews.fix_downgraded': {
        matches: kind('BAD_FIX_DOWNGRADED'),
        title: (n, t) =>
            `${n} of ${t} reviews posted a finding without its code fix, because the fix was unusable.`,
        impact: 'Those findings came as plain comments.',
        fix: 'Nothing to configure; a stronger review model produces fewer of them.',
        infoOnly: true,
    },
};

/** Kinds no line above explains: still a loss, never a "ran in full". */
const MAPPED_KINDS = new Set([
    'SANDBOX_UNAVAILABLE',
    'CALLGRAPH_FAILED',
    'PROVIDER_FALLBACK',
    ...CONTEXT_WINDOW_KINDS,
    'LOW_SIGNAL_FILES_DROPPED',
    'KODY_RULES_PARTIAL',
    'RULE_CONTEXT_UNAVAILABLE',
    'SUGGESTIONS_DROPPED_PATH_MISMATCH',
    'VERIFY_UNAVAILABLE',
    ...KNOWLEDGE_KINDS,
    ...AGENT_TOOL_KINDS,
    'CROSS_REPO_UNAVAILABLE',
    'CONFIG_FILE_KEY_IGNORED',
    'BAD_FIX_DOWNGRADED',
    ...BENIGN_KINDS,
]);

function unmappedKinds(run: ReviewRun): string[] {
    return run.warningKinds.filter((k) => !MAPPED_KINDS.has(k));
}

/**
 * `command`: an `@kody -v <agent>` request that did not run. The regular
 * review of that pull request is not affected (validate-config.stage.ts
 * skips only when `onlyCustomAgent` is set), so it is not a missed review.
 */
type SkipKind = 'settings' | 'seat' | 'failure' | 'command' | 'other';

interface SkipReason {
    kind: SkipKind;
    label: string;
    fix?: string;
}

/**
 * The reasons a review is skipped, by the start of the message the pipeline
 * records (PipelineReasons, AutomationMessage). Only `settings` is the team's
 * choice; `failure` is a review that should have run.
 */
export const SKIP_REASONS: Array<{ prefix: string } & SkipReason> = [
    {
        prefix: 'Automated Review is disabled',
        kind: 'settings',
        label: 'automatic review off',
    },
    { prefix: 'Title Ignored', kind: 'settings', label: 'ignored title' },
    { prefix: 'Draft PR Skipped', kind: 'settings', label: 'draft' },
    {
        prefix: 'Branch Mismatch',
        kind: 'settings',
        label: 'target branch not reviewed',
    },
    {
        prefix: 'All Files Ignored',
        kind: 'settings',
        label: 'every file ignored',
    },
    {
        prefix: 'No files remain after applying ignore patterns',
        kind: 'settings',
        label: 'every file ignored',
    },
    { prefix: 'Too Many Files', kind: 'settings', label: 'too many files' },
    { prefix: 'No New Commits', kind: 'settings', label: 'no new commits' },
    {
        prefix: 'No new commits since the last run',
        kind: 'settings',
        label: 'no new commits',
    },
    {
        prefix: 'Only Merge Commits',
        kind: 'settings',
        label: 'only merge commits',
    },
    {
        prefix: 'Only merge commits since the last run',
        kind: 'settings',
        label: 'only merge commits',
    },
    {
        prefix: 'Rebase Without Changes',
        kind: 'settings',
        label: 'rebase without changes',
    },
    { prefix: 'PR is Closed', kind: 'settings', label: 'closed' },
    { prefix: 'PR is Locked', kind: 'settings', label: 'locked' },
    {
        prefix: 'User is ignored by configuration',
        kind: 'settings',
        label: 'ignored author',
    },
    {
        prefix: 'Manual mode requires',
        kind: 'settings',
        label: 'manual cadence',
    },
    { prefix: 'PR is paused', kind: 'settings', label: 'paused' },
    {
        prefix: 'Code reviews are disabled for the',
        kind: 'settings',
        label: 'configuration repository',
    },
    {
        prefix: 'No custom agent matches',
        kind: 'command',
        label: 'no custom agent has that name',
        fix: 'Check the agent names in Settings > Custom agents.',
    },
    // license.seats reports these with their own fix.
    {
        prefix: 'User Not Licensed',
        kind: 'seat',
        label: 'author without a seat',
    },
    {
        prefix: 'Provider Rate Limited',
        kind: 'failure',
        label: 'the Git provider rate-limited Kodus',
        fix: 'Give Kodus a token of its own (or a GitHub App, which has its own quota), then ask again with @kody start-review.',
    },
    {
        prefix: 'The Git provider rate-limited the request',
        kind: 'failure',
        label: 'the Git provider rate-limited Kodus',
        fix: 'Give Kodus a token of its own (or a GitHub App, which has its own quota), then ask again with @kody start-review.',
    },
    {
        prefix: 'Unable to load or resolve the review configuration',
        kind: 'failure',
        label: 'the review configuration could not be read',
        fix: 'Check the kodus-config.yml of the repository (a syntax error is the usual cause), then the worker logs for "ResolveConfigStage".',
    },
    {
        prefix: 'Error during configuration validation',
        kind: 'failure',
        label: 'the review configuration failed to validate',
        fix: 'Check the worker logs for "ValidateConfigStage".',
    },
    {
        prefix: 'No code-review configuration found',
        kind: 'failure',
        label: 'no review configuration was loaded',
        fix: 'Open Settings > Code Review and save once, then check the worker logs.',
    },
    {
        prefix: 'Changes Unreadable',
        kind: 'failure',
        label: "the Git provider's diff could not be read",
        fix: 'Ask again with @kody start-review; if it repeats, check that the token can read the repository.',
    },
    {
        prefix: 'Invalid Context Data',
        kind: 'failure',
        label: 'pull request data was missing',
        fix: 'Check the worker logs for "ValidatePrerequisitesStage".',
    },
    {
        prefix: 'Prerequisites validation failed',
        kind: 'failure',
        label: 'the prerequisites check failed',
        fix: 'Check the worker logs for "ValidatePrerequisitesStage".',
    },
    {
        prefix: 'BYOK Configuration Required',
        kind: 'failure',
        label: 'the BYOK configuration is incomplete',
        fix: 'See the model lines above (user menu > BYOK).',
    },
    {
        prefix: 'No Active Subscription',
        kind: 'failure',
        label: 'no valid license',
        fix: 'See the edition line (KODUS_LICENSE_KEY).',
    },
    {
        prefix: 'Plan Limit Exceeded',
        kind: 'failure',
        label: "the license's limit was reached",
        fix: 'See the edition and seat lines.',
    },
    {
        prefix: 'Subscription Check Unavailable',
        kind: 'failure',
        label: 'the license could not be checked',
        fix: 'Check the api logs for "license", then ask again with @kody start-review.',
    },
    {
        prefix: 'Custom agents are in beta',
        kind: 'command',
        label: 'custom agents need BETA_FEATURES=true',
        fix: 'Set BETA_FEATURES=true on api and worker and restart them.',
    },
    {
        prefix: "Custom agents are not on this organization's plan",
        kind: 'command',
        label: 'custom agents are not on the license',
        fix: 'Custom agents need a Teams or Enterprise license.',
    },
    { prefix: 'No Files Changed', kind: 'other', label: 'no changed files' },
    {
        prefix: 'No changed files in this pull request',
        kind: 'other',
        label: 'no changed files',
    },
];

export function skipReasonOf(message?: string | null): SkipReason {
    const text = (message ?? '').trim();
    const known = SKIP_REASONS.find((r) => text.startsWith(r.prefix));
    if (known) {
        return { kind: known.kind, label: known.label, fix: known.fix };
    }
    return {
        kind: 'other',
        label: text.split(' — ')[0].slice(0, 80) || 'no reason recorded',
    };
}

function breakdown(labels: string[]): string {
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([l, n]) => `${n} ${l}`)
        .join(', ');
}

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
 * what each run recorded; it never judges whether a finding was right. A run
 * skipped for a reason that is not a setting (rate limit, broken config,
 * BYOK) is a review that did not happen, not "skipped by your settings".
 */
export function recentReviewsCheck(deps: ReviewRunsDeps): DoctorCheck {
    return {
        id: 'reviews.recent',
        blocking: true,
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];

            for (const team of reviewableTeams(ctx)) {
                const scope = teamScope(team);
                const runs = await deps.runs(team);
                const skips = runs
                    .filter((r) => r.status === 'skipped')
                    .map((r) => ({
                        run: r,
                        reason: skipReasonOf(r.errorMessage),
                    }));
                const onPurpose = skips.filter(
                    (s) => s.reason.kind === 'settings',
                );
                const failedSkips = skips.filter(
                    (s) => s.reason.kind === 'failure',
                );
                const unclear = skips.filter((s) => s.reason.kind === 'other');
                const commands = skips.filter(
                    (s) => s.reason.kind === 'command',
                );
                const reviewed = runs.filter((r) => r.status !== 'skipped');
                const errors = reviewed.filter((r) => r.status === 'error');
                /** Pull requests a review was owed to (seat skips: license.seats). */
                const attempted = reviewed.length + failedSkips.length;

                if (onPurpose.length) {
                    results.push({
                        check: 'reviews.skipped',
                        status: 'skip',
                        scope,
                        title: `${onPurpose.length} pull request(s) in the last ${RECENT_DAYS} days were skipped by your settings (${breakdown(onPurpose.map((s) => s.reason.label))}).`,
                        fix: 'See the "configured to skip" lines; change them in Settings > Code Review if this is not intended.',
                    });
                }
                if (commands.length) {
                    const top = mostCommon(commands.map((s) => s.reason.label));
                    results.push({
                        check: 'reviews.command_skipped',
                        status: 'info',
                        scope,
                        title: `${commands.length} \`@kody -v\` request(s) in the last ${RECENT_DAYS} days did not run (${breakdown(commands.map((s) => s.reason.label))}); the regular reviews were not affected.`,
                        fix: commands.find((s) => s.reason.label === top)!
                            .reason.fix,
                    });
                }
                if (unclear.length) {
                    results.push({
                        check: 'reviews.skipped_other',
                        status: 'info',
                        scope,
                        title: `${unclear.length} pull request(s) in the last ${RECENT_DAYS} days were skipped (${breakdown(unclear.map((s) => s.reason.label))}).`,
                        fix: 'Expected for pull requests that change nothing. If they did change code, check that the Git token can read them (see the Git lines).',
                    });
                }

                if (!attempted) {
                    const seen = [
                        skips.some((s) => s.reason.kind === 'seat') &&
                            'the seat line',
                        onPurpose.length &&
                            'the "skipped by your settings" line',
                        unclear.length && 'the "were skipped" line',
                        commands.length && 'the "@kody -v" line',
                    ].filter(Boolean);
                    results.push({
                        check: 'reviews.none',
                        status: 'info',
                        scope,
                        title: `No pull request was reviewed in the last ${RECENT_DAYS} days.`,
                        fix: skips.length
                            ? `Every pull request of the window was skipped: see ${seen.join(' and ')}.`
                            : 'If pull requests were opened, check the webhook lines above.',
                    });
                    continue;
                }

                const failures = errors.length + failedSkips.length;
                const topCause = () => {
                    const causes = [
                        ...errors.map((r) => ({
                            label: r.errorMessage || 'no error recorded',
                            fix: 'Check the worker logs.',
                        })),
                        ...failedSkips.map((s) => ({
                            label: `not run: ${s.reason.label}`,
                            fix: s.reason.fix ?? 'Check the worker logs.',
                        })),
                    ];
                    const top = mostCommon(causes.map((c) => c.label));
                    return causes.find((c) => c.label === top)!;
                };
                if (failures === attempted && attempted >= MIN_DEGRADED_RUNS) {
                    const cause = topCause();
                    results.push({
                        check: 'reviews.failed',
                        status: 'fail',
                        scope,
                        title: `No pull request got a review in the last ${RECENT_DAYS} days: all ${attempted} attempts failed.`,
                        impact: "No pull request gets Kody's comments.",
                        fix: `Most common cause: ${cause.label}. ${cause.fix}`,
                    });
                    continue;
                }
                if (errors.length) {
                    const topError = mostCommon(
                        errors.map((r) => r.errorMessage),
                    );
                    results.push({
                        check: 'reviews.failed',
                        status: isDegraded(errors.length, attempted)
                            ? 'warn'
                            : 'info',
                        scope,
                        title: `${errors.length} of ${attempted} reviews in the last ${RECENT_DAYS} days failed.`,
                        impact: 'Those pull requests got no review.',
                        fix: `Most common error: ${topError ?? 'none recorded'}. Check the worker logs.`,
                    });
                }
                if (failedSkips.length) {
                    const top = mostCommon(
                        failedSkips.map((s) => s.reason.label),
                    );
                    const reason = failedSkips.find(
                        (s) => s.reason.label === top,
                    )!.reason;
                    results.push({
                        check: 'reviews.not_run',
                        status: isDegraded(failedSkips.length, attempted)
                            ? 'warn'
                            : 'info',
                        scope,
                        title: `${failedSkips.length} of ${attempted} pull requests in the last ${RECENT_DAYS} days were not reviewed (${breakdown(failedSkips.map((s) => s.reason.label))}).`,
                        impact: 'Those pull requests got no review, although nothing in the settings asked for that.',
                        fix: reason.fix ?? 'Check the worker logs.',
                    });
                }

                const completed = reviewed.filter((r) => r.status !== 'error');
                const lossCounts = new Map<string, number>();
                const unmapped = new Set<string>();
                let unmappedRuns = 0;
                for (const run of completed) {
                    for (const [check, loss] of Object.entries(LOSSES)) {
                        if (loss.matches(run)) {
                            lossCounts.set(
                                check,
                                (lossCounts.get(check) ?? 0) + 1,
                            );
                        }
                    }
                    const other = unmappedKinds(run);
                    if (other.length) {
                        unmappedRuns += 1;
                        other.forEach((k) => unmapped.add(k));
                    }
                }
                for (const [check, loss] of Object.entries(LOSSES)) {
                    const count = lossCounts.get(check) ?? 0;
                    if (!count) continue;
                    results.push({
                        check,
                        status:
                            !loss.infoOnly &&
                            isDegraded(count, completed.length)
                                ? 'warn'
                                : 'info',
                        scope,
                        title: loss.title(count, completed.length),
                        impact: loss.impact,
                        fix: loss.fix,
                    });
                }
                if (unmappedRuns) {
                    results.push({
                        check: 'reviews.other_losses',
                        status: 'info',
                        scope,
                        title: `${unmappedRuns} of ${completed.length} reviews recorded other losses (${[...unmapped].slice(0, 4).join(', ')}).`,
                        fix: 'Open the review timeline of those pull requests in the dashboard for the details.',
                    });
                }
                if (!lossCounts.size && !unmappedRuns && completed.length) {
                    results.push({
                        check: 'reviews.full',
                        status: 'ok',
                        scope,
                        title: `${completed.length} review(s) in the last ${RECENT_DAYS} days ran in full.`,
                    });
                }
            }

            return results;
        },
    };
}

/** What happened to the findings, per organization that reviews. */
export function recentSuggestionsCheck(deps: SuggestionsDeps): DoctorCheck {
    return {
        id: 'suggestions.recent',
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];
            const organizations = new Map<string, string>();
            for (const team of reviewableTeams(ctx)) {
                organizations.set(team.organizationId, team.organizationName);
            }

            // Each org costs up to two Mongo aggregations (30s cap each): run
            // them together so a few slow orgs do not outlive the check.
            const collected = await Promise.all(
                [...organizations].map(async ([organizationId, name]) => {
                    const collectReactions =
                        !!ctx.env.API_CRON_SYNC_CODE_REVIEW_REACTIONS;
                    const [suggestions, feedback] = await Promise.all([
                        deps.suggestions(organizationId),
                        collectReactions
                            ? deps.feedback(organizationId)
                            : Promise.resolve(null),
                    ]);
                    return { name, suggestions, feedback };
                }),
            );

            for (const {
                name: organizationName,
                suggestions: s,
                feedback,
            } of collected) {
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
                    // The cron stores each comment's running total, so this is the
                    // total of the comments it refreshed, not the reactions given
                    // in the window.
                    const f = feedback!;
                    results.push({
                        check: 'feedback.reactions',
                        status: 'info',
                        scope: organizationName,
                        title: `Kody's comments whose reactions were synced in the last ${RECENT_DAYS} days have ${f.thumbsUp} 👍 and ${f.thumbsDown} 👎 in total.`,
                    });
                }
            }

            return results;
        },
    };
}
