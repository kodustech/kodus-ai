import {
    LLMModelProvider,
    BYOKConfig,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';

@Injectable()
export abstract class BaseAgentProvider {
    protected byokConfig?: BYOKConfig;
    protected organizationAndTeamData?: OrganizationAndTeamData;

    protected abstract readonly defaultLLMConfig: {
        llmProvider: LLMModelProvider;
        temperature: number;
        maxTokens: number;
        maxReasoningTokens: number;
        stop: string[] | undefined;
    };

    /**
     * Abstract method to create MCP adapter
     * Each agent can implement its own filtering logic
     */
    protected abstract createMCPAdapter(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void>;

    constructor(
        protected readonly promptRunnerService: PromptRunnerService,
        protected readonly permissionValidationService: PermissionValidationService,
        protected readonly observabilityService: ObservabilityService,
    ) {}

    /**
     * Fetches BYOK configuration for the organization.
     *
     * `byokModelOverride` is the per-repository/directory model resolved by
     * the code review pipeline (`codeReviewConfig.byokModel`). `getBYOKConfig()`
     * returns the raw org-level config, so without applying it here an agent
     * invoked during a review would run on the BYOK-settings main model and
     * ignore the override. Empty/absent means "inherit" (no override).
     */
    protected async fetchBYOKConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        byokModelOverride?: string,
    ): Promise<void> {
        this.organizationAndTeamData = organizationAndTeamData;

        const byokConfig =
            await this.permissionValidationService.getBYOKConfig(
                organizationAndTeamData,
            );

        const overrideModel = byokModelOverride?.trim();
        this.byokConfig =
            overrideModel && byokConfig?.main
                ? {
                      ...byokConfig,
                      main: { ...byokConfig.main, model: overrideModel },
                  }
                : byokConfig;
    }
}
