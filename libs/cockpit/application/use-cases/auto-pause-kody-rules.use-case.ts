import { Inject, Injectable } from '@nestjs/common';

import { createKodyRulesAutoPauseResolver } from '@libs/common/utils/kody-rules/kody-rules-auto-pause-settings';
import { ParametersKey } from '@libs/core/domain/enums';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import { CreateKodyRuleDto } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IKodyRule,
    IKodyRuleAutoPause,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { NotificationService } from '@libs/notifications/application/notification.service';
import {
    KodyRuleAutoPauseEntry,
    NotificationEvent,
} from '@libs/notifications/domain/catalog/events';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CentralizedConfigParameter } from '@libs/organization/domain/parameters/types/configValue.type';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';

import {
    COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN,
    ICockpitReviewAnalyticsService,
} from '../../domain/contracts/cockpit-review-analytics.service.contract';
import {
    AutoPauseSkipReason,
    autoPauseWindowStart,
    decideAutoPause,
} from '../../domain/helpers/kody-rules-auto-pause.helper';
import { isCockpitTierAllowed } from '../../domain/tier-policy';
import { KodyRuleUsageRow } from '../../domain/types';
import { CockpitHealthService } from '../../infrastructure/services/cockpit-health.service';

/** Same staleness bar as the self-hosted doctor's analytics check. */
const MAX_INGESTION_LAG_HOURS = 26;

const DAY_MS = 24 * 60 * 60 * 1000;

const SYSTEM_USER = { userId: 'kody-system', userEmail: 'kody@kodus.io' };

type ActiveRule = IKodyRule & { uuid: string };

export type AutoPauseOrganizationSkip =
    'tier' | 'no_active_rules' | 'setting_off' | 'centralized_config';

export interface AutoPauseOrganizationResult {
    organizationId: string;
    skipped?: AutoPauseOrganizationSkip;
    evaluated: number;
    paused: number;
    failed: number;
    skippedRules: Partial<Record<AutoPauseSkipReason, number>>;
}

export interface AutoPauseRunResult {
    skipped?: 'warehouse_unavailable' | 'warehouse_stale';
    organizations: number;
    failedOrganizations: number;
    paused: number;
    failed: number;
}

/**
 * Pauses the active Kody Rules Cockpit labels ignored or noisy, for
 * organizations that turned `kodyRulesAutoPauseEnabled` on, and tells their
 * admins in-app. The weekly email is `SendKodyRulesAutoPauseDigestUseCase`.
 *
 * Without fresh warehouse data nothing is judged: self-hosted installs without
 * the analytics worker skip the whole run.
 */
@Injectable()
export class AutoPauseKodyRulesUseCase {
    private readonly logger = createLogger(AutoPauseKodyRulesUseCase.name);

    constructor(
        @Inject(COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN)
        private readonly reviewAnalytics: ICockpitReviewAnalyticsService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        private readonly cockpitHealth: CockpitHealthService,
        private readonly notificationService: NotificationService,
    ) {}

    async execute(now: Date = new Date()): Promise<AutoPauseRunResult> {
        const result: AutoPauseRunResult = {
            organizations: 0,
            failedOrganizations: 0,
            paused: 0,
            failed: 0,
        };

        const warehouse = await this.checkWarehouse();
        if (warehouse) {
            this.logger.log({
                message: `Kody Rules auto-pause skipped: ${warehouse}`,
                context: AutoPauseKodyRulesUseCase.name,
                metadata: { reason: warehouse },
            });
            return { ...result, skipped: warehouse };
        }

        const organizationIds =
            await this.kodyRulesService.findOrganizationIdsWithRules();

        for (const organizationId of organizationIds) {
            if (!organizationId) continue;
            result.organizations++;
            try {
                const org = await this.executeForOrganization(
                    organizationId,
                    now,
                );
                result.paused += org.paused;
                result.failed += org.failed;
            } catch (error) {
                result.failedOrganizations++;
                this.logger.error({
                    message: 'Kody Rules auto-pause failed for organization',
                    context: AutoPauseKodyRulesUseCase.name,
                    error,
                    metadata: { organizationId },
                });
            }
        }

        return result;
    }

