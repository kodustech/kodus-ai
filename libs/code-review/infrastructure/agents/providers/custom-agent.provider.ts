import { Inject, Injectable, Optional } from '@nestjs/common';

import { decrypt } from '@libs/common/utils/crypto';
import { createLogger } from '@libs/core/log/logger';
import type {
    MCPAdapter,
    MCPAdapterConfig,
} from '@libs/mcp-server/mcp-adapter';
import {
    KODUS_ISSUES_INTEGRATION_ID,
    MCPManagerService,
} from '@libs/mcp-server/services/mcp-manager.service';
import {
    buildCustomAgentTools,
    loadCustomAgentMcpServers,
    sandboxDirRemover,
    sandboxFileWriter,
} from '@libs/code-review/infrastructure/agents/adapters/custom-agent-tools';
import { RunToolCache } from '@libs/code-review/infrastructure/agents/adapters/run-tool-cache';
import { buildRunCliAgentTool } from '@libs/code-review/infrastructure/agents/custom-agent-cli/run-cli.tool';
import { makeTargetBranchGuideReader } from '@libs/code-review/infrastructure/agents/core/convention-check';

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
import {
    type AgentRunToolset,
    BaseCodeReviewAgentProvider,
} from '@libs/code-review/infrastructure/agents/providers/base-code-review-agent.provider';
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
    const hasPlugins = (agent.tools?.mcp ?? []).some(
        (selection) => selection?.integrationId && selection.tools?.length,
    );
    // The tools alone say what each system can do, not when it is worth a
    // call: without this the agent consults them only when the PR spells it out.
    const teamSystems = hasPlugins
        ? `

  <TeamSystems>
    Tools named \`System__tool\` read the team's own systems (trackers, wikis, monitoring). They are read-only.
    Consult them when the change or its description points to something recorded there: a ticket, issue or work item, an incident, a design decision. Check the change against what you find, and cite it in the finding.
    A requirement recorded there that the change breaks or leaves out is a finding even when the code never mentions it: the record is the evidence.
    Do not search them speculatively when nothing in the change points there.
  </TeamSystems>`
        : '';
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
  </DoNotReport>${teamSystems}`;
}

const logger = createLogger('CustomAgentProvider');

/**
 * The tenant and repository the Kodus issues plugin needs on every call. Its
 * tools take them as arguments, and the model would only guess them, so the
 * review fills them in. Nothing is bound without a full `owner/name`.
 */
export function kodusPluginArgs(
    org: { organizationId?: string; teamId?: string },
    repositoryFullName?: string,
): Record<string, Record<string, unknown>> | undefined {
    const [owner, ...rest] = (repositoryFullName ?? '').split('/');
    const name = rest.join('/');
    if (!org.organizationId || !org.teamId || !owner || !name) return undefined;
    return {
        [KODUS_ISSUES_INTEGRATION_ID]: {
            organizationId: org.organizationId,
            teamId: org.teamId,
            repository: { owner, name },
        },
    };
}

/** Injection token for a replacement MCP adapter factory (tests, evals). */
export const CUSTOM_AGENT_MCP_ADAPTER_FACTORY = Symbol.for(
    'CustomAgentMcpAdapterFactory',
);

export type McpAdapterFactory = (config: MCPAdapterConfig) => MCPAdapter;

/** What a custom agent reaches beyond its review input. */
export interface CustomAgentToolServices {
    mcpManager?: Pick<MCPManagerService, 'getConnections'>;
    createMcpAdapter?: McpAdapterFactory;
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
    /**
     * Read-only tool results (MCP calls, skill files) of this agent in this
     * review. The provider is built per review and agent, so the cache never
     * crosses either, and the batches of a chunked review share it.
     */
    private readonly runToolCache = new RunToolCache();

    constructor(
        private readonly agent: CustomAgentConfig,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        documentationSearchService?: DocumentationSearchExaService,
        byokErrorCounter?: ByokErrorCounter,
        private readonly toolServices: CustomAgentToolServices = {},
    ) {
        super(
            permissionValidationService,
            observabilityService,
            documentationSearchService,
            byokErrorCounter,
        );
        this.slug = customAgentSlug(agent.name);
    }

    /**
     * Its linked skills and docs. Always set, even when empty, so its
     * findings may carry kind and source and convention findings take the
     * quote check and the convention verifier instead of HV2.
     */
    protected getConventionGuides(input: ReviewAgentInput): string[] {
        return [
            ...(input.knowledge?.skills ?? []).map((skill) => skill.path),
            ...(input.knowledge?.docs ?? []).map((doc) => doc.path),
        ];
    }

    protected getTeamInstructions(): string | undefined {
        return this.agent.instructions || undefined;
    }

    protected getRunToolCache(): RunToolCache {
        return this.runToolCache;
    }

    /**
     * astGrep (with a sandbox checkout), the read-only MCP tools the agent
     * selected, and runCli for the CLIs installed for THIS agent. A tool that
     * cannot be built is left out; the review runs without it.
     */
    protected async buildAgentTools(
        input: ReviewAgentInput,
    ): Promise<AgentRunToolset> {
        const tooling = input.customAgentTooling;
        const sandbox = tooling?.sandbox;
        const reader = input.knowledgeReader;
        const org = input.organizationAndTeamData;
        const mcpManager = this.toolServices.mcpManager;
        const logContext = {
            organizationId: org?.organizationId,
            teamId: org?.teamId,
            repositoryId: input.repositoryId,
            prNumber: input.prNumber,
            agentId: this.agent.id,
        };

        const toolset = await buildCustomAgentTools(this.agent, {
            logContext,
            remoteCommands: input.remoteCommands,
            writeFile:
                sandbox?.writeFile && sandbox.repoDir
                    ? sandboxFileWriter(sandbox)
                    : undefined,
            removeDir:
                sandbox?.run && sandbox.repoDir
                    ? sandboxDirRemover(sandbox)
                    : undefined,
            changedFiles: (input.changedFiles ?? [])
                .map((f) => f.filename)
                .filter(Boolean),
            // The target branch, never the checkout (the PR head): the
            // knowledge reader when the review has one, else the sandbox's
            // fetched base ref, as the convention check reads guides.
            readTargetFile: reader
                ? async (path) => {
                      const read = await reader.readFile(path);
                      return read.status === 'ok' ? read.content : null;
                  }
                : makeTargetBranchGuideReader(
                      input.remoteCommands,
                      input.baseBranch,
                  ),
            mcp:
                mcpManager && org
                    ? {
                          loadServers: (integrationIds) =>
                              loadCustomAgentMcpServers(
                                  mcpManager,
                                  org,
                                  integrationIds,
                              ),
                          createAdapter: this.toolServices.createMcpAdapter,
                          boundArgs: kodusPluginArgs(
                              org,
                              input.repositoryFullName,
                          ),
                          cache: this.runToolCache,
                      }
                    : undefined,
        }).catch((error) => {
            logger.warn({
                message: `Custom agent "${this.agent.name}" tools unavailable; running without them`,
                context: CustomAgentProvider.name,
                error,
                metadata: logContext,
            });
            return {
                tools: [],
                teamSystemTools: [],
                warnings: [],
                close: async () => {},
            };
        });

        const runCli = buildRunCliAgentTool({
            sandbox,
            installed: tooling?.installedClis?.[this.agent.id],
            decrypt,
        });

        return {
            tools: runCli ? [...toolset.tools, runCli] : toolset.tools,
            teamSystemTools: toolset.teamSystemTools,
            warnings: toolset.warnings,
            close: () => toolset.close(),
        };
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
        @Optional()
        private readonly mcpManagerService?: MCPManagerService,
        @Optional()
        @Inject(CUSTOM_AGENT_MCP_ADAPTER_FACTORY)
        private readonly createMcpAdapter?: McpAdapterFactory,
    ) {}

    create(agent: CustomAgentConfig): CustomAgentProvider {
        return new CustomAgentProvider(
            agent,
            this.permissionValidationService,
            this.observabilityService,
            this.documentationSearchService,
            this.byokErrorCounter,
            {
                mcpManager: this.mcpManagerService,
                createMcpAdapter: this.createMcpAdapter,
            },
        );
    }
}
