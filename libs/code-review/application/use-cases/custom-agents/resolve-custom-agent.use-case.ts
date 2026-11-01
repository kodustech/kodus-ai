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
    astGrepRulesPath,
    customAgentConfigSchema,
    KNOWLEDGE_REF_PATTERN,
    KNOWLEDGE_REPOSITORY_PATTERN,
    knowledgeItemKey,
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
                /** Set for a skill or doc of another repository. */
                repository?: string;
                ref?: string;
                /** The branch it was checked on. */
                branch?: string;
            }
        >;
        budgets: KnowledgeTargetBudget[];
        candidates?: Array<KnowledgeCandidate & { kodyRuleSource: boolean }>;
        /** Where `candidates` were listed: the reviewed repository, or the
         *  other repository the request asked for. */
        discoveredIn?: KnowledgeSourceReport;
        /** The repositories linked to the reviewed one, offered first as
         *  places skills and docs can come from. */
        linkedRepositories?: string[];
        /** Every other repository the team's integration reaches, to pick
         *  one that is not linked. Set when the listing was fetched. */
        connectedRepositories?: string[];
        /** The reviewed repository is public: a rule from a private one is
         *  cited without its quote. */
        repositoryVisibility?: 'public' | 'private';
    }>;
    mcp: Section<{ integrations: ReadOnlyMcpIntegration[] }>;
};

/** A repository skills and docs were listed or checked in. */
export type KnowledgeSourceReport = {
    /** Unset for the reviewed repository. */
    repository?: string;
    /** The branch or tag read. */
    branch: string;
    visibility?: 'public' | 'private';
    /** False when the integration cannot reach the repository or ref. */
    available: boolean;
    reason?: string;
};

type RepositoryListing = {
    id: string | number;
    name: string;
    full_name?: string;
    default_branch?: string;
    visibility?: 'public' | 'private';
};

const NOT_BOUND = 'Not available on this server yet.';
const UNREACHABLE = (repository: string) =>
    `${repository} is not a repository this team's integration can read.`;

/**
 * Checks a draft agent and the skills and docs it links against the
 * repository's default branch, before anything is saved (#2172).
 */
