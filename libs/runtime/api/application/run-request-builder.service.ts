import { TRACEPARENT } from '@libs/runtime/contracts/trace-context';
import { traceparentFor } from '@libs/runtime/telemetry/runtime-telemetry';
import { randomUUID } from 'crypto';

import { ConflictException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';

import { RepositoryFullNameSchema } from '@libs/runtime/contracts/workspace';
import { type KeptCheck, KeptCheckSchema, MAX_KEPT_CHECKS_PER_REPOSITORY } from '@libs/runtime/contracts/kept-check';
import { createLogger } from '@libs/core/log/logger';
import type { RunTargetWorkspaceRef } from '@libs/runtime-publish/domain/run-target';
import { DIFF_TRUNCATED_MARKER_PATH, RuntimeRunRequestedSchema, type RuntimeRunRequested } from '@libs/runtime/run';
import type { RunWorkspaceRepository } from '@libs/runtime/run/run-messages';
import type { ForkApprovalTokens } from '@libs/runtime/contracts/runtime-commands';
import type { PartlyTestedCheck } from '@libs/runtime/contracts/enums';

import { forkMayRunUnheld, forkRunMaxTokens } from '../domain/fork-policy';
import { RUN_TOKEN_DEFAULT_TTL_SECONDS, signRunToken } from '../domain/run-token';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_KEPT_CHECK_STORE,
    RUNTIME_LINKED_TASKS,
    RUNTIME_REPO_TOKEN_ISSUER,
    RUNTIME_SETTINGS_STORE,
    type Clock,
    type EnvironmentRepository,
    type KeptCheckStore,
    type LinkedTask,
    type ProductEnvironment,
    type PullRequestDiff,
    type PullRequestHead,
    type RuntimeApiConfig,
    type RuntimeEnvironmentReader,
    type RuntimeGitPort,
    type RuntimeLinkedTasksReader,
    type RuntimeRepoTokenIssuer,
    type RuntimeSettingsStore,
} from '../domain/ports';
import { RuntimeEnvironmentMembers } from './environment-members.service';
import { sealForRuntime } from './secret-sealer';

/** A branch name the request may carry (what the report says a repository ran from), or nothing. */
const branchOf = (branch: string | undefined) => (branch && branch.length <= 256 ? { branch } : {});

/** The repository a Run is on: the pull request's. */
export interface RunRepository {
    repositoryId: string;
    repositoryName: string;
    fullName?: string;
}

/** The diff a Run carries: the Git API's files, plus the marker entry when the product had to cut it. */
export function diffForRun(diff: PullRequestDiff): Pick<RuntimeRunRequested, 'diff' | 'diffTruncated' | 'prChangedRecipeFiles'> {
    const recipe = diff.recipeFiles?.length ? { prChangedRecipeFiles: diff.recipeFiles } : {};
    if (!diff.truncated) return { diff: diff.files, ...recipe };
    return { diff: [...diff.files, { path: DIFF_TRUNCATED_MARKER_PATH, patch: '' }], diffTruncated: true, ...recipe };
}

/**
 * Builds the RuntimeRunRequested of a Run on one PR head: the diff and the
 * repo token from the Git API (ADR-057), the Run token signed here, both
 * sealed for this Run, and the environment the setup recorded. The PR
 * trigger, "Run again" and "Try it" share it.
 */
/** How long the linked tasks may take to read before the Run goes without them. */
const LINKED_TASKS_BUDGET_MS = 15_000;

@Injectable()
export class RuntimeRunRequestBuilder {
    private readonly logger = createLogger(RuntimeRunRequestBuilder.name);

    constructor(
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
        @Inject(RUNTIME_REPO_TOKEN_ISSUER)
        private readonly repoTokens: RuntimeRepoTokenIssuer,
        @Inject(RUNTIME_ENVIRONMENT_READER)
        private readonly environmentReader: RuntimeEnvironmentReader,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        // Required by Nest; a builder made without it (the older tests) builds single-repository Runs only.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
        // Required by Nest; a builder made without it (the older tests) sends no threshold, so the worker's applies.
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings?: Pick<RuntimeSettingsStore, 'getOrganization'>,
        // Required by Nest; a builder made without it (the older tests) sends no kept checks.
        @Inject(RUNTIME_KEPT_CHECK_STORE)
        private readonly keptChecks?: Pick<KeptCheckStore, 'listActive'>,
        // Optional: a builder made without it sends no linked tasks.
        @Optional()
        @Inject(RUNTIME_LINKED_TASKS)
        private readonly linkedTasks?: RuntimeLinkedTasksReader,
    ) {}

