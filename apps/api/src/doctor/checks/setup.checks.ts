import {
    DoctorCheck,
    DoctorContext,
    DoctorResult,
    DoctorTeam,
    platformLabel,
    teamScope,
} from '../doctor.types';

/**
 * The gates a webhook passes before a review is queued
 * (webhook-context.service.ts:46, integrationConfig.repository.ts:215).
 * Any one of them missing drops the event with only a warn log.
 */
export const setupCheck: DoctorCheck = {
    id: 'setup',
    blocking: true,
    async run(ctx: DoctorContext): Promise<DoctorResult[]> {
        const results: DoctorResult[] = [];

        if (!ctx.codeReviewAutomationSeeded) {
            results.push({
                check: 'setup.automation_seed',
                status: 'fail',
                title: 'The code review automation is missing from the database.',
                impact: 'Every Git event is ignored, so no review runs.',
                fix: 'Run the seeds (RUN_SEEDS=true on the api, then restart it). doctor.sh checks the public.automation table.',
            });
        }

        const connected = ctx.teams.filter((t) => t.platform);
        if (!connected.length) {
            results.push({
                check: 'setup.git_connected',
                status: 'fail',
                title: 'No team is connected to a Git provider.',
                impact: 'There is nothing to review.',
                fix: 'Open the web app, finish onboarding and connect GitHub, GitLab, Bitbucket, Azure Repos or Forgejo.',
            });
            return results;
        }

        // A team's broken setup stops the install only when no other team
        // reviews: on a multi-team install it stops that team alone, and a
        // team that turned automation off did so on purpose.
        const reviews = (t: DoctorTeam) =>
            t.teamStatus === 'active' &&
            t.integrationActive &&
            t.repositories.length > 0 &&
            t.codeReviewAutomationActive;
        const installReviews = connected.some(reviews);

        for (const team of connected) {
            const scope = teamScope(team);
            const git = platformLabel(team.platform);
            const problems: DoctorResult[] = [];
            const push = (title: string, fix: string, onPurpose = false) =>
                problems.push({
                    check: 'setup.team',
                    status: !installReviews
                        ? 'fail'
                        : onPurpose
                          ? 'skip'
                          : 'warn',
                    scope,
                    title,
                    impact: installReviews
                        ? "Git events for this team are ignored, so this team's pull requests are not reviewed."
                        : 'Git events for this team are ignored, so its pull requests are not reviewed.',
                    fix,
                });

            if (team.teamStatus !== 'active') {
                push(
                    `The team is not active (status "${team.teamStatus}").`,
                    'Finish the team onboarding in the web app so the team becomes active.',
                );
            }
            if (!team.integrationActive) {
                push(
                    `The ${git} connection is disabled.`,
                    `Reconnect ${git} in Settings > Git.`,
                );
            }
            if (!team.repositories.length) {
                push(
                    'No repository is selected for review.',
                    `Select repositories in Settings > Git (${git}).`,
                );
            }
            if (!team.codeReviewAutomationActive) {
                push(
                    'Automatic code review is turned off for this team.',
                    'Turn on code review for the team in Settings > Code Review (team_automations.status).',
                    true,
                );
            }
            // No gate in the webhook or review path reads the organization
            // status (webhook-context.service.ts, integrationConfig.repository
            // findIntegrationConfigWithTeams), so it is reported, not failed.
            if (!team.organizationActive) {
                problems.push({
                    check: 'setup.organization',
                    status: 'info',
                    scope,
                    title: 'The organization is marked disabled.',
                    impact: 'Reviews do not check this flag; other parts of the app may.',
                    fix: 'If this is not intended, re-enable the organization (organizations.status).',
                });
            }

            results.push(
                ...(problems.some((p) => p.check === 'setup.team')
                    ? problems
                    : [
                          ...problems,
                          {
                              check: 'setup.team',
                              status: 'ok' as const,
                              scope,
                              title: `${team.repositories.length} ${team.repositories.length === 1 ? 'repository' : 'repositories'} selected on ${git}, review automation on.`,
                          },
                      ]),
            );
        }

        return results;
    },
};

