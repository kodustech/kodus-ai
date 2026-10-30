import { normalizeSuggestionSeverity } from '@libs/code-review/infrastructure/agents/engine/normalize-severity';
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
import { locateSkill } from '@libs/code-review/infrastructure/agents/knowledge/knowledge-resolver';
import type { SkillRead } from '@libs/code-review/infrastructure/agents/knowledge/knowledge-tools';
import { RepositorySkillDetectionService } from '@libs/code-review/infrastructure/agents/knowledge/skill-detection.service';
import { parseSkillMarkdown } from '@libs/code-review/infrastructure/agents/knowledge/skill-validator';
import { resolveReviewKnowledge } from '@libs/code-review/infrastructure/agents/knowledge/review-knowledge';
import { ReviewOrchestratorService } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import {
    contentSimilarity,
    DEDUP_CONTENT_THRESHOLD,
} from '@libs/code-review/infrastructure/agents/engine/dedup-prompt';
import {
    buildSandboxUnavailableWarning,
    dedupReviewWarnings,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    type ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import type { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { buildOrchestratorInput } from '@libs/code-review/pipeline/stages/build-orchestrator-input';
import { CreateSandboxStage } from '@libs/code-review/pipeline/stages/create-sandbox.stage';
import { resolveContextWindow } from '@libs/llm/model-context-window';
import { RUN_CLI_TOOL_NAME } from '@libs/code-review/infrastructure/agents/custom-agent-cli/run-cli.tool';
import type {
    AgentProgressEvent,
    CustomAgentCliRun,
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

import { findingCitation } from './custom-agent-presentation';
import { customAgentSlug, filesInAgentScope } from './custom-agent-scope';

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

    async readFile(
        params: Parameters<
            NonNullable<ICustomAgentKnowledgeReader['readFile']>
        >[0],
    ): Promise<string | null> {
        const read = await readerFor(
            this.codeManagementService,
            params.organizationAndTeamData,
            params.repository,
            params.repository.branch,
        ).readFile(params.path);
        if (read.status === 'refused') throw new Error(read.reason);
        return read.status === 'ok' ? read.content : null;
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
                ...(skill.valid ? {} : { errors: skill.errors ?? [] }),
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
    skills?: Array<{ name: string; path: string }>;
    /** Each skill opened and file read that returned content, in order. */
    skillReads?: SkillRead[];
    /** What each runCli call returned, in the order the calls ran. */
    cliRuns?: CustomAgentCliRun[];
    /** The team's "Minimum severity to post", from the review config: the
     *  floor when the agent sets none ("Team minimum"), as in the review. */
    teamMinSeverity?: string;
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

    const cliOutputs = [...(params.cliRuns ?? [])];
    const skillPaths = new Map(
        (params.skills ?? []).map((skill) => [skill.name, skill]),
    );
    // Each opened skill with the files the run read from it, not the folder:
    // only reads that returned content, as the tools reported them.
    const skillsOpened = new Map<string, { path: string; files: string[] }>();
    for (const read of params.skillReads ?? []) {
        const opened = skillsOpened.get(read.skill) ?? {
            path: skillPaths.get(read.skill)?.path ?? read.skill,
            files: [],
        };
        skillsOpened.set(read.skill, opened);
        if (read.path && !opened.files.includes(read.path)) {
            opened.files.push(read.path);
        }
    }

    // The agent's own floor, else the team's, as the review applies them.
    const floor = agent.presentation?.minSeverity || params.teamMinSeverity;
    const minRank = floor ? rankOf(floor) : Infinity;
    // Severities on the review's scale before anything ranks them: an answer
    // outside it ("major") ranked below low, passed any floor unset and lost
    // the repeat check to a weaker copy.
    const onScale = <T extends Partial<CodeSuggestion>>(s: T): T => ({
        ...s,
        severity: normalizeSuggestionSeverity(s.severity),
    });
    // The review's order: the agent's severity floor and comment limit, then
    // the dedup. Deduping first let a finding under the floor mark a severe
    // one on the same lines as its repeat, so neither read "would post".
    const suggestions = (output.suggestions ?? []).map(onScale);
    const eligible = suggestions
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => rankOf(s.severity) <= minRank)
        .sort(
            (a, b) => rankOf(a.s.severity) - rankOf(b.s.severity) || a.i - b.i,
        );
    const max = agent.presentation?.maxComments;
    const capped = (max ? eligible.slice(0, max) : eligible).map(({ s }) => s);
    const repeats = new Set(withoutRepeats(capped).repeats);
    const kept = suggestions.filter((s) => !repeats.has(s));
    const posting = new Set(capped.filter((s) => !repeats.has(s)));

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
        // The comment as the review appends to it; the review's formatter,
        // which rewrites the body, does not run here.
        ...(verdict === 'kept' && {
            comment: `${s.suggestionContent ?? ''}${findingCitation(s, params.cliRuns)}`,
        }),
    });

    return {
        ...(output.hitHardLimit
            ? { status: 'incomplete' as const, reason: stoppedEarly(output) }
            : { status: 'completed' as const }),
        models: { run: agent.models?.run },
        skillsOpened: [...skillsOpened.values()].map(({ path, files }) => ({
            path,
            ...(files.length ? { files } : {}),
        })),
        toolCalls: calls.map((call) => {
            // runCli calls read back in the order they ran.
            const run =
                call.tool === RUN_CLI_TOOL_NAME
                    ? cliOutputs.shift()
                    : undefined;
            return {
                tool: call.tool,
                input: call.args,
                durationMs: call.durationMs,
                ...(run && { outputPreview: run.output }),
            };
        }),
        findings: [
            ...kept.map((s) => finding(s, 'kept')),
            ...[...repeats].map((s) =>
                finding(s, 'dropped', 'repeats a finding on the same lines'),
            ),
            ...(output.discardedByVerify ?? [])
                .map(onScale)
                .map((s) =>
                    finding(
                        s,
                        'dropped',
                        s.discardReason ?? 'refuted by the check',
                    ),
                ),
            ...(output.discardedBySeverity ?? [])
                .map(onScale)
                .map((s) => finding(s, 'dropped', 'below the severity floor')),
            ...(output.discardedByVerifyError ?? [])
                .map(onScale)
                .map((s) =>
                    finding(s, 'unverified', 'the check could not run'),
                ),
        ],
        durationMs: Date.now() - params.startedAt,
    };
}

