import { execFile } from 'child_process';
import { promisify } from 'util';

import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { InjectDataSource } from '@nestjs/typeorm';
import { Connection } from 'mongoose';
import { DataSource } from 'typeorm';

import { createLogger } from '@libs/core/log/logger';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CockpitHealthService } from '@libs/cockpit/infrastructure/services/cockpit-health.service';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { buildGitAuthHeader } from '@libs/sandbox/infrastructure/providers/git-auth-header';

import {
    IVersionCheckService,
    VERSION_CHECK_SERVICE_TOKEN,
} from '../services/version-check.service';
import {
    brokerCheck,
    amqpBrokerProbe,
    staleJobsCheck,
} from './checks/broker.checks';
import { bootEnvCheck, configEnvCheck } from './checks/env.checks';
import {
    gitAccessCheck,
    WEBHOOK_EVENTS_CAP,
    webhookUrlCheck,
} from './checks/git.checks';
import { liveLlmComplete, llmCheck } from './checks/llm.checks';
import {
    FeedbackCounts,
    recentReviewsCheck,
    recentSuggestionsCheck,
    ReviewRun,
    SuggestionCounts,
} from './checks/reviews.checks';
import {
    analyticsCheck,
    astGraphCheck,
    CodeReviewSettings,
    editionCheck,
    sandboxCheck,
    seatsCheck,
    setupCheck,
    skipSettingsCheck,
    versionCheck,
} from './checks/setup.checks';
import { buildReport } from './doctor-report';
import {
    DoctorCheck,
    DoctorContext,
    DoctorReport,
    DoctorResult,
    DoctorTeam,
    licenseCandidates,
    RECENT_DAYS,
} from './doctor.types';

const execFileAsync = promisify(execFile);

/** A check that hangs must not hang the report. */
export const CHECK_TIMEOUT_MS = 90_000;
const SEAT_LOOKBACK_DAYS = 14;
/** Under CHECK_TIMEOUT_MS, so a slow aggregation fails alone, as "?". */
const MONGO_QUERY_TIMEOUT_MS = 30_000;

/**
 * Pull requests of a team ($1) whose latest run since $2 was skipped for a
 * missing seat. The latest run decides (#2021): a PR reviewed, or skipped for
 * any other reason, after the seat skip is no longer a seat problem to report.
 * That includes skips that say nothing about the seat (ignored author, closed
 * or locked PR, org-level license): an admin should not be told to buy a seat
 * for an author they ignore or a PR that cannot be reviewed, and org-level
 * license and model problems have checks of their own.
 */
export const UNLICENSED_SKIPS_SQL = `WITH latest AS (
                SELECT DISTINCT ON (ae."repositoryId", ae."pullRequestNumber")
                       ae.uuid, ae.status, ae."errorMessage"
                  FROM automation_execution ae
                  JOIN team_automations ta ON ta.uuid = ae.team_automation_id
                 WHERE ta."teamUuid" = $1
                   AND ae."createdAt" >= $2
                 ORDER BY ae."repositoryId", ae."pullRequestNumber", ae."createdAt" DESC)
             SELECT COUNT(*)::int AS count
               FROM latest l
              WHERE l.status = 'skipped'
                AND (l."errorMessage" ILIKE 'User Not Licensed%'
                     OR EXISTS (SELECT 1 FROM code_review_execution cre
                                 WHERE cre.automation_execution_id = l.uuid
                                   AND cre.message ILIKE 'User Not Licensed%'))`;

export function unlicensedSkipsParams(teamId: string, since: Date): unknown[] {
    return [teamId, since];
}