/** Stored code review settings (parameters.code_review_config). */
export interface CodeReviewSettings {
    team: DoctorTeam;
    /** `null` = global settings of the team, otherwise the repository name. */
    repository: string | null;
    config: {
        automatedReviewActive?: boolean;
        runOnDraft?: boolean;
        baseBranches?: string[];
        ignorePaths?: string[];
        ignoredTitleKeywords?: string[];
        reviewCadence?: { type?: string };
        showStatusFeedback?: boolean;
    };
}

/**
 * Settings that skip reviews on purpose (validate-config.stage.ts:250-574,
 * fetch-changed-files.stage.ts:99) are "configured to skip", not broken.
 *
 * `defaultIgnorePaths` is the default "Ignored files" list. A config that
 * changed the field stores it in full (the backfill migration
 * 2026082700000000 copied the default into it), so only what goes beyond the
 * default is something the team chose to skip.
 */
export function skipSettingsCheck(
    load: (ctx: DoctorContext) => Promise<CodeReviewSettings[]>,
    defaultIgnorePaths: () => readonly string[] = () => [],
): DoctorCheck {
    return {
        id: 'config.skip',
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];
            const settings = await load(ctx);
            const defaults = new Set(
                settings.some((s) => s.config.ignorePaths?.length)
                    ? defaultIgnorePaths()
                    : [],
            );
            for (const { team, repository, config } of settings) {
                const scope = teamScope(team, repository ?? undefined);
                const where = repository
                    ? 'Settings > Code Review for this repository'
                    : 'Settings > Code Review (global)';
                const skip = (title: string) =>
                    results.push({
                        check: 'config.skip',
                        status: 'skip',
                        scope,
                        title,
                        fix: `Change it in ${where} if this is not intended.`,
                    });

                if (config.automatedReviewActive === false) {
                    skip(
                        'Automatic reviews are off; Kody reviews only when asked with @kody start-review.',
                    );
                } else if (config.reviewCadence?.type === 'manual') {
                    skip(
                        'Review cadence is manual; Kody reviews only when asked.',
                    );
                } else if (config.reviewCadence?.type === 'auto_pause') {
                    skip(
                        'Review cadence is auto-pause; reviews pause after a burst of pushes.',
                    );
                }
                if (config.runOnDraft === false) {
                    skip('Draft pull requests are skipped.');
                }
                if (config.baseBranches?.length) {
                    skip(
                        `Only pull requests into ${config.baseBranches.slice(0, 5).join(', ')} are reviewed.`,
                    );
                }
                const ownIgnorePaths = (config.ignorePaths ?? []).filter(
                    (p) => !defaults.has(p),
                );
                if (ownIgnorePaths.length) {
                    skip(
                        `${ownIgnorePaths.length} path pattern(s) beyond the default list are ignored (${ownIgnorePaths.slice(0, 3).join(', ')}).`,
                    );
                }
                if (config.ignoredTitleKeywords?.length) {
                    skip(
                        `Pull requests whose title contains ${config.ignoredTitleKeywords
                            .slice(0, 3)
                            .map((k) => `"${k}"`)
                            .join(', ')} are skipped.`,
                    );
                }
                if (config.showStatusFeedback === false) {
                    results.push({
                        check: 'advisory.status_feedback',
                        status: 'info',
                        scope,
                        title: 'Kody does not say on the PR when it skips a review.',
                        impact: 'A skipped review leaves no trace on the pull request.',
                        fix: `Turn on "status feedback" in ${where} while you diagnose.`,
                    });
                } else if (config.showStatusFeedback === true) {
                    results.push({
                        check: 'advisory.status_feedback',
                        status: 'ok',
                        scope,
                        title: 'Kody says on the PR when it skips a review.',
                    });
                }
            }
            return results;
        },
    };
}

