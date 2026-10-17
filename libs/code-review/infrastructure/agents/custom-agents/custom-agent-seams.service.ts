import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';

import type {
    CustomAgentTryFinding,
    CustomAgentTryTrace,
    ICustomAgentKnowledgeReader,
    ICustomAgentToolCatalog,
    ICustomAgentTryRunner,
    KnowledgeCandidate,
    KnowledgeItemResolution,
    ReadOnlyMcpIntegration,
} from '@libs/code-review/domain/custom-agents/contracts';
import { estimateTokens } from '@libs/code-review/infrastructure/adapters/services/utils/token-estimator';
import {
    listReadOnlyMcpTools,
    type CustomAgentMcpServer,
} from '@libs/code-review/infrastructure/agents/adapters/custom-agent-mcp.tools';
import { loadCustomAgentMcpServers } from '@libs/code-review/infrastructure/agents/adapters/custom-agent-tools';
import {
    createBaseBranchReader,
    type BaseBranchReader,
    type KnowledgeCodeManagementPort,
} from '@libs/code-review/infrastructure/agents/knowledge/base-branch-reader';
import {
    KnowledgeResolver,
    locateSkill,
} from '@libs/code-review/infrastructure/agents/knowledge/knowledge-resolver';
import { LOAD_SKILL_TOOL } from '@libs/code-review/infrastructure/agents/knowledge/knowledge-tools';
import { RepositorySkillDetectionService } from '@libs/code-review/infrastructure/agents/knowledge/skill-detection.service';
import { parseSkillMarkdown } from '@libs/code-review/infrastructure/agents/knowledge/skill-validator';
import { CustomAgentProviderFactory } from '@libs/code-review/infrastructure/agents/providers/custom-agent.provider';
import type {
    AgentProgressEvent,
    ReviewAgentOutput,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import { convertToHunksWithLinesNumbers } from '@libs/common/utils/patch';
import { ParametersKey } from '@libs/core/domain/enums';
import type {
    CodeSuggestion,
    CustomAgentConfig,
    KnowledgeItem,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import {
    type IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import { filesInAgentScope } from './custom-agent-scope';

const logger = createLogger('CustomAgentSeams');

/** Docs a repository usually keeps its conventions in, offered for linking. */
const DOC_DISCOVERY_PATTERNS = [
    'CONTRIBUTING.md',
    'ARCHITECTURE.md',
    'CONVENTIONS.md',
    'STYLEGUIDE.md',
    'docs/**/*.md',
];
const MAX_DISCOVERED_DOCS = 30;

const SEVERITY_RANK: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};
const rankOf = (severity?: string) =>
    SEVERITY_RANK[(severity ?? '').toLowerCase()] ?? 4;

function readerFor(
    codeManagement: CodeManagementService,
    organizationAndTeamData: OrganizationAndTeamData,
    repository: { id: string; name: string },
    branch: string,
): BaseBranchReader {
    return createBaseBranchReader({
        sandbox: null,
        baseBranch: branch,
        codeManagement:
            codeManagement as unknown as KnowledgeCodeManagementPort,
        organizationAndTeamData,
        repository: { id: repository.id, name: repository.name },
    });
}

/**
 * Reads skills and docs from a repository's default branch through the
 * provider API, for the settings screen (#2172).
 */
@Injectable()
export class CustomAgentKnowledgeReaderService implements ICustomAgentKnowledgeReader {
    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly skillDetection: RepositorySkillDetectionService,
    ) {}

    async resolve(
        params: Parameters<ICustomAgentKnowledgeReader['resolve']>[0],
    ): Promise<KnowledgeItemResolution[]> {
        const reader = readerFor(
            this.codeManagementService,
            params.organizationAndTeamData,
            params.repository,
            params.repository.branch,
        );
        return Promise.all(
            params.items.map((item) =>
                item.kind === 'skill'
                    ? this.resolveSkill(reader, item.path)
                    : this.resolveDoc(reader, item.path),
            ),
        );
    }

    async discover(
        params: Parameters<ICustomAgentKnowledgeReader['discover']>[0],
    ): Promise<KnowledgeCandidate[]> {
        const { organizationAndTeamData, repository } = params;
        const [skills, docs] = await Promise.all([
            this.skillDetection.detect({
                organizationAndTeamData,
                repository: { id: repository.id, name: repository.name },
                branch: repository.branch,
            }),
            this.discoverDocs(params),
        ]);
        return [
            ...skills.map((skill) => ({
                path: skill.path,
                kind: 'skill' as const,
                name: skill.name,
                description: skill.description,
            })),
            ...docs,
        ];
    }

    private async discoverDocs(
        params: Parameters<ICustomAgentKnowledgeReader['discover']>[0],
    ): Promise<KnowledgeCandidate[]> {
        try {
            const port = this
                .codeManagementService as unknown as KnowledgeCodeManagementPort;
            const files = await port.getRepositoryAllFiles({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: {
                    id: params.repository.id,
                    name: params.repository.name,
                },
                filters: {
                    branch: params.repository.branch,
                    filePatterns: DOC_DISCOVERY_PATTERNS,
                },
            });
            return [...new Set((files ?? []).map((f) => f.path))]
                .filter((path) => /\.md$/i.test(path))
                .sort()
                .slice(0, MAX_DISCOVERED_DOCS)
                .map((path) => ({ path, kind: 'doc' as const }));
        } catch (error) {
            logger.warn({
                message: 'Could not list repository docs',
                context: CustomAgentKnowledgeReaderService.name,
                error,
            });
            return [];
        }
    }

    private async resolveSkill(
        reader: BaseBranchReader,
        path: string,
    ): Promise<KnowledgeItemResolution> {
        const base = { path, kind: 'skill' as const };
        const location = locateSkill(path);
        if (!location) {
            return {
                ...base,
                found: false,
                issues: [{ severity: 'error', message: 'invalid path' }],
            };
        }
        const read = await reader.readFile(location.skillFile);
        if (read.status !== 'ok') {
            return {
                ...base,
                found: false,
                issues:
                    read.status === 'refused'
                        ? [{ severity: 'error', message: read.reason }]
                        : [],
            };
        }
        const parsed = parseSkillMarkdown(read.content, {
            expectedName: location.expectedName,
        });
        if (parsed.ok === false) {
            return {
                ...base,
                found: true,
                issues: parsed.errors.map((message) => ({
                    severity: 'error' as const,
                    message,
                })),
            };
        }
        return {
            ...base,
            found: true,
            name: parsed.skill.name,
            description: parsed.skill.description,
            issues: parsed.notes.map((message) => ({
                severity: 'warning' as const,
                message,
            })),
        };
    }

    private async resolveDoc(
        reader: BaseBranchReader,
        path: string,
    ): Promise<KnowledgeItemResolution> {
        const base = { path, kind: 'doc' as const };
        const paths = /[*?[\]{}]/.test(path)
            ? await reader.matchFiles(path)
            : [path];
        let tokens = 0;
        let found = false;
        const issues: KnowledgeItemResolution['issues'] = [];
        for (const file of paths) {
            const read = await reader.readFile(file);
            if (read.status === 'ok') {
                found = true;
                tokens += estimateTokens(read.content);
            } else if (read.status === 'refused') {
                issues.push({
                    severity: 'warning',
                    message: `${file}: ${read.reason}`,
                });
            }
        }
        return { ...base, found, issues, tokens };
    }
}

/**
 * The read-only tools of the organization's plugin connections, by the same
 * rule a review applies, for the agent's tool picker (#2172).
 */
@Injectable()
export class CustomAgentToolCatalogService implements ICustomAgentToolCatalog {
    constructor(
        @Optional()
        private readonly mcpManagerService?: MCPManagerService,
    ) {}

    async listReadOnlyMcpTools(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<ReadOnlyMcpIntegration[]> {
        if (!this.mcpManagerService) return [];
        const raw = (await this.mcpManagerService.getConnections(
            params.organizationAndTeamData,
            false,
        )) as Array<{ integrationId?: string }>;
        const ids = (raw ?? [])
            .map((connection) => connection.integrationId)
            .filter((id): id is string => !!id);
        if (!ids.length) return [];
        const servers: CustomAgentMcpServer[] = await loadCustomAgentMcpServers(
            this.mcpManagerService,
            params.organizationAndTeamData,
            ids,
        );
        return listReadOnlyMcpTools({ servers });
    }
}

/** PR number from a pull/merge request URL of any supported provider. */
export function pullRequestNumberFromUrl(url: string): number | undefined {
    const match = url.match(
        /\/(?:pull|pulls|merge_requests|pullrequest|pull-requests|pulls?)\/(\d+)(?:[/?#]|$)/i,
    );
    const number = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function urlNamesRepository(url: string, repositoryName: string): boolean {
    const last = repositoryName.split('/').pop()?.toLowerCase();
    if (!last) return false;
    let path: string;
    try {
        path = decodeURIComponent(new URL(url).pathname).toLowerCase();
    } catch {
        return false;
    }
    return path.split('/').includes(last);
}

function baseBranchOf(pr: any): string | undefined {
    const raw =
        pr?.base?.ref ??
        pr?.targetRefName ??
        pr?.target_branch ??
        pr?.destination?.branch?.name ??
        pr?.baseRef;
    return typeof raw === 'string' && raw
        ? raw.replace(/^refs\/heads\//, '')
        : undefined;
}

/** What one Try it run did, from the agent's output and progress events. */
export function buildTryTrace(params: {
    agent: CustomAgentConfig;
    output: ReviewAgentOutput;
    events: AgentProgressEvent[];
    startedAt: number;
    /** Skills the run could open, to name each opened one by its path. */
    skills?: Array<{ name: string; path: string; files?: string[] }>;
}): CustomAgentTryTrace {
    const { agent, output, events } = params;
    const toolCalls = events.flatMap((event) => event.toolCalls ?? []);
    // `completed` carries every call; batches before it repeat some of them.
    const completed = [...events]
        .reverse()
        .find(
            (event) => event.status === 'completed' || event.status === 'error',
        );
    const calls = completed?.toolCalls?.length
        ? completed.toolCalls
        : toolCalls;

    const skillPaths = new Map(
        (params.skills ?? []).map((skill) => [skill.name, skill]),
    );
    const skillsOpened = new Map<string, { path: string; files?: string[] }>();
    for (const call of calls) {
        if (call.tool !== LOAD_SKILL_TOOL) continue;
        try {
            const name = JSON.parse(call.args)?.name;
            if (typeof name !== 'string') continue;
            const skill = skillPaths.get(name);
            skillsOpened.set(name, {
                path: skill?.path ?? name,
                ...(skill?.files?.length ? { files: skill.files } : {}),
            });
        } catch {
            // Arguments are cut at 100 chars for progress; skip unreadable ones.
        }
    }

    const minRank = agent.presentation?.minSeverity
        ? rankOf(agent.presentation.minSeverity)
        : Infinity;
    const kept = output.suggestions ?? [];
    const eligible = kept
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => rankOf(s.severity) <= minRank)
        .sort(
            (a, b) => rankOf(a.s.severity) - rankOf(b.s.severity) || a.i - b.i,
        );
    const max = agent.presentation?.maxComments;
    const posting = new Set(
        (max ? eligible.slice(0, max) : eligible).map(({ s }) => s),
    );

    const finding = (
        s: Partial<CodeSuggestion>,
        verdict: CustomAgentTryFinding['verdict'],
        reason?: string,
    ): CustomAgentTryFinding => ({
        file: s.relevantFile ?? '',
        lineStart: s.relevantLinesStart,
        lineEnd: s.relevantLinesEnd,
        severity: s.severity,
        kind: (s as { kind?: 'bug' | 'convention' }).kind,
        summary: s.oneSentenceSummary ?? '',
        body: s.suggestionContent,
        source: (s as { source?: CustomAgentTryFinding['source'] }).source,
        verdict,
        reason,
        wouldPost: verdict === 'kept' && posting.has(s),
    });

    return {
        status: 'completed',
        models: { run: agent.models?.run, check: agent.models?.check },
        skillsOpened: [...skillsOpened.values()],
        toolCalls: calls.map((call) => ({
            tool: call.tool,
            input: call.args,
            durationMs: call.durationMs,
        })),
        findings: [
            ...kept.map((s) => finding(s, 'kept')),
            ...(output.discardedByVerify ?? []).map((s) =>
                finding(s, 'dropped', 'refuted by the check'),
            ),
            ...(output.discardedBySeverity ?? []).map((s) =>
                finding(s, 'dropped', 'below the severity floor'),
            ),
            ...(output.discardedByVerifyError ?? []).map((s) =>
                finding(s, 'unverified', 'the check could not run'),
            ),
        ],
        durationMs: Date.now() - params.startedAt,
    };
}

/**
 * Runs one custom agent on a pull request for the settings screen's Try it,
 * without posting or storing anything (#2172). The run reads the PR through
 * the provider API: skills, docs and the agent's read-only MCP tools are
 * there; tools that need the review sandbox (repository search, astGrep,
 * runCli) are not.
 */
@Injectable()
export class CustomAgentTryRunnerService implements ICustomAgentTryRunner {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly codeManagementService: CodeManagementService,
        private readonly providerFactory: CustomAgentProviderFactory,
    ) {}

    async runCustomAgentOnPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        prUrl: string;
        agent: CustomAgentConfig;
        knowledge: KnowledgeItem[];
    }): Promise<CustomAgentTryTrace> {
        const startedAt = Date.now();
        const { organizationAndTeamData, agent } = params;

        const parameter = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );
        const configValue = parameter?.configValue;
        const stored = configValue?.repositories?.find(
            (candidate) => candidate?.id === params.repositoryId,
        );
        if (!stored) {
            throw new NotFoundException('Repository not found in this team');
        }
        const repository = { id: String(stored.id), name: stored.name };

        const prNumber = pullRequestNumberFromUrl(params.prUrl);
        if (!prNumber || !urlNamesRepository(params.prUrl, repository.name)) {
            throw new BadRequestException(
                `prUrl must be a pull request of ${repository.name}`,
            );
        }

        const pr = await this.codeManagementService.getPullRequestByNumber({
            organizationAndTeamData,
            repository,
            prNumber,
        });
        if (!pr) {
            return this.failed(startedAt, 'Pull request not found');
        }
        const files =
            ((await this.codeManagementService.getFilesByPullRequestId({
                organizationAndTeamData,
                repository,
                prNumber,
            })) ?? []) as Array<{ filename: string; patch?: string }>;
        const changedFiles = files.map((file) => ({
            ...file,
            patchWithLinesStr: file.patch
                ? convertToHunksWithLinesNumbers(file.patch, file)
                : undefined,
        }));
        const inScope = filesInAgentScope(agent, changedFiles);
        if (!inScope.length) {
            return {
                status: 'skipped',
                reason: 'No changed file matches the agent scope',
                skillsOpened: [],
                toolCalls: [],
                findings: [],
                durationMs: Date.now() - startedAt,
            };
        }

        const baseBranch: string =
            baseBranchOf(pr) ??
            (await this.codeManagementService.getDefaultBranch({
                organizationAndTeamData,
                repository,
            }));
        const reader = readerFor(
            this.codeManagementService,
            organizationAndTeamData,
            repository,
            baseBranch,
        );
        const knowledge = await new KnowledgeResolver(reader).resolve({
            items: params.knowledge,
            target: { agentId: agent.id },
            changedFiles: changedFiles.map((file) => file.filename),
        });

        const events: AgentProgressEvent[] = [];
        try {
            const output = await this.providerFactory.create(agent).execute({
                organizationAndTeamData,
                changedFiles: inScope as any,
                prNumber,
                repositoryId: repository.id,
                repositoryFullName: repository.name,
                prTitle: (pr as { title?: string }).title,
                prBody: (pr as { body?: string }).body,
                baseBranch,
                remoteCommands: undefined,
                languageResultPrompt:
                    (configValue?.configs as { languageResultPrompt?: string })
                        ?.languageResultPrompt ?? 'en-US',
                reviewMode: 'normal',
                knowledge,
                knowledgeReader: reader,
                onAgentProgress: (event) => events.push(event),
            });
            return buildTryTrace({
                agent,
                output,
                events,
                startedAt,
                skills: knowledge.skills,
            });
        } catch (error) {
            logger.warn({
                message: 'Custom agent Try it run failed',
                context: CustomAgentTryRunnerService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    repositoryId: repository.id,
                    prNumber,
                },
            });
            const friendly = [...events]
                .reverse()
                .find(
                    (event) => event.errorFriendlyMessage,
                )?.errorFriendlyMessage;
            return this.failed(
                startedAt,
                friendly ??
                    (error instanceof Error ? error.message : String(error)),
            );
        }
    }

    private failed(startedAt: number, reason: string): CustomAgentTryTrace {
        return {
            status: 'failed',
            reason,
            skillsOpened: [],
            toolCalls: [],
            findings: [],
            durationMs: Date.now() - startedAt,
        };
    }
}
