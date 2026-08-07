import { LLMModelProvider } from '@libs/llm/model-providers';
import type { LlmTask, NormalizedModel } from '@libs/llm/byok-config';
import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { LLM_TASK } from '@libs/llm/byok-config';

@Injectable()
export abstract class BaseAgentProvider {
    protected byokConfig?: NormalizedModel;
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
     * The routing task this agent resolves its model from. Defaults to
     * `conversation` (the chat agent); a concrete agent overrides it to route to
     * its own model — e.g. the business-rules validation agent returns
     * `businessValidation` (which inherits `conversation`'s model when unset via
     * TASK_ROUTING_FALLBACK in the resolver). One hook, so every agent that
     * extends this base picks its task without touching fetchBYOKConfig.
     */
    protected getLlmTask(): LlmTask {
        return LLM_TASK.conversation;
    }

    /**
     * Fetches BYOK configuration for the organization.
     *
     * Resolution goes through the permission service's per-task entry point
     * (`resolveTaskSlot(org, this.getLlmTask(), …)`) — the `conversation` task by
     * default, or whatever a subclass's getLlmTask() returns — which sources the
     * FULL config and routes by task to the bare model slot (RESEARCH Pitfall 1).
     * A non-v2 / managed / BLOCKED config resolves to `undefined` → the
     * env/managed default (matches a missing config today; never throws).
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

        // byokModelId (id) wins over the legacy byokModel NAME; the strategy
        // handles the id-THEN-name match inside the resolver.
        const overrideRef =
            byokModelIdOverride?.trim() || byokModelOverride?.trim();
        this.byokConfig =
            (await this.permissionValidationService.resolveTaskSlot(
                organizationAndTeamData,
                this.getLlmTask(),
                {
                    ctx: overrideRef
                        ? { override: { modelId: overrideRef } }
                        : {},
                },
            )) ?? undefined;
    }
}