/** With a valid license, reviews skipped because the PR author has no seat. */
export function seatsCheck(
    countUnlicensedSkips: (
        team: DoctorTeam,
    ) => Promise<{ pullRequests: number; since: Date }>,
): DoctorCheck {
    return {
        id: 'license.seats',
        blocking: true,
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            if (!ctx.licensed) {
                return [];
            }
            const results: DoctorResult[] = [];
            for (const team of ctx.teams.filter((t) => t.platform)) {
                const { pullRequests, since } =
                    await countUnlicensedSkips(team);
                if (pullRequests === 0) {
                    results.push({
                        check: 'license.seats',
                        status: 'ok',
                        scope: teamScope(team),
                        title: `No pull request since ${since.toISOString().slice(0, 10)} was skipped for a missing seat.`,
                    });
                }
                if (pullRequests > 0) {
                    results.push({
                        check: 'license.seats',
                        status: 'fail',
                        scope: teamScope(team),
                        title: `${pullRequests} pull request(s) since ${since.toISOString().slice(0, 10)} were not reviewed because their author has no seat.`,
                        impact: 'Pull requests from people without a seat are never reviewed.',
                        fix: 'Assign seats in Settings > Subscription, turn on automatic seat assignment, or buy more seats.',
                    });
                }
            }
            return results;
        },
    };
}

/** AST graph per selected repo (repositories.ast_graph_status). */
export function astGraphCheck(
    load: (
        ctx: DoctorContext,
    ) => Promise<
        Array<{ team: DoctorTeam; repository: string; status: string | null }>
    >,
): DoctorCheck {
    return {
        id: 'ast.graph',
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const byTeam = new Map<DoctorTeam, string[]>();
            const rows = await load(ctx);
            if (!rows.length) {
                return []; // no selected repository: nothing to build
            }
            for (const row of rows) {
                if (row.status !== 'ready') {
                    byTeam.set(row.team, [
                        ...(byTeam.get(row.team) ?? []),
                        `${row.repository} (${row.status ?? 'never built'})`,
                    ]);
                }
            }
            if (!byTeam.size) {
                return [
                    {
                        check: 'ast.graph',
                        status: 'ok',
                        title: 'The code graph is built for every selected repository.',
                    },
                ];
            }
            return [...byTeam].map(([team, repos]) => ({
                check: 'ast.graph',
                status: 'warn' as const,
                scope: teamScope(team),
                title: `The code graph is not ready for ${repos.slice(0, 5).join(', ')}${repos.length > 5 ? ` and ${repos.length - 5} more` : ''}.`,
                impact: 'Kody reviews these repositories without knowing who calls the changed code.',
                fix: 'Run ./scripts/backfill-ast-graph.sh, then follow the worker logs for "ast-graph". A failed build usually means the worker cannot clone the repository.',
            }));
        },
    };
}

/** Teams whose clone is tested: one repository each, so a token per team. */
export const MAX_CLONE_TESTS = 5;

export interface CloneOutcome {
    team: DoctorTeam;
    repository: string;
    error?: string;
}