    async executeForOrganization(
        organizationId: string,
        now: Date = new Date(),
    ): Promise<AutoPauseOrganizationResult> {
        const result: AutoPauseOrganizationResult = {
            organizationId,
            evaluated: 0,
            paused: 0,
            failed: 0,
            skippedRules: {},
        };
        const skip = (skipped: AutoPauseOrganizationSkip) => {
            this.logger.log({
                message: `Kody Rules auto-pause skipped organization: ${skipped}`,
                context: AutoPauseKodyRulesUseCase.name,
                metadata: { organizationId, reason: skipped },
            });
            return { ...result, skipped };
        };

        const license = await this.licenseService.validateOrganizationLicense({
            organizationId,
        });
        if (!isCockpitTierAllowed(license)) return skip('tier');

        const doc =
            await this.kodyRulesService.findByOrganizationId(organizationId);
        const activeRules = (doc?.rules ?? []).filter(
            (rule): rule is ActiveRule =>
                Boolean(rule.uuid) && rule.status === KodyRulesStatus.ACTIVE,
        );
        if (!activeRules.length) return skip('no_active_rules');

        const teams = await this.loadTeams(organizationId);
        const settingOn = createKodyRulesAutoPauseResolver(
            teams.map((team) => team.codeReviewConfig),
        );
        const candidates = activeRules.filter((rule) =>
            settingOn({
                repositoryId: rule.repositoryId,
                directoryId: rule.directoryId,
            }),
        );
        if (!candidates.length) return skip('setting_off');

        // A pause on a config-as-code org opens a PR to its config repository.
        // Those rules are left alone, so is every rule of a team using it.
        if (teams.some((team) => team.centralized)) {
            return skip('centralized_config');
        }

        const usageByRule = await this.loadUsage(
            organizationId,
            candidates,
            now,
        );

        const paused: KodyRuleAutoPauseEntry[] = [];
        for (const rule of candidates) {
            result.evaluated++;
            const window = usageByRule.get(rule.uuid);
            const decision = decideAutoPause({
                rule,
                usage: window?.usage,
                settingOn: true,
                centralized: Boolean(rule.centralizedConfig?.path),
            });
            if (decision.action === 'skip') {
                result.skippedRules[decision.reason] =
                    (result.skippedRules[decision.reason] ?? 0) + 1;
                continue;
            }

            const usage = window!.usage!;
            const autoPause: IKodyRuleAutoPause = {
                state: decision.state,
                pausedAt: now,
                windowStart: window!.start,
                windowEnd: now,
                triggers: usage.triggers,
                implemented: usage.implemented,
                rate: usage.rate,
                thumbsUp: usage.thumbsUp,
                thumbsDown: usage.thumbsDown,
                digestedAt: null,
            };

            try {
                await this.kodyRulesService.createOrUpdate(
                    {
                        organizationId,
                        teamId: this.teamFor(rule, teams),
                    } as OrganizationAndTeamData,
                    {
                        ...rule,
                        status: KodyRulesStatus.PAUSED,
                        autoPause,
                    } as unknown as CreateKodyRuleDto,
                    SYSTEM_USER,
                );
                result.paused++;
                paused.push(toEntry(rule, autoPause));
                this.logger.log({
                    message: 'Kody Rule paused automatically',
                    context: AutoPauseKodyRulesUseCase.name,
                    metadata: {
                        organizationId,
                        ruleId: rule.uuid,
                        repositoryId: rule.repositoryId,
                        state: decision.state,
                        triggers: usage.triggers,
                        implemented: usage.implemented,
                        thumbsUp: usage.thumbsUp,
                        thumbsDown: usage.thumbsDown,
                        windowStart: window!.start.toISOString(),
                    },
                });
            } catch (error) {
                result.failed++;
                this.logger.error({
                    message: 'Failed to pause Kody Rule automatically',
                    context: AutoPauseKodyRulesUseCase.name,
                    error,
                    metadata: { organizationId, ruleId: rule.uuid },
                });
            }
        }

        if (paused.length) {
            await this.notify(organizationId, paused);
        }

        this.logger.log({
            message: 'Kody Rules auto-pause organization done',
            context: AutoPauseKodyRulesUseCase.name,
            metadata: {
                organizationId,
                evaluated: result.evaluated,
                paused: result.paused,
                failed: result.failed,
                skippedRules: result.skippedRules,
            },
        });

        return result;
    }

    private async checkWarehouse(): Promise<
        AutoPauseRunResult['skipped'] | undefined
    > {
        try {
            const ping = await this.cockpitHealth.ping();
            if (ping.status !== 'ok') return 'warehouse_unavailable';

            const { lagHours } = await this.cockpitHealth.runsSummary();
            if (lagHours === null || lagHours > MAX_INGESTION_LAG_HOURS) {
                return 'warehouse_stale';
            }
            return undefined;
        } catch {
            return 'warehouse_unavailable';
        }
    }