/** Why a run stopped before it finished, as Try it says it. */
function stoppedEarly(output: ReviewAgentOutput): string {
    switch (output.finishReason) {
        case 'no-result':
            return 'The agent stopped without submitting a result, so no findings does not mean the code is clean';
        case 'truncated':
            return "The model provider cut the agent's turn before it finished";
        default:
            return 'The agent ran out of steps before it finished';
    }
}

/**
 * A review dedups the agent's findings before posting; Try it skips that
 * stage, so two findings about the same lines both read "would post". The
 * same lines and enough shared words (the review's lexical tier) mark the
 * later one as a repeat. Its semantic tiers are not run here.
 */
function withoutRepeats(suggestions: Partial<CodeSuggestion>[]): {
    kept: Partial<CodeSuggestion>[];
    repeats: Partial<CodeSuggestion>[];
} {
    const kept: Partial<CodeSuggestion>[] = [];
    const repeats: Partial<CodeSuggestion>[] = [];
    const range = (s: Partial<CodeSuggestion>) => {
        const start = Number(s.relevantLinesStart);
        const end = Number(s.relevantLinesEnd ?? s.relevantLinesStart);
        return [start, Number.isFinite(end) ? end : start];
    };
    // Only findings on the same file can repeat each other.
    const keptByFile = new Map<string | undefined, Partial<CodeSuggestion>[]>();
    for (const s of suggestions) {
        const [start, end] = range(s);
        const sameFile = keptByFile.get(s.relevantFile) ?? [];
        const repeat = sameFile.some((k) => {
            const [kStart, kEnd] = range(k);
            return (
                Number.isFinite(start) &&
                Number.isFinite(kStart) &&
                start <= kEnd &&
                kStart <= end &&
                contentSimilarity(k, s) >= DEDUP_CONTENT_THRESHOLD
            );
        });
        if (repeat) {
            repeats.push(s);
        } else {
            kept.push(s);
            keptByFile.set(s.relevantFile, [...sameFile, s]);
        }
    }
    return { kept, repeats };
}

