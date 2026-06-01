import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@libs/automation/domain/automation/contracts/automation.service';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';

export type WebhookDisambiguator = {
    /**
     * Host of the source provider (e.g. `gitlab.ikatec.cloud`). Used to pick
     * the correct IntegrationConfig when (platform, repositoryId) collide
     * across self-hosted instances. Compared against
     * `integration.authIntegration.authDetails.host`.
     */
    host?: string;
};

@Injectable()
export class WebhookContextService {
    private readonly logger = createLogger(WebhookContextService.name);

    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,
    ) {}

    /**
     * Retrieves the organization, team, and active automation context.
     */
    async getContext(
        platformType: PlatformType,
        repositoryId: string,
        disambiguator?: WebhookDisambiguator,
    ): Promise<{
        organizationAndTeamData: OrganizationAndTeamData;
        teamAutomationId: string;
    } | null> {
        const configs =
            await this.integrationConfigService.findIntegrationConfigWithTeams(
                IntegrationConfigKey.REPOSITORIES,
                repositoryId,
                platformType,
            );

        if (!configs?.length) {
            return null;
        }

        const candidates = this.disambiguateConfigs(configs, disambiguator);

        const automations = await this.automationService.find({
            automationType: AutomationType.AUTOMATION_CODE_REVIEW,
        });
        const automation = automations?.[0];

        if (!automation) {
            // The repository is connected but no code review automation exists
            // in the system at all — a setup/seed problem, not a per-team one.
            this.logger.warn({
                message:
                    'Webhook ignored: no code review automation is registered in the system',
                context: WebhookContextService.name,
                metadata: { platformType, repositoryId },
            });
            return null;
        }

        const candidateTeamIds: string[] = [];

        for (const config of candidates) {
            if (!config?.team?.organization?.uuid || !config?.team?.uuid) {
                continue;
            }

            candidateTeamIds.push(config.team.uuid);

            const teamAutomations = await this.teamAutomationService.find({
                automation: { uuid: automation.uuid },
                status: true,
                team: { uuid: config.team.uuid },
            });

            if (teamAutomations?.length > 0) {
                return {
                    organizationAndTeamData: {
                        organizationId: config.team.organization.uuid,
                        teamId: config.team.uuid,
                    },
                    teamAutomationId: teamAutomations[0].uuid,
                };
            }
        }

        // The repository is connected (integration configs were found) but no
        // candidate team has an ACTIVE code review automation. This is the
        // silent-drop path — e.g. a webhook arriving right after onboarding
        // before the team_automation row is active. Log it so the gap is
        // observable instead of vanishing without a trace.
        this.logger.warn({
            message:
                'Webhook ignored: repository is connected but no team has an active code review automation',
            context: WebhookContextService.name,
            metadata: { platformType, repositoryId, candidateTeamIds },
        });

        return null;
    }

    /**
     * Narrow the candidate configs using provider-specific signals from the
     * webhook payload. Falls back to the original list whenever the filter
     * cannot uniquely identify a single config — never worse than current
     * behaviour, only strictly better when we can be sure.
     */
    private disambiguateConfigs(
        configs: any[],
        disambiguator?: WebhookDisambiguator,
    ): any[] {
        if (configs.length <= 1) {
            return configs;
        }

        const targetHost = normalizeHost(disambiguator?.host);
        if (!targetHost) {
            return configs;
        }

        const configHosts = configs.map((c) =>
            normalizeHost(c?.integration?.authIntegration?.authDetails?.host),
        );

        // If any candidate is missing a host (legacy data, never written),
        // we cannot trust the comparison: a config without host would be
        // silently excluded and we might pick the wrong one. Fall back to
        // current behaviour rather than risk routing the webhook elsewhere.
        if (configHosts.some((h) => !h)) {
            return configs;
        }

        const filtered = configs.filter(
            (_, i) => configHosts[i] === targetHost,
        );

        return filtered.length === 1 ? filtered : configs;
    }
}

function normalizeHost(value: string | undefined | null): string | undefined {
    if (!value) {
        return undefined;
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        const url = new URL(
            trimmed.includes('://') ? trimmed : `https://${trimmed}`,
        );
        return url.hostname.toLowerCase();
    } catch {
        return trimmed.toLowerCase().replace(/\/.*$/, '');
    }
}
