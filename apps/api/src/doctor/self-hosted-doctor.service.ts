import { execFile } from 'child_process';
import { promisify } from 'util';

import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
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
import { buildGitAuthHeader } from '@libs/sandbox/infrastructure/providers/git-auth-header';

import { VersionCheckService } from '../services/version-check.service';
import {
    brokerCheck,
    amqpBrokerProbe,
    staleJobsCheck,
} from './checks/broker.checks';
import { bootEnvCheck, configEnvCheck } from './checks/env.checks';
import { gitAccessCheck, webhookUrlCheck } from './checks/git.checks';
import { liveLlmComplete, llmCheck } from './checks/llm.checks';
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
} from './doctor.types';

const execFileAsync = promisify(execFile);

/** A check that hangs must not hang the report. */
export const CHECK_TIMEOUT_MS = 90_000;
const SEAT_LOOKBACK_DAYS = 14;

@Injectable()
export class SelfHostedDoctorService {
    private readonly logger = createLogger(SelfHostedDoctorService.name);

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
        private readonly codeManagementService: CodeManagementService,
        private readonly permissionValidationService: PermissionValidationService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        private readonly cockpitHealthService: CockpitHealthService,
        private readonly versionCheckService: VersionCheckService,
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
            webhookUrlCheck({ reach: reachUrl }),
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
            skipSettingsCheck((ctx) => this.loadCodeReviewSettings(ctx)),
            editionCheck,
            analyticsCheck(() => this.lastAnalyticsRun()),
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

        const firstOrg = teams[0];
        let licensed = false;
        if (firstOrg) {
            try {
                licensed = (
                    await this.licenseService.validateOrganizationLicense({
                        organizationId: firstOrg.organizationId,
                        teamId: firstOrg.teamId,
                    })
                ).valid;
            } catch {
                licensed = false;
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

    private async countUnlicensedSkips(
        team: DoctorTeam,
    ): Promise<{ pullRequests: number; since: Date }> {
        const since = new Date(Date.now() - SEAT_LOOKBACK_DAYS * 86_400_000);
        const [row] = await this.dataSource.query(
            `SELECT COUNT(DISTINCT (ae."repositoryId", ae."pullRequestNumber"))::int AS count
               FROM automation_execution ae
               JOIN team_automations ta ON ta.uuid = ae.team_automation_id
              WHERE ta."teamUuid" = $1
                AND ae.status = 'skipped'
                AND ae."createdAt" >= $2
                AND (ae."errorMessage" ILIKE 'User Not Licensed%'
                     OR EXISTS (SELECT 1 FROM code_review_execution cre
                                 WHERE cre.automation_execution_id = ae.uuid
                                   AND cre.message ILIKE 'User Not Licensed%'))`,
            [team.teamId, since],
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

        const args = ['-c', 'credential.helper='];
        if (params.auth?.token) {
            args.push(
                '-c',
                `http.extraHeader=${buildGitAuthHeader(
                    params.provider as PlatformType,
                    params.auth.token,
                    params.auth.username,
                )}`,
            );
        }
        args.push('ls-remote', '--heads', params.url);

        try {
            await execFileAsync('git', args, {
                timeout: 30_000,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            });
            return { repository: repository.name };
        } catch (error: any) {
            const detail = String(error?.stderr || error?.message || error)
                .split('\n')
                .filter(Boolean)
                .slice(-2)
                .join(' ')
                .slice(0, 200);
            // The header is in argv; never let it reach the report.
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
