import { Inject, Injectable } from '@nestjs/common';

import { SUITE_MAIN_BEHIND_MAX } from '@libs/runtime/contracts/runtime-commands';
import type { RuntimeRunRequested } from '@libs/runtime/run';
import { mainSpecsOfTree } from '@libs/runtime/suite';

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
        @Inject(RUNTIME_GIT_PORT) private readonly git: Pick<RuntimeGitPort, 'readFileAtCommit' | 'compareWithMain' | 'listFileSizesAtCommit'>,
        @Inject(RUNTIME_REPO_TOKEN_ISSUER) private readonly repoTokens: RuntimeRepoTokenIssuer,
        @Inject(RUNTIME_API_CONFIG) private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER) private readonly setups: Pick<RuntimeEnvironmentSetupReader, 'get'>,
    ) {}

    /**
     * The files the PR changed (a rename is both paths) and those it removed (a rename's old path included), or nothing when the diff
     * was cut: unknown is never a short list. No removal is no field.
     */
    changesOf(diff: PullRequestDiff): { changedFiles?: string[]; removedFiles?: string[] } {
        if (diff.truncated) return {};
        return {
            changedFiles: [...new Set(diff.files.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]))].sort(),
            ...(diff.removedFiles?.length ? { removedFiles: [...diff.removedFiles].sort() } : {}),
        };
    }

    /**
     * Where the PR stands against main, from the platform's compare API (one call; the count, never the commits): the true merge base
     * of `mainSha` and the PR's head, and how many main commits are past it, cut at `SUITE_MAIN_BEHIND_MAX` (the classifier only needs
     * to know up to the baseline's reach plus one). A platform with no compare, commits it does not know or a Git API that fails give
     * nothing: the caller keeps the base the PR was opened against and claims no drift, which is the Runtime's own at-least-one.
     */
    async standingOf(repo: SuiteRepo, mainSha: string, headSha: string): Promise<{ mergeBase?: string; mainBehind?: number }> {
        if (!this.git.compareWithMain) return {};
        try {
            const answer = await this.git.compareWithMain({ ...repo, main: mainSha, head: headSha });
            if (!answer || answer === 'unsupported_platform' || !/^[0-9a-f]{40}$/.test(answer.mergeBase)) return {};
            // A merge base that is not main's own has at least one main commit past it, whatever the count says.
            const behind = answer.mergeBase === mainSha ? 0 : Math.max(1, answer.behindBy);
            return { mergeBase: answer.mergeBase, mainBehind: Math.min(behind, SUITE_MAIN_BEHIND_MAX) };
        } catch {
            return {};
        }
    }

    /**
     * Main's spec files with their sizes, from the repository's tree at `mainSha` (one Git API call): the engine then needs no
     * listing host, which on an environment with no ready template would build main cold only to list files. Nothing when the
     * platform has no tree here, the call fails or more specs match than a command carries: the listing host lists them.
     */
    async mainSpecsOf(repo: SuiteRepo, mainSha: string, suite: { specs: string; cwd?: string }): Promise<{ mainSpecs?: Array<{ path: string; sizeBytes: number }> }> {
        if (!this.git.listFileSizesAtCommit) return {};
        try {
            const tree = await this.git.listFileSizesAtCommit({ ...repo, sha: mainSha });
            if (tree === 'unsupported_platform') return {};
            const specs = mainSpecsOfTree(tree, { glob: suite.specs, ...(suite.cwd !== undefined ? { cwd: suite.cwd } : {}) });
            return specs ? { mainSpecs: specs } : {};
        } catch {
            return {};
        }
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
    async forRun(input: { repo: SuiteRepo; environmentId: string; diff: PullRequestDiff; runId: string; headSha: string }): Promise<SuiteRunInputs | undefined> {
        const setup = await this.setups.get(input.repo.organizationId, input.environmentId);
        const mainSha = setup?.sha;
        if (!mainSha) return undefined;
        const suite = await suiteOfRecipeAt(this.git, input.repo, mainSha, setup);
        if (!suite) return undefined;
        const [repoToken, ...moreRepoTokens] = await this.tokensFor(input.repo, suite.shards, input.runId);
        return {
            mainSha,
            ...(await this.standingOf(input.repo, mainSha, input.headSha)),
            repoToken,
            moreRepoTokens,
            ...this.changesOf(input.diff),
            ...(await this.mainSpecsOf(input.repo, mainSha, suite)),
        };
    }
}