@Injectable()
export class SelfHostedDoctorService {
    private readonly logger = createLogger(SelfHostedDoctorService.name);

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
        @InjectConnection()
        private readonly mongo: Connection,
        private readonly codeManagementService: CodeManagementService,
        private readonly permissionValidationService: PermissionValidationService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        private readonly cockpitHealthService: CockpitHealthService,
        @Inject(VERSION_CHECK_SERVICE_TOKEN)
        private readonly versionCheckService: IVersionCheckService,
    ) {}

    async run(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
        const startedAt = Date.now();
        const results: DoctorResult[] = [];

        let ctx: DoctorContext;
        try {
            ctx = await this.loadContext(env);
        } catch (error) {
            results.push({
                check: 'database',
                status: 'fail',
                title: 'Could not read the Kodus database.',
                impact: 'Nothing can be reviewed while the database is unreachable.',
                fix: `Check Postgres (doctor.sh "Connectivity checks"). Error: ${String((error as Error)?.message ?? error).slice(0, 160)}`,
            });
            ctx = {
                teams: [],
                codeReviewAutomationSeeded: true,
                licensed: false,
                env,
            };
        }

        // Independent checks run together; runCheck turns a failure or a
        // timeout into an `unknown` line, and map keeps the report order.
        const checkResults = await Promise.all(
            this.checks().map((check) => this.runCheck(check, ctx)),
        );
        results.push(...checkResults.flat());

        return buildReport({ results, env, startedAt });
    }

    checks(): DoctorCheck[] {
        return [
            bootEnvCheck,
            brokerCheck(amqpBrokerProbe),
            staleJobsCheck(this.dataSource),
            setupCheck,
            llmCheck({
                getBYOKConfig: (organizationId) =>
                    this.permissionValidationService.getBYOKConfig({
                        organizationId,
                    }),
                complete: liveLlmComplete,
            }),
            webhookUrlCheck({
                reach: reachUrl,
                recentEvents: (platform) => this.recentGitEvents(platform),
            }),
            gitAccessCheck({
                diagnose: (team, repository) =>
                    this.codeManagementService.diagnoseRepositoryAccess({
                        organizationAndTeamData: {
                            organizationId: team.organizationId,
                            teamId: team.teamId,
                        },
                        repository,
                    }),
                reach: reachUrl,
            }),
            seatsCheck((team) => this.countUnlicensedSkips(team)),
            sandboxCheck((ctx) => this.testClone(ctx)),
            astGraphCheck((ctx) => this.loadAstStatuses(ctx)),
            configEnvCheck,
            versionCheck(() => this.versionCheckService.getStatus()),
            skipSettingsCheck(
                (ctx) => this.loadCodeReviewSettings(ctx),
                () => this.defaultIgnorePaths(),
            ),
            editionCheck,
            analyticsCheck(() => this.lastAnalyticsRun()),
            recentReviewsCheck({
                runs: (team) => this.recentReviewRuns(team),
            }),
            recentSuggestionsCheck({
                suggestions: (organizationId) =>
                    this.recentSuggestions(organizationId),
                feedback: (organizationId) =>
                    this.recentFeedback(organizationId),
            }),
        ];
    }

    private async runCheck(
        check: DoctorCheck,
        ctx: DoctorContext,
    ): Promise<DoctorResult[]> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                check.run(ctx),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `timed out after ${CHECK_TIMEOUT_MS / 1000}s`,
                                ),
                            ),
                        CHECK_TIMEOUT_MS,
                    );
                }),
            ]);
        } catch (error) {
            this.logger.warn({
                message: `Doctor check ${check.id} could not complete`,
                context: SelfHostedDoctorService.name,
                error,
            });
            return [
                {
                    check: check.id,
                    status: 'unknown',
                    title: `The "${check.id}" check could not complete.`,
                    fix: `Error: ${String((error as Error)?.message ?? error).slice(0, 200)}`,
                },
            ];
        } finally {
            clearTimeout(timer);
        }
    }

    /** Mirrors the joins of webhook-context.service.ts:46, read-only. */
    async loadContext(env: NodeJS.ProcessEnv): Promise<DoctorContext> {
        const rows: Array<{
            organizationId: string;
            organizationName: string;
            organizationActive: boolean;
            teamId: string;
            teamName: string;
            teamStatus: string;
            platform: string | null;
            integrationActive: boolean | null;
            repositories: any;
            automationActive: boolean | null;
        }> = await this.dataSource.query(
            `SELECT o.uuid AS "organizationId",
                    o.name AS "organizationName",
                    o.status AS "organizationActive",
                    t.uuid AS "teamId",
                    t.name AS "teamName",
                    t.status::text AS "teamStatus",
                    i.platform::text AS "platform",
                    i.status AS "integrationActive",
                    ic."configValue" AS "repositories",
                    (SELECT bool_or(ta.status)
                       FROM team_automations ta
                       JOIN automation a ON a.uuid = ta."automationUuid"
                      WHERE ta."teamUuid" = t.uuid
                        AND a."automationType" = 'AutomationCodeReview') AS "automationActive"
               FROM teams t
               JOIN organizations o ON o.uuid = t.organization_id
               LEFT JOIN integrations i
                      ON i.team_id = t.uuid
                     AND i."integrationCategory" = 'CODE_MANAGEMENT'
               LEFT JOIN integration_configs ic
                      ON ic.integration_id = i.uuid
                     AND ic."configKey" = 'repositories'
              WHERE t.status::text <> 'removed'
              ORDER BY o.name, t.name`,
        );

        const teams: DoctorTeam[] = rows.map((r) => ({
            organizationId: r.organizationId,
            organizationName: r.organizationName,
            organizationActive: r.organizationActive !== false,
            teamId: r.teamId,
            teamName: r.teamName,
            teamStatus: r.teamStatus,
            platform: r.platform ?? undefined,
            integrationActive: r.integrationActive === true,
            repositories: (Array.isArray(r.repositories) ? r.repositories : [])
                .filter((repo) => repo?.id !== undefined && repo?.name)
                .map((repo) => ({
                    id: String(repo.id),
                    name: String(repo.name),
                    fullName: repo.fullName ?? repo.full_name ?? undefined,
                    defaultBranch:
                        repo.default_branch ?? repo.defaultBranch ?? undefined,
                })),
            codeReviewAutomationActive: r.automationActive === true,
        }));

        const [seed] = await this.dataSource.query(
            `SELECT COUNT(*)::int AS count FROM automation WHERE "automationType" = 'AutomationCodeReview'`,
        );

        let licensed = false;
        for (const team of licenseCandidates(teams)) {
            try {
                licensed = (
                    await this.licenseService.validateOrganizationLicense({
                        organizationId: team.organizationId,
                        teamId: team.teamId,
                    })
                ).valid;
            } catch {
                licensed = false;
            }
            if (licensed) {
                break;
            }
        }

        return {
            teams,
            codeReviewAutomationSeeded: seed?.count > 0,
            licensed,
            env,
        };
    }

    private async loadCodeReviewSettings(
        ctx: DoctorContext,
    ): Promise<CodeReviewSettings[]> {
        const out: CodeReviewSettings[] = [];
        for (const team of ctx.teams.filter((t) => t.platform)) {
            const [row] = await this.dataSource.query(
                `SELECT "configValue" FROM parameters
                  WHERE team_id = $1 AND "configKey" = 'code_review_config' AND active = true
                  ORDER BY version DESC LIMIT 1`,
                [team.teamId],
            );
            const value = row?.configValue;
            if (!value) {
                continue;
            }
            if (value.configs) {
                out.push({ team, repository: null, config: value.configs });
            }
            const selected = new Set(team.repositories.map((r) => r.id));
            for (const repo of value.repositories ?? []) {
                if (repo?.configs && selected.has(String(repo.id))) {
                    // Only what the repository overrides: inherited values
                    // are already reported on the global line.
                    const own = Object.fromEntries(
                        Object.entries(repo.configs).filter(
                            ([k, v]) =>
                                JSON.stringify(v) !==
                                JSON.stringify(value.configs?.[k]),
                        ),
                    );
                    if (Object.keys(own).length) {
                        out.push({
                            team,
                            repository: repo.name ?? String(repo.id),
                            config: own,
                        });
                    }
                }
            }
        }
        return out;
    }

    /**
     * Every received Git event is enqueued as a WEBHOOK_PROCESSING job. Jobs are
     * never deleted, so the `updatedAt` bound lets idx_workflow_jobs_type_updated
     * cut the scan to the window (a job is never updated before it is created),
     * and the LIMIT caps the heap reads on an install with heavy traffic.
     */
    private async recentGitEvents(
        platform: string,
    ): Promise<{ count: number; last: Date | null }> {
        const [row] = await this.dataSource.query(
            `SELECT COUNT(*)::int AS count, MAX("createdAt") AS last
               FROM (SELECT "createdAt"
                       FROM kodus_workflow.workflow_jobs
                      WHERE "workflowType" = 'WEBHOOK_PROCESSING'
                        AND "updatedAt" > now() - make_interval(days => $2)
                        AND "createdAt" > now() - make_interval(days => $2)
                        AND metadata->>'platformType' = $1
                      ORDER BY "updatedAt" DESC
                      LIMIT $3) recent`,
            [platform, RECENT_DAYS, WEBHOOK_EVENTS_CAP],
        );
        return {
            count: row?.count ?? 0,
            last: row?.last ? new Date(row.last) : null,
        };
    }

    /**
     * Finished code review runs of the window, each with the losses it recorded
     * (dataExecution.reviewWarnings) and whether an agent stopped early (its
     * `AgentReview::*` stage label, AgentReviewStage's progress labels).
     */
    private async recentReviewRuns(team: DoctorTeam): Promise<ReviewRun[]> {
        const rows: Array<{
            status: ReviewRun['status'];
            errorMessage: string | null;
            warningKinds: string[] | null;
            agentCutShort: boolean;
        }> = await this.dataSource.query(
            `SELECT ae.status::text AS status,
                    left(ae."errorMessage", 300) AS "errorMessage",
                    ARRAY(SELECT DISTINCT w->>'kind'
                            FROM jsonb_array_elements(
                                   CASE WHEN jsonb_typeof(ae."dataExecution"->'reviewWarnings') = 'array'
                                        THEN ae."dataExecution"->'reviewWarnings'
                                        ELSE '[]'::jsonb END) w) AS "warningKinds",
                    EXISTS (SELECT 1 FROM code_review_execution cre
                             WHERE cre.automation_execution_id = ae.uuid
                               AND cre.stage_name LIKE 'AgentReview::%'
                               AND (cre.message LIKE '% — timed out after %'
                                    OR cre.message LIKE '% — hit step limit %'
                                    OR cre.message LIKE '% — failed %')) AS "agentCutShort"
               FROM automation_execution ae
               JOIN team_automations ta ON ta.uuid = ae.team_automation_id
               JOIN automation a ON a.uuid = ta."automationUuid"
              WHERE ta."teamUuid" = $1
                AND a."automationType" = 'AutomationCodeReview'
                AND ae.status::text IN ('success', 'partial_error', 'error', 'skipped')
                AND ae."createdAt" > now() - make_interval(days => $2)`,
            [team.teamId, RECENT_DAYS],
        );
        return rows.map((r) => ({
            status: r.status,
            errorMessage: r.errorMessage,
            warningKinds: r.warningKinds ?? [],
            agentCutShort: r.agentCutShort === true,
        }));
    }

    /**
     * Suggestions created in the window, file-level and pull-request-level, by
     * what happened to them. The `updatedAt` bound keeps the scan to the pull
     * requests touched in the window; `maxTimeMS` stops it on an install whose
     * planner picks a wider index.
     */
    private async recentSuggestions(
        organizationId: string,
    ): Promise<SuggestionCounts> {
        const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
        const rows = (await this.mongo
            .collection('pullRequests')
            .aggregate(
                [
                    { $match: { organizationId, updatedAt: { $gte: since } } },
                    {
                        $project: {
                            suggestion: {
                                $concatArrays: [
                                    {
                                        $reduce: {
                                            input: { $ifNull: ['$files', []] },
                                            initialValue: [],
                                            in: {
                                                $concatArrays: [
                                                    '$$value',
                                                    {
                                                        $ifNull: [
                                                            '$$this.suggestions',
                                                            [],
                                                        ],
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                    { $ifNull: ['$prLevelSuggestions', []] },
                                ],
                            },
                        },
                    },
                    { $unwind: '$suggestion' },
                    {
                        // Suggestion timestamps are ISO strings (PullRequestsService).
                        $match: {
                            'suggestion.createdAt': {
                                $gte: since.toISOString(),
                            },
                        },
                    },
                    {
                        $group: {
                            _id: {
                                delivery: '$suggestion.deliveryStatus',
                                implementation:
                                    '$suggestion.implementationStatus',
                            },
                            count: { $sum: 1 },
                        },
                    },
                ],
                { maxTimeMS: MONGO_QUERY_TIMEOUT_MS },
            )
            .toArray()) as Array<{
            _id: { delivery: string | null; implementation: string | null };
            count: number;
        }>;

        const counts: SuggestionCounts = {
            sent: 0,
            deliveryFailed: 0,
            heldBack: 0,
            implemented: 0,
        };
        for (const { _id, count } of rows) {
            // A replaced comment was posted, then superseded by a newer one.
            if (_id.delivery === 'sent' || _id.delivery === 'replaced')
                counts.sent += count;
            else if (
                _id.delivery === 'failed' ||
                _id.delivery === 'failed_lines_mismatch'
            )
                counts.deliveryFailed += count;
            else if (_id.delivery === 'not_sent') counts.heldBack += count;
            if (
                _id.implementation === 'implemented' ||
                _id.implementation === 'partially_implemented'
            )
                counts.implemented += count;
        }
        return counts;
    }

    /** Reaction snapshots the reactions cron refreshed in the window. */
    private async recentFeedback(
        organizationId: string,
    ): Promise<FeedbackCounts> {
        const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
        const [row] = (await this.mongo
            .collection('codeReviewFeedback')
            .aggregate(
                [
                    { $match: { organizationId, updatedAt: { $gte: since } } },
                    {
                        $group: {
                            _id: null,
                            thumbsUp: { $sum: '$reactions.thumbsUp' },
                            thumbsDown: { $sum: '$reactions.thumbsDown' },
                        },
                    },
                ],
                { maxTimeMS: MONGO_QUERY_TIMEOUT_MS },
            )
            .toArray()) as Array<{ thumbsUp: number; thumbsDown: number }>;
        return {
            thumbsUp: row?.thumbsUp ?? 0,
            thumbsDown: row?.thumbsDown ?? 0,
        };
    }

    /** Without the default list every pattern reads as the team's own choice. */
    private defaultIgnorePaths(): string[] {
        try {
            return (getDefaultKodusConfigFile().ignorePaths ?? []).filter(
                (p): p is string => typeof p === 'string',
            );
        } catch (error) {
            this.logger.warn({
                message:
                    "Doctor could not read the default ignore list; every ignored path is reported as the team's own",
                context: SelfHostedDoctorService.name,
                error,
            });
            return [];
        }
    }

    private async countUnlicensedSkips(
        team: DoctorTeam,
    ): Promise<{ pullRequests: number; since: Date }> {
        const since = new Date(Date.now() - SEAT_LOOKBACK_DAYS * 86_400_000);
        const [row] = await this.dataSource.query(
            UNLICENSED_SKIPS_SQL,
            unlicensedSkipsParams(team.teamId, since),
        );
        return { pullRequests: row?.count ?? 0, since };
    }

    private async loadAstStatuses(
        ctx: DoctorContext,
    ): Promise<
        Array<{ team: DoctorTeam; repository: string; status: string | null }>
    > {
        const out: Array<{
            team: DoctorTeam;
            repository: string;
            status: string | null;
        }> = [];
        for (const team of ctx.teams.filter(
            (t) => t.platform && t.repositories.length,
        )) {
            const rows: Array<{ externalId: string; status: string | null }> =
                await this.dataSource.query(
                    `SELECT r.external_id AS "externalId", r.ast_graph_status::text AS status
                       FROM repositories r
                       JOIN integration_configs ic ON ic.uuid = r.integration_config_id
                      WHERE ic.team_id = $1`,
                    [team.teamId],
                );
            const byId = new Map(rows.map((r) => [r.externalId, r.status]));
            for (const repo of team.repositories) {
                out.push({
                    team,
                    repository: repo.name,
                    status: byId.get(repo.id) ?? null,
                });
            }
        }
        return out;
    }

    /** `git ls-remote` of one selected repository: read-only, no checkout. */
    private async testClone(
        ctx: DoctorContext,
    ): Promise<{ repository: string; error?: string } | null> {
        const team = ctx.teams.find(
            (t) => t.platform && t.integrationActive && t.repositories.length,
        );
        if (!team) {
            return null;
        }
        const repository = team.repositories[0];
        const params = await this.codeManagementService.getCloneParams({
            organizationAndTeamData: {
                organizationId: team.organizationId,
                teamId: team.teamId,
            },
            repository: {
                id: repository.id,
                name: repository.name,
                fullName: repository.fullName ?? repository.name,
                defaultBranch: repository.defaultBranch,
            },
        });
        if (!params?.url) {
            return {
                repository: repository.name,
                error: 'could not build the clone URL from the stored integration',
            };
        }

        const { args, env: gitEnv } = gitLsRemoteInvocation(params);

        try {
            await execFileAsync('git', args, {
                timeout: 30_000,
                env: gitEnv,
            });
            return { repository: repository.name };
        } catch (error: any) {
            const detail = String(error?.stderr || error?.message || error)
                .split('\n')
                .filter(Boolean)
                .slice(-2)
                .join(' ')
                .slice(0, 200);
            // Belt and braces: never let the token reach the report.
            return {
                repository: repository.name,
                error: params.auth?.token
                    ? detail.split(params.auth.token).join('<redacted>')
                    : detail,
            };
        }
    }

    private async lastAnalyticsRun() {
        const summary = await this.cockpitHealthService.runsSummary();
        if (!summary.last) {
            return null;
        }
        return {
            status: summary.last.status ?? null,
            finishedAt: summary.lastOk?.finishedAt ?? null,
            lagHours: summary.lagHours,
        };
    }
}

/** Any HTTP answer means reachable; only network/TLS errors reject. */
export async function reachUrl(url: string): Promise<number> {
    const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
    });
    return res.status;
}

/**
 * `git ls-remote` of a repository with the stored credential. The auth
 * header goes through GIT_CONFIG_* env, never argv, so the credential is not
 * readable from ps, /proc/<pid>/cmdline or `docker top` (same as
 * local-sandbox.service.ts).
 */
export function gitLsRemoteInvocation(params: {
    url: string;
    provider: string;
    auth?: { token?: string; username?: string };
}): { args: string[]; env: NodeJS.ProcessEnv } {
    // Drop only injected config entries (another invocation's header could
    // ride on them); keep the admin's config sources (GIT_CONFIG_GLOBAL,
    // GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM), where a proxy or sslVerify
    // setting the real clone relies on may live.
    const injected = /^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/;
    const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !injected.test(key)),
    );
    env.GIT_TERMINAL_PROMPT = '0';
    if (params.auth?.token) {
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
        env.GIT_CONFIG_VALUE_0 = buildGitAuthHeader(
            params.provider as PlatformType,
            params.auth.token,
            params.auth.username,
        );
    }
    return {
        args: ['-c', 'credential.helper=', 'ls-remote', '--heads', params.url],
        env,
    };
}
