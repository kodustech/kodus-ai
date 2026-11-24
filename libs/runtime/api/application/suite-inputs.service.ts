import { Inject, Injectable } from '@nestjs/common';

import type { RuntimeRunRequested } from '@libs/runtime/run';

import {
    RUNTIME_API_CONFIG,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_REPO_TOKEN_ISSUER,
    type PullRequestDiff,
    type RuntimeApiConfig,
    type RuntimeEnvironmentSetupReader,
    type RuntimeGitPort,
    type RuntimeRepoTokenIssuer,
} from '../domain/ports';
import { sealForRuntime } from './secret-sealer';
import { suiteOfRecipeAt } from './suite-recipe';

interface SuiteRepo {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName: string;
}

/** What the product reads for a suite that the Runtime may not read itself, as a request carries it. */
export type SuiteRunInputs = NonNullable<RuntimeRunRequested['suite']>;

/**
 * The product's side of the suite's inputs (docs/runtime/e2e-suites.md sections 10.2 and 11), shared by CI mode and Run mode: the
 * PR's files from the Git API diff and the sealed download tokens, one per claim (the cell revokes a token once it fetched with
 * it: the spec listing, each shard of the recipe's ceiling, the fresh host and the main host). `forRun` builds the whole `suite`
 * section of a Run request, or nothing when the environment's recipe declares no suite.
 */
@Injectable()
export class RuntimeSuiteInputs {
    constructor(
        @Inject(RUNTIME_GIT_PORT) private readonly git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
        @Inject(RUNTIME_REPO_TOKEN_ISSUER) private readonly repoTokens: RuntimeRepoTokenIssuer,
        @Inject(RUNTIME_API_CONFIG) private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER) private readonly setups: Pick<RuntimeEnvironmentSetupReader, 'get'>,
    ) {}

    /** The files the PR changed (a rename is both paths), or nothing when the diff was cut: unknown is never a short list. */
    changesOf(diff: PullRequestDiff): { changedFiles?: string[] } {
        if (diff.truncated) return {};
        return { changedFiles: [...new Set(diff.files.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]))].sort() };
    }

    /** One sealed download token per claim of a suite with `shards` as its ceiling, bound to `sealTo`. */
    async tokensFor(repo: SuiteRepo, shards: number, sealTo: string): Promise<string[]> {
        const tokens: string[] = [];
        for (let i = 0; i < shards + 3; i++) tokens.push(sealForRuntime(this.config, await this.repoTokens.issue(repo), sealTo));
        return tokens;
    }

    /**
     * The suite section of a Run's request: undefined when the environment was never set up (no main commit), or its recipe at that
     * commit declares no suite, so nothing is minted for a suite that cannot run.
     */
    async forRun(input: { repo: SuiteRepo; environmentId: string; diff: PullRequestDiff; runId: string }): Promise<SuiteRunInputs | undefined> {
        const mainSha = (await this.setups.get(input.repo.organizationId, input.environmentId))?.sha;
        if (!mainSha) return undefined;
        const suite = await suiteOfRecipeAt(this.git, input.repo, mainSha);
        if (!suite) return undefined;
        const [repoToken, ...moreRepoTokens] = await this.tokensFor(input.repo, suite.shards, input.runId);
        return { mainSha, repoToken, moreRepoTokens, ...this.changesOf(input.diff) };
    }
}