    /** The tasks the PR links, within a budget: a slow or failing tracker never holds up the Run, it only leaves them out. */
    private async linkedTasksOf(input: { organizationId: string; teamId: string; repositoryName: string; head: PullRequestHead }): Promise<{ linkedTasks?: LinkedTask[] }> {
        if (!this.linkedTasks) return {};
        const { head } = input;
        let timer: NodeJS.Timeout | undefined;
        try {
            const tasks = await Promise.race([
                this.linkedTasks.read({
                    organizationId: input.organizationId,
                    teamId: input.teamId,
                    repositoryName: input.repositoryName,
                    ...(head.title ? { title: head.title } : {}),
                    ...(head.headBranch ? { headBranch: head.headBranch } : {}),
                    ...(head.description ? { description: head.description } : {}),
                }),
                new Promise<LinkedTask[]>((resolve) => {
                    timer = setTimeout(() => resolve([]), LINKED_TASKS_BUDGET_MS);
                }),
            ]);
            return tasks.length ? { linkedTasks: tasks.slice(0, 3) } : {};
        } catch (error) {
            this.logger.warn({ message: 'Runtime: the linked tasks could not be read; the Run goes without them', error, metadata: { organizationId: input.organizationId } });
            return {};
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async build(input: {
        /** The environment (its primary repository is `repositoryId`). */
        env: Pick<ProductEnvironment, 'environmentId' | 'organizationId' | 'teamId' | 'repositoryId' | 'repositoryName'>;
        /** The PR's repository when it is a member of the environment, not its primary. */
        repository?: RunRepository;
        /** The commits a previous Run of this PR pinned (Run again): reused for every repository still in the environment. */
        workspace?: RunTargetWorkspaceRef[];
        prNumber: number;
        head: PullRequestHead;
        trigger: RuntimeRunRequested['trigger'];
        /** The diff of this head when the caller already read it. */
        diff?: PullRequestDiff;
        /** A derived id makes a repeated request the same Run (deterministicUuid); random otherwise. */
        runId?: string;
        attempt?: number;
        /** The repository's full name when the product stores it apart from the name. */
        repositoryFullName?: string;
        /** A fork Run the environment's policy runs without a maintainer (ADR-030); ignored for a non-fork, and for an environment of several repositories. */
        forkApprovalRequired?: boolean;
        /** Exact product-admitted probes, not supplied by the planner. */
        externalVerification?: RuntimeRunRequested['externalVerification'];
        /** The trace the request came in (the webhook's); absent: a new trace named by the Run's correlation id. */
        traceparent?: string;
    }): Promise<RuntimeRunRequested> {
        this.ensureTokenConfig();
        const { env, prNumber, head } = input;
        const runId = input.runId ?? randomUUID();
        const attempt = input.attempt ?? 1;
        const orgTeam = { organizationId: env.organizationId, teamId: env.teamId };
        const own = input.repository ?? { repositoryId: env.repositoryId, repositoryName: env.repositoryName };
        const repo = { repositoryId: own.repositoryId, repositoryName: own.repositoryName };

        const environment = await this.environmentReader.get(env.organizationId, env.environmentId);
        // The gate pins the image the setup baked; without one there is nothing to pin, so no Run.
        if (!environment?.imageId) {
            throw new ConflictException('The environment has no image yet; run its setup first');
        }
        const members = await this.membersOf(env, own.repositoryId);
        const diff = input.diff ?? (await this.git.getPullRequestDiff({ ...orgTeam, ...repo, prNumber, headSha: head.headSha }));
        const now = this.now();
        const maxTokens = this.maxTokensFor(head.fork);
        // Every commit is pinned before any token is minted: a repository Kodus cannot read stops the Run with nothing issued.
        const pins = members.length > 1 ? await this.pinWorkspace({ ...orgTeam, members, own: own.repositoryId, head, pinned: input.workspace }) : undefined;
        const tokens = await this.mintTokens({ ...orgTeam, ...repo, runId, attempt, prNumber, fork: head.fork });
        const linked = await this.linkedTasksOf({ ...orgTeam, repositoryName: repo.repositoryName, head });
        const workspace = pins ? await this.sealWorkspace({ ...orgTeam, pins, runId }) : undefined;
        const ownMember = members.find((m) => m.repositoryId === own.repositoryId);
        const fullName =
            input.repositoryFullName ??
            own.fullName ??
            (ownMember?.fullName.includes('/') ? ownMember.fullName : undefined) ??
            (own.repositoryName.includes('/') ? own.repositoryName : undefined);
        const correlationId = randomUUID();
        const { exercisedThreshold, partlyTestedCheck } = await this.orgJudgementOf(env.organizationId);
        // An external finding's plan is closed: it plays only the probes the product admitted.
        const kept = input.trigger === 'external_finding' ? [] : await this.keptChecksOf(env.organizationId, env.environmentId, own.repositoryId);
        return RuntimeRunRequestedSchema.parse({
            runId,
            attempt,
            correlationId,
            // One trace from the webhook (or this API call) to the cell (docs/runtime/observability.md, "Trace path").
            traceparent: input.traceparent && TRACEPARENT.test(input.traceparent) ? input.traceparent : traceparentFor(correlationId),
            requestedAt: now.toISOString(),
            organizationId: env.organizationId,
            teamId: env.teamId,
            repository: { id: own.repositoryId, name: own.repositoryName, ...(fullName ? { fullName } : {}) },
            pullRequest: {
                number: prNumber,
                headSha: head.headSha,
                baseSha: head.baseSha,
                ...(head.baseBranch === undefined ? {} : { baseBranch: head.baseBranch }),
                fork: head.fork,
                // Every path that starts a Run comes here: in an environment of several repositories a fork always waits for a maintainer.
                ...(head.fork && input.forkApprovalRequired === false && forkMayRunUnheld(Math.max(1, members.length)) ? { forkApprovalRequired: false } : {}),
                ...(head.authorId ? { authorId: head.authorId } : {}),
                // Untrusted: the intent classifier reads it as data, and the Run keeps one clean line of it for display.
                ...(head.title ? { title: head.title } : {}),
                // Untrusted: the intent author reads it as data, to write the checks of what the PR says it does.
                ...(head.description ? { description: head.description } : {}),
                ...linked,
            },
            environment: {
                environmentId: env.environmentId,
                imageId: environment.imageId,
                expose: environment.expose ?? [],
            },
            ...diffForRun(diff),
            ...tokens,
            budget: { maxTokens },
            // The org's setting as it is now: the Run is judged by it even if the org changes it later.
            ...(exercisedThreshold !== undefined ? { exercisedLinesThresholdPercent: exercisedThreshold } : {}),
            // Only the org's neutral fallback travels: absent, the Run's partly tested check needs action (the default).
            ...(partlyTestedCheck === 'neutral' ? { partlyTestedCheck } : {}),
            trigger: input.trigger,
            ...(input.externalVerification ? { externalVerification: input.externalVerification } : {}),
            // Only an environment of several repositories carries it: a single-repository request stays as it was.
            ...(workspace ? { workspace } : {}),
            // The repository's kept checks as they are now (docs/runtime/kept-checks.md §5): a snapshot of this Run.
            ...(kept.length ? { keptChecks: kept } : {}),
        });
    }

    /**
     * The active kept checks of the PR's repository in this environment, as a Run
     * receives them. A failed read fails the request. A stored check that no longer
     * parses is left out and logged: it cannot be played (docs/runtime/kept-checks.md §12, gap).
     */
    private async keptChecksOf(organizationId: string, environmentId: string, repositoryId: string): Promise<KeptCheck[]> {
        if (!this.keptChecks) return [];
        const records = await this.keptChecks.listActive(organizationId, { environmentId, repositoryId }, MAX_KEPT_CHECKS_PER_REPOSITORY);
        const out: KeptCheck[] = [];
        for (const r of records) {
            const parsed = KeptCheckSchema.safeParse({
                keptCheckId: r.keptCheckId,
                entryPoint: r.entryPoint,
                probe: r.probe,
                ...(r.assertions ? { assertions: r.assertions } : {}),
                differingFields: r.differingFields,
                sourcePrNumber: r.sourcePrNumber,
            });
            if (parsed.success) out.push(parsed.data);
            else this.logger.warn({ message: 'Runtime kept check unreadable', context: RuntimeRunRequestBuilder.name, metadata: { organizationId, environmentId, keptCheckId: r.keptCheckId } });
        }
        return out;
    }

    /**
     * The org's exercised-lines threshold, or undefined when it set none (the worker's
     * RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT applies), and its choice for a partly
     * tested check, or undefined (the default, action_required). One read; a failed
     * read fails the request, never judges the Run by another value.
     */
    private async orgJudgementOf(organizationId: string): Promise<{ exercisedThreshold?: number; partlyTestedCheck?: PartlyTestedCheck }> {
        const org = await this.settings?.getOrganization(organizationId);
        const percent = org?.exercisedLinesThresholdPercent;
        return {
            ...(typeof percent === 'number' ? { exercisedThreshold: percent } : {}),
            ...(org?.partlyTestedCheck ? { partlyTestedCheck: org.partlyTestedCheck } : {}),
        };
    }

    /** The environment's repositories; the PR's own must be one of them. */
    private async membersOf(env: Pick<ProductEnvironment, 'environmentId' | 'organizationId' | 'repositoryId' | 'repositoryName'>, own: string) {
        const members = this.members ? await this.members.list(env) : [];
        const known = members.length ? members.some((m) => m.repositoryId === own) : own === env.repositoryId;
        if (!known) throw new ConflictException('The repository of this pull request is not part of the environment');
        return members;
    }

    /**
     * The commits every repository of the Run boots on each side, pinned once
     * (docs/runtime/multi-repo.md): the PR's
     * repository at the PR; with pair_branches, a repository's open PR of the
     * same branch name; any other at its default-branch head on both sides.
     * A previous Run's pins (Run again) are kept for the repositories still here.
     */
    private async pinWorkspace(input: {
        organizationId: string;
        teamId: string;
        members: EnvironmentRepository[];
        own: string;
        head: PullRequestHead;
        pinned?: RunTargetWorkspaceRef[];
    }): Promise<Array<{ member: EnvironmentRepository; ref: Omit<RunWorkspaceRepository, 'repositoryId' | 'fullName' | 'alias' | 'role' | 'sealedRepoToken' | 'sealedPrRepoToken'> }>> {
        const orgTeam = { organizationId: input.organizationId, teamId: input.teamId };
        const out = [];
        for (const member of input.members) {
            if (!RepositoryFullNameSchema.safeParse(member.fullName).success) {
                throw new ConflictException(`Kodus does not know the full name (owner/name) of ${member.repositoryName}; add it to the environment again`);
            }
            if (member.repositoryId === input.own) {
                out.push({ member, ref: { baseSha: input.head.baseSha, headSha: input.head.headSha, source: 'pull_request' as const, ...branchOf(input.head.headBranch) } });
                continue;
            }
            const stored = input.pinned?.find((r) => r.repositoryId === member.repositoryId && r.source !== 'pull_request');
            if (stored) {
                out.push({
                    member,
                    ref: {
                        baseSha: stored.baseSha,
                        headSha: stored.headSha,
                        source: stored.source,
                        ...(stored.source === 'paired' && stored.pairedPrNumber !== undefined ? { pairedPrNumber: stored.pairedPrNumber } : {}),
                        ...branchOf(stored.branch),
                    },
                });
                continue;
            }
            const repo = { ...orgTeam, repositoryId: member.repositoryId, repositoryName: member.repositoryName };
            if (member.pairBranches && input.head.headBranch && this.git.findOpenPullRequestByBranch) {
                const paired = await this.git.findOpenPullRequestByBranch({ ...repo, branch: input.head.headBranch }).catch(() => {
                    throw new ServiceUnavailableException(`Kodus could not read the pull requests of ${member.fullName}; try again`);
                });
                if (paired) {
                    out.push({ member, ref: { baseSha: paired.baseSha, headSha: paired.headSha, source: 'paired' as const, pairedPrNumber: paired.number, branch: input.head.headBranch } });
                    continue;
                }
            }
            const branchHead = await this.git.getDefaultBranchHead(repo).catch(() => {
                throw new ServiceUnavailableException(`Kodus could not read the default branch of ${member.fullName}; try again`);
            });
            if (branchHead.status !== 'ok') {
                throw new ConflictException(`Kodus cannot read the default branch of ${member.fullName}, which this environment boots beside the pull request`);
            }
            out.push({ member, ref: { baseSha: branchHead.sha, headSha: branchHead.sha, source: 'default_branch' as const, ...branchOf(branchHead.branch) } });
        }
        return out;
    }

    /** One download token per side for every repository but the PR's (which uses the request's own two), each for that repository only, sealed for this Run. */
    private async sealWorkspace(input: {
        organizationId: string;
        teamId: string;
        runId: string;
        pins: Awaited<ReturnType<RuntimeRunRequestBuilder['pinWorkspace']>>;
    }): Promise<RunWorkspaceRepository[]> {
        return Promise.all(
            input.pins.map(async ({ member, ref }) => {
                const entry = { repositoryId: member.repositoryId, fullName: member.fullName, alias: member.alias, role: member.role, ...ref };
                if (ref.source === 'pull_request') return entry;
                const repo = { organizationId: input.organizationId, teamId: input.teamId, repositoryId: member.repositoryId, repositoryName: member.repositoryName };
                const [base, pr] = await Promise.all([this.repoTokens.issue(repo), this.repoTokens.issue(repo)]);
                return {
                    ...entry,
                    sealedRepoToken: sealForRuntime(this.config, base, input.runId),
                    sealedPrRepoToken: sealForRuntime(this.config, pr, input.runId),
                };
            }),
        );
    }

    /**
     * Fresh tokens, one per side, for every repository of a multi-repository
     * Run but the PR's own, sealed for its runId: a fork approval sends them
     * with the PR's (mintTokens), since the ones the Run was requested with
     * expired while it waited. A repository that is no longer in the
     * environment gets none: its claim is then refused, naming it.
     */
    async mintMemberTokens(input: {
        env: Pick<ProductEnvironment, 'environmentId' | 'organizationId' | 'teamId' | 'repositoryId' | 'repositoryName'>;
        runId: string;
        refs: readonly RunTargetWorkspaceRef[];
    }): Promise<ForkApprovalTokens['workspace']> {
        this.ensureTokenConfig();
        const others = input.refs.filter((r) => r.source !== 'pull_request');
        if (!others.length || !this.members) return undefined;
        const members = await this.members.list(input.env);
        const out = await Promise.all(
            others.map(async (ref) => {
                const member = members.find((m) => m.repositoryId === ref.repositoryId);
                if (!member) return undefined;
                const repo = { organizationId: input.env.organizationId, teamId: input.env.teamId, repositoryId: member.repositoryId, repositoryName: member.repositoryName };
                const [base, pr] = await Promise.all([this.repoTokens.issue(repo), this.repoTokens.issue(repo)]);
                return { repositoryId: member.repositoryId, sealedRepoToken: sealForRuntime(this.config, base, input.runId), sealedPrRepoToken: sealForRuntime(this.config, pr, input.runId) };
            }),
        );
        const minted = out.filter((t) => t !== undefined);
        return minted.length ? minted : undefined;
    }

    /**
     * A fresh repo token and Run token for a Run, sealed for its runId. A fork
     * approval mints them again: the ones the Run was requested with expire
     * (the repo token in 1 h) while it waits for a maintainer.
     */
    async mintTokens(input: {
        organizationId: string;
        teamId: string;
        repositoryId: string;
        repositoryName: string;
        runId: string;
        attempt: number;
        prNumber: number;
        fork: boolean;
    }): Promise<Pick<RuntimeRunRequested, 'repoToken' | 'prRepoToken' | 'runToken'>> {
        this.ensureTokenConfig();
        const repo = { organizationId: input.organizationId, teamId: input.teamId, repositoryId: input.repositoryId, repositoryName: input.repositoryName };
        // One per side: each claim revokes the token it fetched with.
        const [repoToken, prRepoToken] = await Promise.all([this.repoTokens.issue(repo), this.repoTokens.issue(repo)]);
        const runToken = signRunToken(
            {
                runId: input.runId,
                attempt: input.attempt,
                organizationId: input.organizationId,
                teamId: input.teamId,
                repositoryId: input.repositoryId,
                prNumber: input.prNumber,
                maxTokens: this.maxTokensFor(input.fork),
                exp: Math.floor(this.now().getTime() / 1000) + RUN_TOKEN_DEFAULT_TTL_SECONDS,
            },
            this.config.runTokenSecret!,
        );
        return {
            repoToken: sealForRuntime(this.config, repoToken, input.runId),
            prRepoToken: sealForRuntime(this.config, prRepoToken, input.runId),
            runToken: sealForRuntime(this.config, runToken, input.runId),
        };
    }

    /** A fork's code runs on a smaller LLM budget than the plan's per-Run one (ADR-030). */
    private maxTokensFor(fork: boolean): number {
        return fork ? forkRunMaxTokens(this.config.llmBudget.perRun) : this.config.llmBudget.perRun;
    }

    private ensureTokenConfig(): void {
        if (!this.config.runTokenSecret) {
            throw new ServiceUnavailableException('Runtime run token secret is not configured');
        }
        if (!this.config.secretSealKey) {
            throw new ServiceUnavailableException('RUNTIME_SECRET_SEAL_KEY is not configured; no Run is enqueued with a plain token');
        }
    }
}