/** The PR's source branch, from the provider's own pull request shape. */
function headBranchOf(pr: any): string | undefined {
    const raw =
        pr?.head?.ref ??
        pr?.sourceRefName ??
        pr?.source_branch ??
        pr?.source?.branch?.name ??
        pr?.headRef;
    return typeof raw === 'string' && raw
        ? raw.replace(/^refs\/heads\//, '')
        : undefined;
}

/**
 * Runs one custom agent on a pull request for the settings screen's Try it,
 * without posting or storing anything (#2172). It takes the review's own
 * path: the repository's review config, the review sandbox (E2B when
 * configured) with this agent's CLIs installed, skills and docs read from the
 * target branch, and the review orchestrator, which runs the agent through
 * the harness (finder, quote check, convention verifier, HV2) on the model a
 * review would use. Only the posting is left out.
 */
@Injectable()
export class CustomAgentTryRunnerService implements ICustomAgentTryRunner {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly codeManagementService: CodeManagementService,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        private readonly createSandboxStage: CreateSandboxStage,
        private readonly reviewOrchestrator: ReviewOrchestratorService,
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
        const earlyLog = (reason: string) =>
            logger.log({
                message: `Custom agent Try it not run: ${reason}`,
                context: CustomAgentTryRunnerService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    repositoryId: repository.id,
                    repositoryName: repository.name,
                    prNumber,
                    agentId: agent.id,
                    reason,
                },
            });
        if (!pr) {
            earlyLog('pull request not found');
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
        if (!filesInAgentScope(agent, changedFiles).length) {
            earlyLog('no changed file in the agent scope');
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
        const platformType =
            await this.codeManagementService.getTypeIntegration(
                organizationAndTeamData,
            );
        const reviewRepository = {
            ...repository,
            fullName:
                (stored as { fullName?: string }).fullName ||
                (pr as any)?.base?.repo?.full_name ||
                repository.name,
            defaultBranch:
                (stored as { defaultBranch?: string }).defaultBranch ||
                baseBranch,
        };

        // The repository's review config, as ResolveConfigStage reads it,
        // with this agent (saved or not) and its knowledge in place.
        const config = await this.codeBaseConfigService.getConfig(
            organizationAndTeamData,
            reviewRepository,
            changedFiles as any,
        );
        const slug = customAgentSlug(agent.name);
        let context = {
            organizationAndTeamData,
            platformType,
            repository: reviewRepository,
            branch: headBranchOf(pr),
            pullRequest: {
                number: prNumber,
                title: (pr as { title?: string }).title,
                body: (pr as { body?: string }).body,
                base: { ref: baseBranch },
            },
            changedFiles,
            codeReviewConfig: {
                ...config,
                customAgents: [agent],
                knowledge: params.knowledge,
            },
            // `@kody -v <slug>`: this agent alone, enabled or not.
            onlyCustomAgent: slug,
        } as unknown as CodeReviewPipelineContext;

        // The review's sandbox and CLI install. On failure the stage leaves
        // no sandbox and the run reads only the diff, as a review would.
        context = await this.createSandboxStage.execute(context);
        const sandbox = context.sandboxHandle;

        const tryLogContext = {
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
            repositoryId: repository.id,
            repositoryName: repository.name,
            prNumber,
            agentId: agent.id,
            agentSlug: slug,
        };
        const events: AgentProgressEvent[] = [];
        const cliRuns: CustomAgentCliRun[] = [];
        const skillReads: SkillRead[] = [];
        const warnings: ReviewWarning[] = [
            ...(context.customAgentClis?.warnings ?? []),
        ];
        try {
            const hasCheckout =
                !!sandbox?.remoteCommands && sandbox.type !== 'null';
            if (!hasCheckout && !context.sandboxSuperseded) {
                warnings.push(
                    buildSandboxUnavailableWarning({
                        modelName: agent.models?.run || 'unknown',
                    }),
                );
            }

            const knowledge = await resolveReviewKnowledge({
                items: params.knowledge,
                customAgents: [agent],
                changedFiles,
                baseBranch,
                sandbox,
                codeManagement: this
                    .codeManagementService as unknown as KnowledgeCodeManagementPort,
                organizationAndTeamData,
                repository,
                logContext: CustomAgentTryRunnerService.name,
                prNumber,
            });
            warnings.push(...knowledge.warnings);

            // No resolved slot here (ValidateConfigStage does not run), so the
            // profile is sized by the override name, as the stage falls back.
            const adaptiveProfile = resolveAdaptiveProfile(
                resolveContextWindow({
                    modelName: config?.byokModelId?.trim()
                        ? ''
                        : config?.byokModel?.trim() || '',
                }),
            );
            const result = await this.reviewOrchestrator.execute({
                ...buildOrchestratorInput(context, {
                    changedFiles: changedFiles as any,
                    prNumber,
                    repositoryId: repository.id,
                    reviewOptions: config?.reviewOptions || {
                        bug: true,
                        security: true,
                        performance: true,
                    },
                    onAgentProgress: (event) => events.push(event),
                    gitHubToken: undefined,
                    callGraph: '',
                    adaptiveProfile,
                }),
                customAgents: [agent],
                onlyCustomAgent: slug,
                knowledgeByTarget: knowledge.byTarget,
                knowledgeReader: knowledge.reader,
                customAgentTooling: {
                    sandbox,
                    installedClis: context.customAgentClis?.byAgentId,
                    onCliRun: (run) => cliRuns.push(run),
                    onSkillRead: (read) => skillReads.push(read),
                },
            });
            const runWarnings = toTryWarnings([
                ...warnings,
                ...(result.warnings ?? []),
            ]);

            const failure = result.failures.find(
                (f) => f.customAgent?.id === agent.id,
            );
            const output = result.agentResults[0];
            if (failure || !output) {
                const friendly = [...events]
                    .reverse()
                    .find(
                        (event) => event.errorFriendlyMessage,
                    )?.errorFriendlyMessage;
                logger.warn({
                    message: 'Custom agent Try it run did not complete',
                    context: CustomAgentTryRunnerService.name,
                    error: failure?.error,
                    metadata: {
                        ...tryLogContext,
                        reason: failure
                            ? 'agent failed'
                            : (result.customAgentRuns?.[0]?.status ??
                              'no agent result'),
                    },
                });
                return {
                    ...this.failed(
                        startedAt,
                        friendly ??
                            failure?.error.message ??
                            'The agent did not run',
                    ),
                    warnings: runWarnings,
                };
            }
            return {
                ...buildTryTrace({
                    agent,
                    output,
                    events,
                    cliRuns,
                    skillReads,
                    startedAt,
                    skills: knowledge.byTarget?.get(agent.id)?.skills,
                    teamMinSeverity:
                        config?.suggestionControl?.severityLevelFilter,
                }),
                warnings: runWarnings,
            };
        } catch (error) {
            logger.warn({
                message: 'Custom agent Try it run failed',
                context: CustomAgentTryRunnerService.name,
                error,
                metadata: tryLogContext,
            });
            return {
                ...this.failed(
                    startedAt,
                    error instanceof Error ? error.message : String(error),
                ),
                warnings: toTryWarnings(warnings),
            };
        } finally {
            // Releases the lease, as the pipeline observer does after a review.
            await sandbox?.cleanup?.().catch((error) =>
                logger.warn({
                    message: 'Could not release the Try it sandbox',
                    context: CustomAgentTryRunnerService.name,
                    error,
                    metadata: tryLogContext,
                }),
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

/** Review warnings as the Try it result shows them. */
function toTryWarnings(
    warnings: ReviewWarning[],
): NonNullable<CustomAgentTryTrace['warnings']> {
    return dedupReviewWarnings(warnings).map((w) => ({
        kind: w.kind,
        ...(w.detail ? { detail: w.detail } : {}),
    }));
}
