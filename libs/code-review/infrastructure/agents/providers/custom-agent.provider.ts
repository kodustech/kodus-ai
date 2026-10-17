import { Injectable, Optional } from '@nestjs/common';

import { LabelType } from '@libs/common/utils/codeManagement/labels';
import type {
    CodeSuggestion,
    CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { LLM_TASK, type NormalizedModel } from '@libs/llm/byok-config';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import {
    resolveReviewAgentModel,
    type ResolvedAgentModel,
} from '@libs/code-review/infrastructure/agents/collaborators/model-factory';
import { customAgentSlug } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope';
import { BaseCodeReviewAgentProvider } from '@libs/code-review/infrastructure/agents/providers/base-code-review-agent.provider';
import type {
    ReviewAgentIdentity,
    ReviewAgentInput,
    ReviewAgentOutput,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';

/**
 * The category prompt of a custom agent: the team's instructions are the
 * whole mission. A closing tag inside the instructions cannot end the block.
 */
export function buildCustomAgentPrompt(agent: CustomAgentConfig): string {
    const instructions = (agent.instructions || '')
        .replace(/<\/?TeamInstructions>/gi, '')
        .trim();
    return `  <Mission>
    You are the team's "${agent.name}" reviewer. Find the problems the team's instructions below ask you to look for, in the code this pull request changes. Investigate the codebase before reporting, and back each finding with evidence from the code.
  </Mission>

  <TeamInstructions>
${instructions}
  </TeamInstructions>

  <DoNotReport>
    Do not report:
    - issues outside what the team's instructions ask for (other reviewers cover them)
    - style or cosmetic issues, unless the instructions ask for them
    - speculative concerns without evidence in the code
  </DoNotReport>`;
}

/**
 * A team-defined reviewer (#2172). One instance per configured agent, built
 * by CustomAgentProviderFactory: the agent's config is fixed for the
 * instance's life, so the provider stays safe to run concurrently with the
 * others. Its findings carry the `custom_agent` label and the agent's
 * identity, which the pipeline reads to present them.
 */
export class CustomAgentProvider extends BaseCodeReviewAgentProvider {
    private readonly slug: string;

    constructor(
        private readonly agent: CustomAgentConfig,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        documentationSearchService?: DocumentationSearchExaService,
        byokErrorCounter?: ByokErrorCounter,
    ) {
        super(
            permissionValidationService,
            observabilityService,
            documentationSearchService,
            byokErrorCounter,
        );
        this.slug = customAgentSlug(agent.name);
    }

    get config(): CustomAgentConfig {
        return this.agent;
    }

    protected getIdentity(): ReviewAgentIdentity {
        return {
            name: `kodus-custom-agent-${this.slug}`,
            description: `Team-defined reviewer "${this.agent.name}". Reviews the changed code against the team's own instructions and investigates the codebase before reporting.`,
            goal: "Find the issues the team's instructions ask for, each backed by concrete evidence from the code.",
            expertise: [this.agent.name, 'Codebase investigation'],
        };
    }

    protected getCategoryLabel(): string {
        return LabelType.CUSTOM_AGENT;
    }

    /**
     * The label is fixed to `custom_agent` (supportsMixedLabels is false), so
     * this list only feeds the prompt's label rules, which a single-label
     * agent does not render.
     */
    protected getAllowedSuggestionLabels(): Array<
        'bug' | 'security' | 'performance'
    > {
        return ['bug'];
    }

    protected getCategoryPrompt(): string {
        return buildCustomAgentPrompt(this.agent);
    }

    protected getUsageRunName(): string {
        return `code-review-custom-${this.slug}`;
    }

    /**
     * Runs on the `customAgent` routing task and checks on `customAgentCheck`,
     * each overridable per agent by a BYOK model id. With no agent override
     * the repository's model override still applies to the run.
     */
    protected async resolveModels(
        input: ReviewAgentInput,
    ): Promise<ResolvedAgentModel & { checkByokConfig?: NormalizedModel }> {
        const runOverride = this.agent.models?.run?.trim();
        const checkOverride = this.agent.models?.check?.trim();
        const [run, check] = await Promise.all([
            resolveReviewAgentModel(
                runOverride
                    ? {
                          ...input,
                          byokModelId: runOverride,
                          byokModel: undefined,
                      }
                    : input,
                this.permissionValidationService,
                LLM_TASK.customAgent,
            ),
            resolveReviewAgentModel(
                {
                    ...input,
                    byokModelId: checkOverride || undefined,
                    byokModel: undefined,
                },
                this.permissionValidationService,
                LLM_TASK.customAgentCheck,
            ),
        ]);
        return { ...run, checkByokConfig: check.byokConfig };
    }

    async execute(input: ReviewAgentInput): Promise<ReviewAgentOutput> {
        const output = await super.execute(input);
        const stamp = {
            id: this.agent.id,
            name: this.agent.name,
            color: this.agent.presentation?.tag?.color,
        };
        const withAgent = (list?: Partial<CodeSuggestion>[]) =>
            list?.map((s) => ({ ...s, customAgent: stamp }));
        return {
            ...output,
            suggestions: withAgent(output.suggestions) ?? [],
            discardedBySeverity: withAgent(output.discardedBySeverity),
            discardedByVerify: withAgent(output.discardedByVerify),
            discardedByVerifyError: withAgent(output.discardedByVerifyError),
        };
    }
}

/** Builds a CustomAgentProvider per agent config with the shared services. */
@Injectable()
export class CustomAgentProviderFactory {
    constructor(
        private readonly permissionValidationService: PermissionValidationService,
        private readonly observabilityService: ObservabilityService,
        @Optional()
        private readonly documentationSearchService?: DocumentationSearchExaService,
        @Optional()
        private readonly byokErrorCounter?: ByokErrorCounter,
    ) {}

    create(agent: CustomAgentConfig): CustomAgentProvider {
        return new CustomAgentProvider(
            agent,
            this.permissionValidationService,
            this.observabilityService,
            this.documentationSearchService,
            this.byokErrorCounter,
        );
    }
}
