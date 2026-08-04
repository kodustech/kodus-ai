import { LLMModelProvider } from '@libs/llm/model-providers';
import type { BYOKConfig } from '@libs/llm/byok-config';
import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { resolveTaskCarrier } from '@libs/llm/resolve-task-model';
import { LLM_TASK } from '@libs/llm/byok-config';

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
        protected readonly permissionValidationService: PermissionValidationService,
        protected readonly observabilityService: ObservabilityService,
    ) {}

    /**
     * Fetches BYOK configuration for the organization.
     *
     * Skill agents run the `conversation` task. The FULL v2 config is sourced
     * via `getBYOKConfigV2Raw` and routed through `resolveTaskSlot` for
     * the `conversation` task, so routing is by task rather than always the
     * collapsed main slot (RESEARCH Pitfall 1). A non-v2 / managed / BLOCKED
     * config resolves to `undefined` → the env/managed default (matches a
     * missing config today; never throws).
     *
     * `byokModelOverride` is the legacy per-repository/directory model NAME
     * resolved by the code review pipeline (`codeReviewConfig.byokModel`).
     * `byokModelIdOverride` is the Phase-4 id-based override
     * (`codeReviewConfig.byokModelId`) and WINS over the NAME during the
     * transition window (D-05). Empty/absent means "inherit" (no override).
     */
    protected async fetchBYOKConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        byokModelOverride?: string,
        byokModelIdOverride?: string,
    ): Promise<void> {
        this.organizationAndTeamData = organizationAndTeamData;

        const rawV2 =
            await this.permissionValidationService.getBYOKConfigV2Raw(
                organizationAndTeamData,
            );

        // byokModelId (id) wins over the legacy byokModel NAME; the strategy
        // handles the id-THEN-name match inside resolveTaskSlot.
        const overrideRef =
            byokModelIdOverride?.trim() || byokModelOverride?.trim();
        this.byokConfig = resolveTaskCarrier(rawV2, LLM_TASK.conversation, {
            ctx: overrideRef ? { override: { modelId: overrideRef } } : {},
        });
    }
}
