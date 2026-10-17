import { Inject, Injectable, Optional } from '@nestjs/common';

import {
    CUSTOM_AGENT_KNOWLEDGE_READER_TOKEN,
    CUSTOM_AGENT_TOOL_CATALOG_TOKEN,
    type CustomAgentRepositoryRef,
    type ICustomAgentKnowledgeReader,
    type ICustomAgentToolCatalog,
    type KnowledgeCandidate,
    type KnowledgeItemResolution,
    type ReadOnlyMcpIntegration,
} from '@libs/code-review/domain/custom-agents/contracts';
import {
    type AstGrepRuleReport,
    countAstGrepRules,
    isKodyRuleSource,
    knowledgeBudgets,
    type KnowledgeTargetBudget,
} from '@libs/code-review/domain/custom-agents/resolve-report';
import { CLI_SECRET_MASK } from '@libs/code-review/domain/custom-agents/cli-secrets';
import {
    customAgentConfigSchema,
    type KnowledgeItem,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    type IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import {
    loadCodeReviewConfigValue,
    resolveRepositoryRef,
} from './custom-agent-context';

type Section<T> =
    ({ status: 'ok' } & T) | { status: 'unavailable'; reason: string };

export type CustomAgentResolveReport = {
    /** Unset at the global level, which has no repository to read. */
    repository?: CustomAgentRepositoryRef;
    /** Problems with the draft agent itself (schema, limits). */
    agentIssues: string[];
    astGrep: AstGrepRuleReport;
    knowledge: Section<{
        items: Array<
            KnowledgeItemResolution & {
                linkedTo: KnowledgeItem['linkedTo'];
                kodyRuleSource: boolean;
            }
        >;
        budgets: KnowledgeTargetBudget[];
        candidates?: Array<KnowledgeCandidate & { kodyRuleSource: boolean }>;
    }>;
    mcp: Section<{ integrations: ReadOnlyMcpIntegration[] }>;
};

const NOT_BOUND = 'Not available on this server yet.';

/**
 * Checks a draft agent and the skills and docs it links against the
 * repository's default branch, before anything is saved (#2172).
 */
const GLOBAL_KNOWLEDGE =
    'Skills and docs are files of each repository: they are read from the pull request\'s target branch when a review runs there.';

@Injectable()
export class ResolveCustomAgentUseCase {
    private readonly logger = createLogger(ResolveCustomAgentUseCase.name);

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly codeManagementService: CodeManagementService,
        @Optional()
        @Inject(CUSTOM_AGENT_KNOWLEDGE_READER_TOKEN)
        private readonly knowledgeReader?: ICustomAgentKnowledgeReader,
        @Optional()
        @Inject(CUSTOM_AGENT_TOOL_CATALOG_TOKEN)
        private readonly toolCatalog?: ICustomAgentToolCatalog,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        agent?: unknown;
        knowledge?: KnowledgeItem[];
        /** Also list the skills and docs found on the branch. */
        discover?: boolean;
    }): Promise<CustomAgentResolveReport> {
        const { organizationAndTeamData } = params;
        const configValue = await loadCodeReviewConfigValue(
            this.parametersService,
            organizationAndTeamData,
        );
        // The global level has no repository: plugins are the organization's
        // and are listed, while skills and docs are files of each repository,
        // read when a review runs there.
        const repository =
            params.repositoryId === 'global'
                ? undefined
                : await resolveRepositoryRef({
                      configValue,
                      codeManagementService: this.codeManagementService,
                      organizationAndTeamData,
                      repositoryId: params.repositoryId,
                  });

        const knowledge = Array.isArray(params.knowledge)
            ? params.knowledge
            : [];
        const astGrepConfig = (
            params.agent as { tools?: { astGrepConfig?: string } } | undefined
        )?.tools?.astGrepConfig;

        const [knowledgeSection, mcpSection] = await Promise.all([
            repository
                ? this.resolveKnowledge(
                      organizationAndTeamData,
                      repository,
                      knowledge,
                      params.discover === true,
                  )
                : Promise.resolve({
                      status: 'unavailable' as const,
                      reason: GLOBAL_KNOWLEDGE,
                  }),
            this.listMcpTools(organizationAndTeamData),
        ]);

        return {
            repository,
            agentIssues: params.agent ? validateDraftAgent(params.agent) : [],
            astGrep: countAstGrepRules(astGrepConfig),
            knowledge: knowledgeSection,
            mcp: mcpSection,
        };
    }

    private async resolveKnowledge(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: CustomAgentRepositoryRef,
        knowledge: KnowledgeItem[],
        discover: boolean,
    ): Promise<CustomAgentResolveReport['knowledge']> {
        if (!this.knowledgeReader) {
            return { status: 'unavailable', reason: NOT_BOUND };
        }
        try {
            const [resolutions, candidates] = await Promise.all([
                knowledge.length
                    ? this.knowledgeReader.resolve({
                          organizationAndTeamData,
                          repository,
                          items: knowledge.map(({ path, kind }) => ({
                              path,
                              kind,
                          })),
                      })
                    : Promise.resolve([]),
                discover
                    ? this.knowledgeReader.discover({
                          organizationAndTeamData,
                          repository,
                      })
                    : Promise.resolve(undefined),
            ]);
            const byPath = new Map(
                resolutions.map((resolution) => [resolution.path, resolution]),
            );

            return {
                status: 'ok',
                items: knowledge.map((item) => ({
                    ...(byPath.get(item.path) ?? {
                        path: item.path,
                        kind: item.kind,
                        found: false,
                        issues: [],
                    }),
                    linkedTo: item.linkedTo,
                    kodyRuleSource: isKodyRuleSource(item.path),
                })),
                budgets: knowledgeBudgets(knowledge, resolutions),
                candidates: candidates?.map((candidate) => ({
                    ...candidate,
                    kodyRuleSource: isKodyRuleSource(candidate.path),
                })),
            };
        } catch (error) {
            this.logger.warn({
                message: 'Could not read custom agent knowledge',
                context: ResolveCustomAgentUseCase.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repository: repository.id,
                },
            });
            return {
                status: 'unavailable',
                reason: 'Could not read the repository.',
            };
        }
    }

    private async listMcpTools(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CustomAgentResolveReport['mcp']> {
        if (!this.toolCatalog) {
            return { status: 'unavailable', reason: NOT_BOUND };
        }
        try {
            return {
                status: 'ok',
                integrations: await this.toolCatalog.listReadOnlyMcpTools({
                    organizationAndTeamData,
                }),
            };
        } catch (error) {
            this.logger.warn({
                message: 'Could not list read-only MCP tools',
                context: ResolveCustomAgentUseCase.name,
                error,
                metadata: { organizationAndTeamData },
            });
            return {
                status: 'unavailable',
                reason: 'Could not reach the plugins.',
            };
        }
    }
}

/**
 * Schema problems in a draft, as `path: message`. A secret the user typed
 * (`value`) or kept (the mask) has no ciphertext yet, so it stands in for one.
 */
export function validateDraftAgent(agent: unknown): string[] {
    const draft = structuredClone(agent) as {
        tools?: {
            cli?: Array<{
                secrets?: Array<{
                    env: string;
                    ciphertext?: string;
                    value?: string;
                }>;
            }>;
        };
    };
    for (const cli of draft?.tools?.cli ?? []) {
        cli.secrets = cli.secrets?.map((secret) => ({
            env: secret.env,
            ciphertext: secret.value ? CLI_SECRET_MASK : secret.ciphertext,
        }));
    }

    const parsed = customAgentConfigSchema.safeParse(draft);
    if (parsed.success) return [];
    return parsed.error.issues.map((issue) =>
        issue.path.length
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message,
    );
}
