import { randomUUID } from 'crypto';

import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { DIFF_TRUNCATED_MARKER_PATH, RuntimeRunRequestedSchema, type RuntimeRunRequested } from '@libs/runtime/run';

import { forkRunMaxTokens } from '../domain/fork-policy';
import { RUN_TOKEN_DEFAULT_TTL_SECONDS, signRunToken } from '../domain/run-token';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_REPO_TOKEN_ISSUER,
    type Clock,
    type ProductEnvironment,
    type PullRequestDiff,
    type PullRequestHead,
    type RuntimeApiConfig,
    type RuntimeEnvironmentReader,
    type RuntimeGitPort,
    type RuntimeRepoTokenIssuer,
} from '../domain/ports';
import { sealForRuntime } from './secret-sealer';

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
@Injectable()
export class RuntimeRunRequestBuilder {
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
    ) {}

    async build(input: {
        env: Pick<ProductEnvironment, 'environmentId' | 'organizationId' | 'teamId' | 'repositoryId' | 'repositoryName'>;
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
        /** A fork Run the environment's policy runs without a maintainer (ADR-030); ignored for a non-fork. */
        forkApprovalRequired?: boolean;
        /** Exact product-admitted probes, not supplied by the planner. */
        externalVerification?: RuntimeRunRequested['externalVerification'];
    }): Promise<RuntimeRunRequested> {
        this.ensureTokenConfig();
        const { env, prNumber, head } = input;
        const runId = input.runId ?? randomUUID();
        const attempt = input.attempt ?? 1;
        const orgTeam = { organizationId: env.organizationId, teamId: env.teamId };
        const repo = { repositoryId: env.repositoryId, repositoryName: env.repositoryName };

        const environment = await this.environmentReader.get(env.organizationId, env.environmentId);
        // The gate pins the image the setup baked; without one there is nothing to pin, so no Run.
        if (!environment?.imageId) {
            throw new ConflictException('The environment has no image yet; run its setup first');
        }
        const diff = input.diff ?? (await this.git.getPullRequestDiff({ ...orgTeam, ...repo, prNumber, headSha: head.headSha }));
        const now = this.now();
        const maxTokens = this.maxTokensFor(head.fork);
        const tokens = await this.mintTokens({ ...orgTeam, ...repo, runId, attempt, prNumber, fork: head.fork });
        const fullName = input.repositoryFullName ?? (env.repositoryName.includes('/') ? env.repositoryName : undefined);
        return RuntimeRunRequestedSchema.parse({
            runId,
            attempt,
            correlationId: randomUUID(),
            requestedAt: now.toISOString(),
            organizationId: env.organizationId,
            teamId: env.teamId,
            repository: { id: env.repositoryId, name: env.repositoryName, ...(fullName ? { fullName } : {}) },
            pullRequest: {
                number: prNumber,
                headSha: head.headSha,
                baseSha: head.baseSha,
                ...(head.baseBranch === undefined ? {} : { baseBranch: head.baseBranch }),
                fork: head.fork,
                ...(head.fork && input.forkApprovalRequired === false ? { forkApprovalRequired: false } : {}),
                ...(head.authorId ? { authorId: head.authorId } : {}),
            },
            environment: {
                environmentId: env.environmentId,
                imageId: environment.imageId,
                expose: environment.expose ?? [],
            },
            ...diffForRun(diff),
            ...tokens,
            budget: { maxTokens },
            trigger: input.trigger,
            ...(input.externalVerification ? { externalVerification: input.externalVerification } : {}),
        });
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