const GLOBAL_KNOWLEDGE =
    "Skills and docs are files of each repository: they are read from the pull request's target branch when a review runs there.";

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
        /** List them in this other repository (at `ref`, else its default
         *  branch) instead of the reviewed one. */
        source?: { repository?: string; ref?: string };
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

        const [knowledgeSection, mcpSection, astGrep] = await Promise.all([
            repository
                ? this.resolveKnowledge(
                      organizationAndTeamData,
                      repository,
                      knowledge,
                      params.discover === true,
                      params.source,
                      linkedRepositoriesOf(configValue, params.repositoryId),
                  )
                : Promise.resolve({
                      status: 'unavailable' as const,
                      reason: GLOBAL_KNOWLEDGE,
                  }),
            this.listMcpTools(organizationAndTeamData),
            this.resolveAstGrepRules(
                organizationAndTeamData,
                repository,
                astGrepConfig,
            ),
        ]);

        return {
            repository,
            agentIssues: params.agent ? validateDraftAgent(params.agent) : [],
            astGrep,
            knowledge: knowledgeSection,
            mcp: mcpSection,
        };
    }

    private async resolveKnowledge(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: CustomAgentRepositoryRef,
        knowledge: KnowledgeItem[],
        discover: boolean,
        source: { repository?: string; ref?: string } | undefined,
        linkedRepositories: string[],
    ): Promise<CustomAgentResolveReport['knowledge']> {
        const reader = this.knowledgeReader;
        if (!reader) {
            return { status: 'unavailable', reason: NOT_BOUND };
        }
        try {
            const sourceRepository =
                source?.repository?.trim() &&
                KNOWLEDGE_REPOSITORY_PATTERN.test(source.repository.trim())
                    ? source.repository.trim()
                    : undefined;
            const sourceRef =
                source?.ref?.trim() &&
                KNOWLEDGE_REF_PATTERN.test(source.ref.trim())
                    ? source.ref.trim()
                    : undefined;
            const others = new Set(
                [...knowledge.map((item) => item.repository), sourceRepository]
                    .filter((name): name is string => !!name)
                    .map((name) => name.toLowerCase()),
            );
            // Other repositories are found among the ones the integration
            // reaches, as a review finds them.
            const listing = await this.listRepositories(
                organizationAndTeamData,
                others.size > 0 || discover,
            );
            const listed = (name: string) =>
                listing.find(
                    (repo) =>
                        (repo.full_name || repo.name).toLowerCase() ===
                        name.toLowerCase(),
                );
            const refOf = (
                name: string,
                ref: string | undefined,
            ): CustomAgentRepositoryRef | undefined => {
                const repo = listed(name);
                return repo
                    ? {
                          id: String(repo.id),
                          name: repo.name,
                          branch: ref || repo.default_branch || 'main',
                      }
                    : undefined;
            };

            // Each repository's items are checked on its own branch.
            const groups = new Map<string, KnowledgeItem[]>();
            for (const item of knowledge) {
                const key = (item.repository ?? '').toLowerCase();
                groups.set(key, [...(groups.get(key) ?? []), item]);
            }
            const resolutions = new Map<string, KnowledgeItemResolution>();
            const branches = new Map<string, string>();
            const unreachable = new Set<string>();
            await Promise.all(
                [...groups.values()].map(async (items) => {
                    const other = items[0].repository;
                    const ref = other
                        ? refOf(other, items.find((i) => i.ref)?.ref)
                        : repository;
                    if (!ref) {
                        items.forEach((item) =>
                            unreachable.add(knowledgeItemKey(item)),
                        );
                        return;
                    }
                    const read = await reader.resolve({
                        organizationAndTeamData,
                        repository: ref,
                        items: items.map(({ path, kind }) => ({ path, kind })),
                    });
                    for (const item of items) {
                        const resolution = read.find(
                            (r) => r.path === item.path && r.kind === item.kind,
                        );
                        if (resolution) {
                            resolutions.set(knowledgeItemKey(item), resolution);
                        }
                        branches.set(knowledgeItemKey(item), ref.branch);
                    }
                }),
            );

            let discoveredIn: KnowledgeSourceReport | undefined;
            let candidates: KnowledgeCandidate[] | undefined;
            if (discover) {
                const ref = sourceRepository
                    ? refOf(sourceRepository, sourceRef)
                    : repository;
                const repo = sourceRepository
                    ? listed(sourceRepository)
                    : listing.find((r) => String(r.id) === repository.id);
                discoveredIn = {
                    ...(sourceRepository && { repository: sourceRepository }),
                    branch: ref?.branch ?? sourceRef ?? repository.branch,
                    visibility: repo?.visibility,
                    available: !!ref,
                    ...(!ref && sourceRepository
                        ? { reason: UNREACHABLE(sourceRepository) }
                        : {}),
                };
                candidates = ref
                    ? await reader
                          .discover({
                              organizationAndTeamData,
                              repository: ref,
                          })
                          .catch(() => {
                              discoveredIn = {
                                  ...discoveredIn!,
                                  available: false,
                                  reason: `Could not list the files of ${sourceRepository ?? repository.name} on ${ref.branch}.`,
                              };
                              return [];
                          })
                    : [];
            }

            const reviewed = listing.find(
                (r) => String(r.id) === repository.id,
            );
            return {
                status: 'ok',
                items: knowledge.map((item) => {
                    const key = knowledgeItemKey(item);
                    return {
                        ...(resolutions.get(key) ?? {
                            path: item.path,
                            kind: item.kind,
                            found: false,
                            issues: unreachable.has(key)
                                ? [
                                      {
                                          severity: 'error' as const,
                                          message: UNREACHABLE(
                                              item.repository!,
                                          ),
                                      },
                                  ]
                                : [],
                        }),
                        linkedTo: item.linkedTo,
                        kodyRuleSource:
                            !item.repository && isKodyRuleSource(item.path),
                        ...(item.repository && {
                            repository: item.repository,
                            ...(item.ref && { ref: item.ref }),
                        }),
                        ...(branches.has(key) && { branch: branches.get(key) }),
                    };
                }),
                budgets: knowledgeBudgets(
                    knowledge,
                    knowledge.flatMap((item) => {
                        const resolution = resolutions.get(
                            knowledgeItemKey(item),
                        );
                        return resolution
                            ? [{ ...resolution, repository: item.repository }]
                            : [];
                    }),
                ),
                candidates: candidates?.map((candidate) => ({
                    ...candidate,
                    kodyRuleSource:
                        !sourceRepository && isKodyRuleSource(candidate.path),
                })),
                ...(discoveredIn && { discoveredIn }),
                linkedRepositories,
                ...(listing.length && {
                    connectedRepositories: listing
                        .filter((repo) => String(repo.id) !== repository.id)
                        .map((repo) => repo.full_name || repo.name)
                        .filter(Boolean),
                }),
                ...(reviewed?.visibility && {
                    repositoryVisibility: reviewed.visibility,
                }),
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

    /** The repositories the team's integration reaches; empty when not
     *  needed or when the provider cannot list them. */
    private async listRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
        needed: boolean,
    ): Promise<RepositoryListing[]> {
        if (!needed) return [];
        try {
            return (
                ((await this.codeManagementService.getRepositories({
                    organizationAndTeamData,
                })) as RepositoryListing[]) ?? []
            );
        } catch (error) {
            this.logger.warn({
                message: 'Could not list repositories for skills and docs',
                context: ResolveCustomAgentUseCase.name,
                error,
                metadata: { organizationAndTeamData },
            });
            return [];
        }
    }

    /**
     * Inline rules are counted as written. A rule file path is read from the
     * branch, as a review reads it from the PR's target branch; at the global
     * level there is no branch, so each repository reads its own.
     */
    private async resolveAstGrepRules(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: CustomAgentRepositoryRef | undefined,
        astGrepConfig: string | undefined,
    ): Promise<AstGrepRuleReport> {
        const rulesPath = astGrepRulesPath(astGrepConfig);
        if (!rulesPath) return countAstGrepRules(astGrepConfig);
        const empty = { ruleCount: 0, ruleIds: [], rulesPath };
        if (!repository) return { ...empty, errors: [] };
        if (!this.knowledgeReader?.readFile) {
            return { ...empty, errors: [NOT_BOUND] };
        }
        try {
            const content = await this.knowledgeReader.readFile({
                organizationAndTeamData,
                repository,
                path: rulesPath,
            });
            if (content === null || !content.trim()) {
                return {
                    ...empty,
                    errors: [
                        `Rule file ${rulesPath} was not found on ${repository.branch}.`,
                    ],
                };
            }
            return { ...countAstGrepRules(content), rulesPath };
        } catch (error) {
            this.logger.warn({
                message: 'Could not read the ast-grep rule file',
                context: ResolveCustomAgentUseCase.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repository: repository.id,
                },
            });
            return {
                ...empty,
                errors: [
                    `Could not read ${rulesPath}: ${error instanceof Error ? error.message : String(error)}`,
                ],
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

/**
 * The repositories linked to the reviewed one (repository level, else the
 * team's global level): the first places the screen offers skills and docs
 * from, since a team's rules usually live in one of them.
 */
export function linkedRepositoriesOf(
    configValue: Awaited<ReturnType<typeof loadCodeReviewConfigValue>>,
    repositoryId: string,
): string[] {
    const config = configValue as
        | {
              configs?: {
                  linkedRepositories?: Array<{ repository?: unknown }>;
              };
              repositories?: Array<{
                  id?: string;
                  configs?: {
                      linkedRepositories?: Array<{ repository?: unknown }>;
                  };
              }>;
          }
        | undefined;
    const repository = config?.repositories?.find(
        (candidate) => candidate?.id === repositoryId,
    );
    const linked =
        repository?.configs?.linkedRepositories ??
        config?.configs?.linkedRepositories ??
        [];
    return [
        ...new Set(
            linked
                .map((entry) =>
                    typeof entry?.repository === 'string'
                        ? entry.repository.trim()
                        : '',
                )
                .filter(Boolean),
        ),
    ];
}
