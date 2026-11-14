import {
    BadGatewayException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
} from '@nestjs/common';
import {
    PlannerSourceRequestSchema,
    PLANNER_SOURCE_LIMITS,
    parsePlannerSourceResponse,
} from '@libs/runtime/contracts/planner-source';
import {
    modelView,
    repoPath,
    type RepoReader,
} from '@libs/runtime/planner/repo-reader';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_GIT_PORT,
    RUNTIME_RUN_PROJECTION_STORE,
    type RuntimeApiConfig,
    type Clock,
    type RuntimeGitPort,
    type RunProjectionReader,
} from '../../domain/ports';
import { GitRepoReader } from '../recipe-author/git-repo-reader';
import {
    runtimeWorkerScope,
    verifyRuntimeWorkerToken,
} from '../runtime-worker-scope';

/** Small bounded cache: only immutable SHA readers and changed-path metadata, never credentials. */
@Injectable()
export class RuntimePlannerSourceUseCase {
    private readonly contexts = new Map<
        string,
        {
            base: RepoReader;
            head: RepoReader;
            changedPaths: string[];
            expires: number;
        }
    >();
    constructor(
        @Inject(RUNTIME_API_CONFIG) private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunProjectionReader,
        @Inject(RUNTIME_GIT_PORT) private readonly git: RuntimeGitPort,
    ) {}

    async execute(input: { authorization?: string; body: unknown }) {
        verifyRuntimeWorkerToken(this.config, this.now, input.authorization);
        const parsed = PlannerSourceRequestSchema.safeParse(input.body);
        if (!parsed.success)
            throw new BadRequestException('Invalid planner source request');
        const req = parsed.data;
        const { claims, run } = await runtimeWorkerScope(
            { config: this.config, now: this.now, runs: this.runs },
            input.authorization,
            req.scope,
        );
        let path = '';
        if (req.op !== 'context') {
            try {
                path = repoPath(req.path, { dir: req.op === 'list' });
            } catch {
                throw new BadRequestException('Invalid repository path');
            }
        }
        const key = `${claims.organizationId}:${run.runId}:${run.attempt}:${run.baseSha}:${run.headSha}`;
        let context = this.contexts.get(key);
        if (!context || context.expires <= this.now().getTime()) {
            const target = {
                organizationId: claims.organizationId,
                teamId: claims.teamId,
                repositoryId: run.repositoryId,
                repositoryName: run.repositoryName,
            };
            const pr = { ...target, prNumber: run.prNumber };
            const readGit = async <T>(read: () => Promise<T>): Promise<T> => {
                try {
                    return await read();
                } catch {
                    throw new BadGatewayException(
                        'Repository source unavailable',
                    );
                }
            };
            const before = await readGit(() => this.git.getPullRequestHead(pr));
            if (!before || before.headSha !== run.headSha)
                throw new ConflictException('The pull request head changed');
            const diff = await readGit(() =>
                this.git.getPullRequestDiff({ ...pr, headSha: run.headSha }),
            );
            const after = await readGit(() => this.git.getPullRequestHead(pr));
            if (!after || after.headSha !== run.headSha)
                throw new ConflictException('The pull request head changed');
            if (diff.files.length > 501)
                throw new BadGatewayException('Repository diff is too large');
            let changedPaths: string[];
            try {
                changedPaths = [
                    ...new Set(diff.files.map((f) => repoPath(f.path))),
                ];
            } catch {
                throw new BadGatewayException('Repository diff is invalid');
            }
            const boundedGit = {
                readFileAtCommit: this.git.readFileAtCommit.bind(this.git),
                ...(this.git.listFilesAtCommit
                    ? {
                          listFilesAtCommit: async (
                              input: Parameters<
                                  NonNullable<
                                      RuntimeGitPort['listFilesAtCommit']
                                  >
                              >[0],
                          ) => {
                              const paths =
                                  await this.git.listFilesAtCommit!(input);
                              if (
                                  paths !== 'unsupported_platform' &&
                                  (paths.length > 20_000 ||
                                      Buffer.byteLength(
                                          JSON.stringify(paths),
                                          'utf8',
                                      ) > 1_000_000)
                              )
                                  throw new BadGatewayException(
                                      'Repository tree is too large',
                                  );
                              return paths;
                          },
                      }
                    : {}),
            };
            context = {
                base: new GitRepoReader(boundedGit, {
                    ...target,
                    sha: run.baseSha,
                }),
                head: new GitRepoReader(boundedGit, {
                    ...target,
                    sha: run.headSha,
                }),
                changedPaths,
                expires: this.now().getTime() + 60_000,
            };
            // Each reader caches one tree. Bound tree ingestion separately in the adapter.
            if (this.contexts.size >= PLANNER_SOURCE_LIMITS.cacheEntries)
                this.contexts.delete(this.contexts.keys().next().value!);
            this.contexts.set(key, context);
        }
        if (req.op === 'context')
            return parsePlannerSourceResponse({
                repositoryName: run.repositoryName,
                baseSha: run.baseSha,
                headSha: run.headSha,
                changedPaths: context.changedPaths,
            });
        if (
            req.side === 'head' &&
            (req.op === 'list' || !context.changedPaths.includes(path))
        )
            throw new ForbiddenException(
                'Only changed files may be read at the head',
            );
        const reader = req.side === 'base' ? context.base : context.head;
        try {
            if (req.op === 'list') {
                const entries = await reader.list(path);
                if (entries.length > PLANNER_SOURCE_LIMITS.listEntries)
                    throw new BadGatewayException(
                        'Repository listing is too large',
                    );
                return parsePlannerSourceResponse({ entries });
            }
            if (req.op === 'exists')
                return { exists: await reader.exists!(path) };
            const text = await reader.read(path, req.maxBytes);
            return parsePlannerSourceResponse({
                text:
                    text === null ? null : modelView(path, text, req.maxBytes),
            });
        } catch (e) {
            if (e instanceof BadGatewayException) throw e;
            throw new BadGatewayException('Repository source unavailable');
        }
    }
}