/** Effective sandbox and a read-only test clone (git ls-remote) per team. */
export function sandboxCheck(
    testClones: (ctx: DoctorContext) => Promise<CloneOutcome[]>,
): DoctorCheck {
    return {
        id: 'sandbox',
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const provider = (ctx.env.SANDBOX_PROVIDER ?? 'auto').toLowerCase();
            if (
                provider === 'null' ||
                (provider === 'e2b' && !ctx.env.API_E2B_KEY)
            ) {
                return []; // reported by configEnvCheck
            }
            const effective =
                provider === 'e2b' ||
                (provider === 'auto' && ctx.env.API_E2B_KEY)
                    ? 'e2b'
                    : 'local';
            if (effective === 'e2b') {
                return [
                    {
                        check: 'sandbox.mode',
                        status: 'ok',
                        title: 'Repository work runs in E2B (the test clone is skipped to avoid E2B cost).',
                    },
                ];
            }

            const outcomes = await testClones(ctx);
            if (!outcomes.length) {
                return [
                    {
                        check: 'sandbox.clone',
                        status: 'unknown',
                        title: 'No repository to test cloning with.',
                    },
                ];
            }
            const results: DoctorResult[] = outcomes
                .filter((o) => o.error)
                .map((o) => ({
                    check: 'sandbox.clone',
                    status: 'warn' as const,
                    scope: teamScope(o.team),
                    title: `The server cannot clone ${o.repository}.`,
                    impact: 'Kody reviews only the diff: no cross-file context, and the code graph cannot be built.',
                    fix: `Check that the worker can reach ${platformLabel(o.team.platform)} over HTTPS and that the token can clone (GitLab group or project tokens need read_repository). git said: ${o.error}`,
                }));
            const cloned = outcomes.filter((o) => !o.error);
            if (cloned.length) {
                results.push({
                    check: 'sandbox.clone',
                    status: 'ok',
                    title: `Local sandbox: the server can clone ${cloned.map((o) => o.repository).join(', ')}.`,
                });
            }
            return results;
        },
    };
}

export interface VersionStatusLike {
    unknown?: boolean;
    reason?: string;
    current?: string;
    latest?: string;
    releaseUrl?: string;
    updateAvailable?: boolean;
}

export function versionCheck(
    getStatus: () => Promise<VersionStatusLike>,
): DoctorCheck {
    return {
        id: 'version',
        async run(): Promise<DoctorResult[]> {
            const status = await getStatus();
            if (status.unknown) {
                return [
                    {
                        check: 'version',
                        status: 'unknown',
                        title:
                            status.reason === 'no-version'
                                ? `Could not tell which Kodus version this is (${status.current || 'unset'}).`
                                : 'Could not check for a newer Kodus release (no access to github.com).',
                        fix: 'Compare RELEASE_VERSION with https://github.com/kodustech/kodus-ai/releases.',
                    },
                ];
            }
            if (status.updateAvailable) {
                return [
                    {
                        check: 'version',
                        status: 'info',
                        title: `Kodus ${status.current} is behind the latest release ${status.latest}.`,
                        impact: 'Review fixes and improvements released since then are missing; the reviews that run are not affected otherwise.',
                        fix: `Upgrade (see ${status.releaseUrl ?? 'the release notes'}).`,
                    },
                ];
            }
            return [
                {
                    check: 'version',
                    status: 'ok',
                    title: `Kodus ${status.current} is the latest release.`,
                },
            ];
        },
    };
}

/** Days before expiry when the edition line starts to say so. */
export const LICENSE_EXPIRY_NOTICE_DAYS = 14;

/** What the Community Edition turns off (shouldLimitResources, custom-agents-plan.ts). */
const COMMUNITY_LIMITS =
    'Only the first 10 Kody Rules are applied during reviews, custom agents do not run, and analytics, SSO and seat management are off.';

