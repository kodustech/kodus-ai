import {
    LLMModelProvider,
    BYOKConfig,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { resolveModelSlotFromV2 } from '@libs/llm/normalize-byok-config';
import { StaticTaskStrategy } from '@libs/llm/static-task-strategy';

@Injectable()
export abstract class BaseAgentProvider {
    protected byokConfig?: BYOKConfig;
    protected organizationAndTeamData?: OrganizationAndTeamData;

    // Manual routing policy (Phase 4). Stateless + dependency-free.
    private readonly routingStrategy = new StaticTaskStrategy();

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
     * Skill agents run the `conversation` task. For a v2 blob, the FULL config
     * is sourced via `getBYOKConfigV2Raw` (not the collapsed `getBYOKConfig`,
     * which always yields `main`) and routed through `StaticTaskStrategy` for
     * the `conversation` task, so routing is by task rather than always main
     * (RESEARCH Pitfall 1). A legacy `{main,fallback}` blob keeps the exact
     * prior `byokModel`-onto-`main` behavior.
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

        if (rawV2) {
            // v2: route the conversation task. byokModelId (id) wins over the
            // legacy byokModel NAME; the strategy handles the id-THEN-name match.
            const overrideRef =
                byokModelIdOverride?.trim() || byokModelOverride?.trim();
            const verdict = this.routingStrategy.resolve(
                'conversation',
                overrideRef ? { override: { modelId: overrideRef } } : {},
                rawV2,
            );

            if (verdict.modelId) {
                const routedMain = resolveModelSlotFromV2(
                    rawV2,
                    verdict.modelId,
                );
                const main =
                    routedMain && verdict.modelName
                        ? { ...routedMain, model: verdict.modelName }
                        : routedMain;
                if (main) {
                    const fallback = resolveModelSlotFromV2(
                        rawV2,
                        rawV2.routing?.fallbackModelId,
                    );
                    this.byokConfig = {
                        main,
                        ...(fallback ? { fallback } : {}),
                    } as BYOKConfig;
                    return;
                }
            }
            // BLOCKED / unresolvable → env/managed default (matches missing
            // config today; never throws).
            this.byokConfig = undefined;
            return;
        }

        // Legacy {main,fallback}: exact prior behavior, byte-for-byte.
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