    private async loadTeams(organizationId: string): Promise<
        Array<{
            teamId: string;
            codeReviewConfig: CodeReviewParameter | undefined;
            centralized: boolean;
        }>
    > {
        const teams = await this.teamService.find({
            organization: { uuid: organizationId },
        });

        return Promise.all(
            (teams ?? []).map(async (team) => {
                const orgTeam = { organizationId, teamId: team.uuid };
                const [codeReview, centralized] = await Promise.all([
                    this.parametersService.findByKey(
                        ParametersKey.CODE_REVIEW_CONFIG,
                        orgTeam,
                    ),
                    this.parametersService.findByKey(
                        ParametersKey.CENTRALIZED_CONFIG,
                        orgTeam,
                    ),
                ]);
                return {
                    teamId: team.uuid,
                    codeReviewConfig: codeReview?.configValue as
                        CodeReviewParameter | undefined,
                    centralized: Boolean(
                        (
                            centralized?.configValue as
                                CentralizedConfigParameter | undefined
                        )?.enabled,
                    ),
                };
            }),
        );
    }

    /** The team whose config lists the rule's repository, else the first. */
    private teamFor(
        rule: ActiveRule,
        teams: Array<{
            teamId: string;
            codeReviewConfig: CodeReviewParameter | undefined;
        }>,
    ): string | undefined {
        const owner = teams.find((team) =>
            (team.codeReviewConfig?.repositories ?? []).some(
                (repo) => String(repo.id) === String(rule.repositoryId),
            ),
        );
        return (owner ?? teams[0])?.teamId;
    }

    /**
     * One usage query per distinct window start: the full window for most
     * rules, one more per resume date (rare).
     */
    private async loadUsage(
        organizationId: string,
        rules: ActiveRule[],
        now: Date,
    ): Promise<Map<string, { start: Date; usage?: KodyRuleUsageRow }>> {
        const byStart = new Map<
            string,
            { start: Date; resumed: boolean; ruleIds: string[] }
        >();
        for (const rule of rules) {
            const start = autoPauseWindowStart(now, rule.resumedAt);
            const resumed =
                !!rule.resumedAt &&
                start.getTime() === new Date(rule.resumedAt).getTime();
            const key = `${start.toISOString()}:${resumed}`;
            const group = byStart.get(key) ?? { start, resumed, ruleIds: [] };
            group.ruleIds.push(rule.uuid);
            byStart.set(key, group);
        }

        const out = new Map<
            string,
            { start: Date; usage?: KodyRuleUsageRow }
        >();
        for (const { start, resumed, ruleIds } of byStart.values()) {
            const rows = await this.reviewAnalytics.getKodyRulesUsage(
                {
                    organizationId,
                    startDate: start.toISOString(),
                    endDate: now.toISOString(),
                },
                {
                    suggestionsCreatedSince: resumed
                        ? start.toISOString()
                        : undefined,
                },
            );
            const rowsByRule = new Map(rows.map((row) => [row.ruleId, row]));
            for (const ruleId of ruleIds) {
                out.set(ruleId, { start, usage: rowsByRule.get(ruleId) });
            }
        }
        return out;
    }

    private async notify(
        organizationId: string,
        rules: KodyRuleAutoPauseEntry[],
    ): Promise<void> {
        try {
            const repoNames = await this.reviewAnalytics
                .getRepositoryNames(organizationId)
                .catch(() => new Map<string, string>());

            await this.notificationService.emit({
                event: NotificationEvent.KODY_RULES_AUTO_PAUSED,
                organizationId,
                payload: {
                    rules: rules.map((rule) => ({
                        ...rule,
                        repositoryName: rule.repositoryId
                            ? (repoNames.get(rule.repositoryId) ?? null)
                            : null,
                    })),
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to notify admins of auto-paused Kody Rules',
                context: AutoPauseKodyRulesUseCase.name,
                error,
                metadata: {
                    organizationId,
                    ruleIds: rules.map((rule) => rule.ruleId),
                },
            });
        }
    }
}

export function toEntry(
    rule: Partial<
        Pick<IKodyRule, 'uuid' | 'title' | 'repositoryId' | 'directoryId'>
    >,
    autoPause: IKodyRuleAutoPause,
): KodyRuleAutoPauseEntry {
    const repositoryId =
        rule.repositoryId && rule.repositoryId !== 'global'
            ? rule.repositoryId
            : null;
    return {
        ruleId: rule.uuid!,
        title: rule.title ?? '',
        repositoryId,
        directoryId: rule.directoryId || null,
        state: autoPause.state,
        triggers: autoPause.triggers,
        implemented: autoPause.implemented,
        rate: autoPause.rate,
        thumbsUp: autoPause.thumbsUp,
        thumbsDown: autoPause.thumbsDown,
        windowDays: Math.max(
            1,
            Math.round(
                (new Date(autoPause.windowEnd).getTime() -
                    new Date(autoPause.windowStart).getTime()) /
                    DAY_MS,
            ),
        ),
        pausedAt: new Date(autoPause.pausedAt).toISOString(),
    };
}