export const editionCheck: DoctorCheck = {
    id: 'edition',
    async run(ctx: DoctorContext): Promise<DoctorResult[]> {
        const license = ctx.license ?? {
            status: ctx.licensed ? 'valid' : 'none',
        };
        if (license.status === 'valid') {
            const expires = license.expiresAt
                ? new Date(license.expiresAt)
                : null;
            const daysLeft = expires
                ? Math.floor((expires.getTime() - Date.now()) / 86_400_000)
                : null;
            if (daysLeft !== null && daysLeft < LICENSE_EXPIRY_NOTICE_DAYS) {
                return [
                    {
                        check: 'edition',
                        status: 'info',
                        title: `The Enterprise license expires on ${license.expiresAt!.slice(0, 10)} (${Math.max(daysLeft, 0)} day(s) left).`,
                        impact: `After that the install runs as the Community Edition: ${COMMUNITY_LIMITS}`,
                        fix: 'Renew the license with Kodus and update KODUS_LICENSE_KEY (or Settings > Subscription).',
                    },
                ];
            }
            return [
                {
                    check: 'edition',
                    status: 'ok',
                    title: `Enterprise license is valid${license.expiresAt ? ` until ${license.expiresAt.slice(0, 10)}` : ''}.`,
                },
            ];
        }
        if (license.status === 'expired') {
            return [
                {
                    check: 'edition',
                    status: 'warn',
                    title: 'The Enterprise license has expired; the install runs as the Community Edition.',
                    impact: COMMUNITY_LIMITS,
                    fix: 'Renew the license with Kodus and update KODUS_LICENSE_KEY (or Settings > Subscription).',
                },
            ];
        }
        if (license.status === 'invalid') {
            return [
                {
                    check: 'edition',
                    status: 'warn',
                    title: 'KODUS_LICENSE_KEY is set but is not a valid license key; the install runs as the Community Edition.',
                    impact: COMMUNITY_LIMITS,
                    fix: 'Paste the key exactly as Kodus sent it (one line, no quotes or spaces), then restart api and worker.',
                },
            ];
        }
        const misnamed = !!ctx.env.API_KODUS_LICENSE_KEY?.trim();
        return [
            {
                check: 'edition',
                status: misnamed ? 'warn' : 'info',
                title: misnamed
                    ? 'API_KODUS_LICENSE_KEY is set, but Kodus reads the license from KODUS_LICENSE_KEY: the install runs as the Community Edition.'
                    : 'Running the Community Edition (no license key).',
                impact: COMMUNITY_LIMITS,
                fix: misnamed
                    ? 'Rename the variable to KODUS_LICENSE_KEY on api and worker, then restart them.'
                    : 'Optional: set KODUS_LICENSE_KEY.',
            },
        ];
    },
};

/** MongoDB answers: pull requests and findings live there. */
export function mongoCheck(ping: () => Promise<void>): DoctorCheck {
    return {
        id: 'database.mongo',
        blocking: true,
        async run(): Promise<DoctorResult[]> {
            try {
                await ping();
                return [
                    {
                        check: 'database.mongo',
                        status: 'ok',
                        title: 'MongoDB answers.',
                    },
                ];
            } catch (error) {
                return [
                    {
                        check: 'database.mongo',
                        status: 'fail',
                        title: 'Cannot reach MongoDB.',
                        impact: 'Reviews cannot load or save pull requests and their findings, so they fail.',
                        fix: `Check that MongoDB is running and that API_MG_DB_* (or MONGODB_URI) is right on api and worker. Error: ${String((error as Error)?.message ?? error).slice(0, 160)}`,
                    },
                ];
            }
        },
    };
}

/** Enterprise only: the analytics worker ingests (analytics.ingestion_runs). */
export function analyticsCheck(
    lastRun: () => Promise<{
        status: string | null;
        finishedAt: Date | null;
        lagHours: number | null;
    } | null>,
): DoctorCheck {
    return {
        id: 'analytics',
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            if (!ctx.licensed) {
                return [];
            }
            const run = await lastRun();
            const fix =
                'Run a worker with WORKER_ROLE=analytics and check its logs for "ingestion".';
            if (!run) {
                return [
                    {
                        check: 'analytics.ingestion',
                        status: 'info',
                        title: 'Analytics has never ingested data.',
                        impact: 'The analytics dashboards stay empty. Reviews are not affected.',
                        fix,
                    },
                ];
            }
            if (
                run.lagHours === null ||
                run.lagHours > 26 ||
                run.status === 'failed'
            ) {
                return [
                    {
                        check: 'analytics.ingestion',
                        status: 'info',
                        title: `Analytics last ingested successfully ${run.lagHours === null ? 'never' : `${Math.round(run.lagHours)}h ago`}${run.status === 'failed' ? ' and the latest run failed' : ''}.`,
                        impact: 'The analytics dashboards are stale. Reviews are not affected.',
                        fix,
                    },
                ];
            }
            return [
                {
                    check: 'analytics.ingestion',
                    status: 'ok',
                    title: `Analytics ingested ${Math.round(run.lagHours)}h ago.`,
                },
            ];
        },
    };
}
