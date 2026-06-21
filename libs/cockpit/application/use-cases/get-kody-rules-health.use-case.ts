import { Inject, Injectable } from '@nestjs/common';

import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IKodyRule,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey, ParametersKey } from '@libs/core/domain/enums';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';

import {
    CockpitRangeQuery,
    KodyRuleHealthRow,
    KodyRuleHealthState,
    KodyRuleUsageRow,
} from '../../domain/types';
import {
    COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN,
    ICockpitReviewAnalyticsService,
} from '../../domain/contracts/cockpit-review-analytics.service.contract';

/**
 * "Kody Rules — health" table: merges warehouse usage (triggers /
 * implementation rate per rule, from `suggestions_mv.brokenKodyRulesIds`)
 * with rule metadata from Mongo `kodyRules` — which is also what surfaces
 * ACTIVE rules that never triggered in the window (`stale`).
 *
 * States:
 *  - `stale`     active rule with zero triggers in the window
 *  - `low_data`  triggered, but not enough sample to judge
 *  - `noisy`     the team actively downvotes what this rule produces
 *  - `ignored`   triggers a lot, almost nothing gets implemented
 *  - `healthy`   everything else
 *
 * `noisy` outranks `ignored`: explicit disagreement is a stronger signal
 * than passive inaction, and its fix is different (rewrite/scope the rule
 * vs. ask whether it matters at all).
 */

const MIN_TRIGGERS_TO_JUDGE = 5;
const IGNORED_MAX_RATE = 0.2;
const NOISY_MIN_THUMBS_DOWN = 3;

export function computeRuleState(usage: KodyRuleUsageRow | undefined): {
    state: KodyRuleHealthState;
    usage: Omit<KodyRuleUsageRow, 'ruleId'>;
} {
    if (!usage || usage.triggers === 0) {
        return {
            state: 'stale',
            usage: {
                triggers: 0,
                implemented: 0,
                rate: 0,
                thumbsUp: usage?.thumbsUp ?? 0,
                thumbsDown: usage?.thumbsDown ?? 0,
                lastTriggeredAt: usage?.lastTriggeredAt ?? null,
            },
        };
    }

    const { triggers, implemented, rate, thumbsUp, thumbsDown, lastTriggeredAt } =
        usage;
    let state: KodyRuleHealthState = 'healthy';
    if (triggers < MIN_TRIGGERS_TO_JUDGE) {
        state = 'low_data';
    } else if (thumbsDown >= NOISY_MIN_THUMBS_DOWN && thumbsDown > thumbsUp) {
        state = 'noisy';
    } else if (rate <= IGNORED_MAX_RATE) {
        state = 'ignored';
    }
    return {
        state,
        usage: { triggers, implemented, rate, thumbsUp, thumbsDown, lastTriggeredAt },
    };
}

@Injectable()
export class GetKodyRulesHealthUseCase {
    constructor(
        @Inject(COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN)
        private readonly reviewAnalytics: ICockpitReviewAnalyticsService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    /**
     * Builds the scope-label lookups for the org by walking each team's config
     * (both are team-scoped, so a single org can hold several):
     *  - `directoryId → folder path(s)` from the code-review config. A
     *    directory can group several folders, so the whole list is surfaced.
     *  - `repositoryId → full name` from the code-management integration's
     *    repository list. This is the authoritative source for EVERY selected
     *    repo, unlike the warehouse (`getRepositoryNames`) which only knows
     *    repos that have had a PR analyzed — so a repo-scoped rule on a repo
     *    with no reviewed PRs no longer falls back to a raw numeric id.
     *
     * Both are best-effort: a config-lookup failure must not take down the
     * health table; callers fall back to the raw id.
     */
    private async resolveScopeMaps(organizationId: string): Promise<{
        dirFolders: Map<string, string[]>;
        repoNames: Map<string, string>;
    }> {
        const dirFolders = new Map<string, string[]>();
        const repoNames = new Map<string, string>();
        try {
            const teams = await this.teamService.find({
                organization: { uuid: organizationId },
            });

            await Promise.all(
                teams.map(async (team) => {
                    const orgTeam = { organizationId, teamId: team.uuid };
                    const [reviewConfig, repos] = await Promise.all([
                        this.parametersService
                            .findByKey(
                                ParametersKey.CODE_REVIEW_CONFIG,
                                orgTeam,
                            )
                            .catch(() => undefined),
                        this.integrationConfigService
                            .findIntegrationConfigFormatted<Repositories[]>(
                                IntegrationConfigKey.REPOSITORIES,
                                orgTeam,
                            )
                            .catch(() => undefined),
                    ]);

                    for (const repo of reviewConfig?.configValue
                        ?.repositories ?? []) {
                        for (const dir of repo.directories ?? []) {
                            const paths = (dir?.folders ?? [])
                                .map((f) => f?.path)
                                .filter((p): p is string => Boolean(p));
                            // Fall back to the directory's name when it carries
                            // no folder paths, so we never surface a raw id when
                            // the config has a usable label.
                            const labels = paths.length
                                ? paths
                                : dir?.name
                                  ? [dir.name]
                                  : [];
                            if (dir?.id && labels.length)
                                dirFolders.set(dir.id, labels);
                        }
                    }

                    for (const repo of repos ?? []) {
                        const name = repo?.full_name || repo?.name;
                        if (repo?.id && name) repoNames.set(repo.id, name);
                    }
                }),
            );
        } catch {
            // Best-effort metadata enrichment; never break the table.
        }

        return { dirFolders, repoNames };
    }

    async execute(q: CockpitRangeQuery): Promise<KodyRuleHealthRow[]> {
        const [usageRows, rulesDoc, warehouseRepoNames, scopeMaps] =
            await Promise.all([
                this.reviewAnalytics.getKodyRulesUsage(q),
                this.kodyRulesService.findByOrganizationId(q.organizationId),
                this.reviewAnalytics.getRepositoryNames(q.organizationId),
                this.resolveScopeMaps(q.organizationId),
            ]);
        const { dirFolders, repoNames: configRepoNames } = scopeMaps;

        const usageByRule = new Map(usageRows.map((u) => [u.ruleId, u]));
        const rules = (rulesDoc?.rules ?? []).filter(
            (r): r is IKodyRule & { uuid: string } =>
                Boolean(r.uuid) && r.status === KodyRulesStatus.ACTIVE,
        );

        // Only active rules are actionable — the table is for deciding what
        // to do with a rule (edit/scope/disable). Usage rows whose rule was
        // deleted or is no longer active are dropped: they can't be acted on
        // and would just be noise.
        const out: KodyRuleHealthRow[] = rules.map((rule) => {
            const { state, usage } = computeRuleState(
                usageByRule.get(rule.uuid),
            );
            // `'global'` is the org-wide sentinel (not a repo named "global");
            // normalize it — and empty strings — to null so consumers read
            // "no repository → global scope".
            const rawRepoId = rule.repositoryId ?? null;
            const repositoryId =
                rawRepoId && rawRepoId !== 'global' ? rawRepoId : null;
            // Folder scope is keyed off `directoryId`, NOT `rule.path`: `path`
            // is a file glob (`**/*.ts`) every rule carries and says nothing
            // about where the rule is scoped.
            const directoryId = rule.directoryId || null;
            return {
                ruleId: rule.uuid,
                title: rule.title,
                severity: rule.severity ?? null,
                repositoryId,
                // Prefer the warehouse name (full_name with activity context),
                // fall back to the integration config so repos with no reviewed
                // PR still resolve instead of showing a raw numeric id.
                repositoryName: repositoryId
                    ? (warehouseRepoNames.get(repositoryId) ??
                      configRepoNames.get(repositoryId) ??
                      null)
                    : null,
                directoryId,
                directoryFolders: directoryId
                    ? (dirFolders.get(directoryId) ?? null)
                    : null,
                state,
                ...usage,
            };
        });

        return out.sort((a, b) => b.triggers - a.triggers);
    }
}
