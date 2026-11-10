import {
    BadGatewayException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';

import type { AgentRunner } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { createLogger } from '@libs/core/log/logger';
import { RecipeAuthorRequestSchema, type RecipeAuthorResponse } from '@libs/runtime/contracts/recipe-author';
import { RUNTIME_RECIPE_MAX_BYTES } from '@libs/runtime/contracts/runtime-commands';
import { redactPatterns } from '@libs/runtime/redaction';
import { setupLearnScopeId } from '@libs/runtime/run';

import { decideBudget, setupBudgetLimits, startOfUtcDay, tightestBudgetScope, withOrgBudget } from '../../domain/budget';
import {
    LlmBudgetBusyError,
    RUNTIME_AGENT_RUNNER_FACTORY,
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_LLM_USAGE_STORE,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_SETTINGS_STORE,
    type Clock,
    type ProductEnvironmentStore,
    type RuntimeAgentRunnerFactory,
    type RuntimeApiConfig,
    type RuntimeEnvironmentSetupReader,
    type RuntimeGitPort,
    type RuntimeLlmUsageStore,
    type RuntimeSettingsStore,
} from '../../domain/ports';
import { InvalidRunTokenError, isSetupToken, verifySetupToken } from '../../domain/run-token';
import { type AuthoredFile, checkAuthoredSubmission } from '../recipe-author/authored-files-policy';
import { GitRepoReader } from '../recipe-author/git-repo-reader';
import { authorRecipe, RECIPE_AUTHOR_LIMITS } from '../recipe-author/recipe-author.agent';
import { fileExists, READ_LIMITS, type RepoReader, RepoPathError } from '../recipe-author/repo-reader';

/** The task the setup's budget counts the author's tokens under. */
export const RECIPE_AUTHOR_TASK = 'runtime.recipe_author';
/** Tokens the setup's budget must still have for a run to start: below it the agent could not read and submit. */
export const RECIPE_AUTHOR_MIN_TOKENS = 20_000;
/** The whole run, model calls and Git reads, stops here. */
export const RECIPE_AUTHOR_TIMEOUT_MS = 5 * 60_000;

/** What the worker reads on a 502: the model or the run failed, which is no verdict of Kody's on the repository. */
export const RECIPE_AUTHOR_UNAVAILABLE = { code: 'llm_unavailable', message: "Kody's model call failed" } as const;
/** The same 502 when the Git platform failed while the checks read the commit: the worker reads it as no answer, never as Kody's no_recipe. */
export const RECIPE_AUTHOR_GIT_UNAVAILABLE = { code: 'llm_unavailable', message: 'the Git platform failed while Kodus checked the recipe' } as const;

/**
 * The runner of one author run, keeping the state it ended in: the agent's
 * result says no_recipe whether Kody found nothing or the model failed, and
 * only the first is Kody's verdict.
 */
class ObservedRunner implements AgentRunner {
    last?: RunState;

    constructor(private readonly inner: AgentRunner) {}

    async run(...args: Parameters<AgentRunner['run']>): Promise<RunState> {
        this.last = await this.inner.run(...args);
        return this.last;
    }
}

const counted = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined);

/**
 * POST /internal/runtime/recipe-author (docs RECIPE-AGENT-TEST-PLAN, "Ligar ao
 * produto"). The setup's recipe step found no recipe on the default branch and
 * no inferred one; with the setup token, it asks the product to have Kody
 * write it. The agent runs here, on the org's LLM_TASK.runtime slot, and the
 * key never reaches the worker or the cell (ADR-057). It only reads the
 * commit the setup records, through the Git integration; what it submits
 * passes the authored-recipe checks (parseRecipe plus the rules for a recipe
 * Kody wrote) before it is returned, and the cell checks it again like any
 * recipe. Its tokens count against the setup's LLM budget, under the same
 * scope id as the setup's learn loop (S-47): reserved before the run, settled
 * with what the model reported.
 */
@Injectable()
export class RuntimeRecipeAuthorUseCase {
    private readonly logger = createLogger(RuntimeRecipeAuthorUseCase.name);

    constructor(
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Inject(RUNTIME_LLM_USAGE_STORE)
        private readonly usage: RuntimeLlmUsageStore,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly products: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_AGENT_RUNNER_FACTORY)
        private readonly runners: RuntimeAgentRunnerFactory,
        @Optional()
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups?: RuntimeEnvironmentSetupReader,
        @Optional()
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings?: Pick<RuntimeSettingsStore, 'getOrganization'>,
    ) {}

    /**
     * `signal`: the caller went away (the worker's request closed). The run
     * stops with it instead of spending the setup's budget on an answer
     * nobody reads; the 5-minute ceiling stands either way.
     */
    async execute(input: { authorization?: string; body: unknown; signal?: AbortSignal }): Promise<RecipeAuthorResponse> {
        if (!this.config.runTokenSecret) throw new ServiceUnavailableException('Runtime recipe author is not configured');
        const token = /^Bearer\s+(\S+)$/i.exec(input.authorization ?? '')?.[1];
        if (!token) throw new UnauthorizedException('Setup token required');
        // Only a setup token: a Run token never asks for a recipe.
        if (!isSetupToken(token)) throw new UnauthorizedException('Invalid setup token (not a setup token)');
        let claims: ReturnType<typeof verifySetupToken>;
        try {
            claims = verifySetupToken(token, this.config.runTokenSecret, this.now());
        } catch (e) {
            if (e instanceof InvalidRunTokenError) throw new UnauthorizedException(`Invalid setup token (${e.reason})`);
            throw e;
        }

        const parsed = RecipeAuthorRequestSchema.safeParse(input.body);
        if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

        // The setup the token names: the environment's latest, still running, booting the commit the request names.
        if (!this.setups) throw new ServiceUnavailableException('Runtime recipe author is not configured for setups');
        const setup = await this.setups.get(claims.organizationId, claims.environmentId);
        if (!setup || setup.organizationId !== claims.organizationId || setup.environmentId !== claims.environmentId) {
            throw new NotFoundException('Setup not found');
        }
        if (setup.key !== claims.setupKey || setup.repositoryId !== claims.repositoryId) {
            throw new ConflictException('A newer setup of this environment replaced this one');
        }
        if (setup.state !== 'setting_up') throw new ConflictException('This setup has finished');
        // Kody writes only from the default-branch head the product resolved (§6), never a dev override.
        if (setup.refSource !== 'default_branch' || !setup.sha) throw new ForbiddenException('Kody writes a recipe only for the default branch head');
        if (setup.sha !== parsed.data.sha) throw new ForbiddenException('The setup boots another commit');

        const product = await this.products.get(claims.organizationId, claims.environmentId);
        if (!product || product.organizationId !== claims.organizationId || product.repositoryId !== claims.repositoryId) {
            throw new NotFoundException('Environment not found');
        }

        const orgTeam = { organizationId: claims.organizationId, teamId: claims.teamId };
        const agent = await this.runners.forOrganization(orgTeam);
        if (!agent) throw new ServiceUnavailableException('No LLM is configured for the Kody Runtime of this organization');

        // S-47: reserve the whole run's tokens up front under the setup's scope; the run never spends past it.
        const scopeId = setupLearnScopeId(claims.setupKey);
        const now = this.now();
        const org = await this.settings?.getOrganization(claims.organizationId);
        // A setup is no pull request: its prNumber 0 counter is the repository's, for good (setupBudgetLimits).
        const limits = setupBudgetLimits(withOrgBudget(this.config.llmBudget, org?.tokenBudgetPerDay));
        let refused: { exhausted: string; spent: number; limit: number } | undefined;
        const reservation = await this.usage
            .reserve({
                usage: { runId: scopeId, organizationId: claims.organizationId, repositoryId: claims.repositoryId, prNumber: 0, task: RECIPE_AUTHOR_TASK, at: now },
                orgDayStart: startOfUtcDay(now),
                decide: (spend) => {
                    const d = decideBudget(spend, limits, claims.maxTokens);
                    if (d.allowed === false) {
                        refused = d;
                        return null;
                    }
                    const tokens = Math.min(RECIPE_AUTHOR_LIMITS.maxTokens, d.remaining);
                    if (tokens < RECIPE_AUTHOR_MIN_TOKENS) {
                        // Too little left for a run: the scope that left the least is the one to name (the org's day may be tighter than the setup's).
                        refused = tightestBudgetScope(spend, limits, claims.maxTokens);
                        return null;
                    }
                    return tokens;
                },
            })
            .catch((e) => {
                if (e instanceof LlmBudgetBusyError) throw new ServiceUnavailableException({ code: 'llm_budget_busy', message: e.message });
                throw e;
            });
        if (!reservation) {
            const r = refused ?? { exhausted: 'run', spent: 0, limit: 0 };
            this.logger.warn({
                message: 'Runtime recipe author: LLM budget exhausted',
                context: RuntimeRecipeAuthorUseCase.name,
                metadata: { organizationId: claims.organizationId, environmentId: claims.environmentId, scope: r.exhausted, spent: r.spent, limit: r.limit },
            });
            throw new HttpException(
                { statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'llm_budget_exceeded', scope: r.exhausted, spent: r.spent, limit: r.limit },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        const target = { ...orgTeam, repositoryId: claims.repositoryId, repositoryName: product.repositoryName, sha: setup.sha };
        const reader = new GitRepoReader(this.git, target);
        const runner = new ObservedRunner(agent.runner);
        let result: Awaited<ReturnType<typeof authorRecipe>>;
        try {
            result = await authorRecipe(
                { runner, reader },
                {
                    runId: scopeId,
                    repositoryName: product.repositoryName,
                    sha: setup.sha,
                    mode: 'explore',
                    maxTokens: reservation.tokens,
                    signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(RECIPE_AUTHOR_TIMEOUT_MS)]) : AbortSignal.timeout(RECIPE_AUTHOR_TIMEOUT_MS),
                },
            );
        } catch (e) {
            // What the run spent before it failed is unknown: the reservation stays counted (S-47), never a free run.
            // A settle that fails too is logged with it; the run's own error is never lost behind it.
            const settleError = await this.usage
                .settle(reservation.reservationId, { inputTokens: reservation.tokens, outputTokens: 0, ...(agent.model ? { model: agent.model } : {}) })
                .then(
                    () => undefined,
                    (err: unknown) => err,
                );
            this.logger.error({
                message: 'Runtime recipe author run failed',
                context: RuntimeRecipeAuthorUseCase.name,
                error: e instanceof Error ? e : undefined,
                metadata: {
                    organizationId: claims.organizationId,
                    environmentId: claims.environmentId,
                    ...(settleError !== undefined ? { settleError: settleError instanceof Error ? settleError.message : String(settleError) } : {}),
                },
            });
            throw new BadGatewayException(RECIPE_AUTHOR_UNAVAILABLE);
        }

        const inputTokens = counted(result.usage?.inputTokens);
        const outputTokens = counted(result.usage?.outputTokens);
        const reported = inputTokens !== undefined && outputTokens !== undefined;
        const usage = reported ? { inputTokens, outputTokens } : { inputTokens: reservation.tokens, outputTokens: 0 };
        if (!reported) {
            this.logger.warn({
                message: 'Runtime recipe author: the provider reported no usage; the reservation stays counted',
                context: RuntimeRecipeAuthorUseCase.name,
                metadata: { organizationId: claims.organizationId, environmentId: claims.environmentId, reserved: reservation.tokens },
            });
        }
        const cacheReadTokens = reported ? counted(result.usage?.cacheReadTokens) : undefined;
        const cacheWriteTokens = reported ? counted(result.usage?.cacheWriteTokens) : undefined;
        // A settle that fails never discards what Kody wrote: the reservation stays counted (S-47), and it is logged.
        await this.usage
            .settle(reservation.reservationId, {
                ...usage,
                ...(cacheReadTokens ? { cacheReadTokens } : {}),
                ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
                ...(agent.model ? { model: agent.model } : {}),
            })
            .catch((err: unknown) =>
                this.logger.error({
                    message: 'Runtime recipe author: settling the run failed; the reservation stays counted',
                    context: RuntimeRecipeAuthorUseCase.name,
                    error: err instanceof Error ? err : undefined,
                    metadata: { organizationId: claims.organizationId, environmentId: claims.environmentId, reserved: reservation.tokens },
                }),
            );

        // The model failed before Kody submitted or gave up: no verdict, the setup goes on without Kody.
        // A give-up ends the run on its submit_recipe call, so an errored run carries none; the refusal limit is a verdict.
        if (result.status === 'no_recipe' && runner.last?.status === 'error' && result.rejected.length < RECIPE_AUTHOR_LIMITS.maxRejected) {
            this.logger.warn({
                message: 'Runtime recipe author: the model call failed',
                context: RuntimeRecipeAuthorUseCase.name,
                metadata: { organizationId: claims.organizationId, environmentId: claims.environmentId, steps: result.steps, ...usage },
            });
            throw new BadGatewayException(RECIPE_AUTHOR_UNAVAILABLE);
        }
        let answer: Awaited<ReturnType<RuntimeRecipeAuthorUseCase['checked']>>;
        try {
            answer = result.status === 'submitted' ? await this.checked(result.recipe, result.notes, result.files, reader) : { status: 'no_recipe', reason: result.reason };
        } catch (e) {
            // The Git platform failed while the checks read the commit: no verdict of Kody's, the setup goes on without it.
            this.logger.warn({
                message: 'Runtime recipe author: the Git platform failed during the checks',
                context: RuntimeRecipeAuthorUseCase.name,
                error: e instanceof Error ? e : undefined,
                metadata: { organizationId: claims.organizationId, environmentId: claims.environmentId },
            });
            throw new BadGatewayException(RECIPE_AUTHOR_GIT_UNAVAILABLE);
        }
        this.logger.log({
            message: 'Runtime recipe author finished',
            context: RuntimeRecipeAuthorUseCase.name,
            metadata: {
                organizationId: claims.organizationId,
                environmentId: claims.environmentId,
                status: answer.status,
                steps: result.steps,
                rejected: result.rejected.length,
                ...usage,
            },
        });
        // The notes and the reason are model text, which the repository could steer: redacted like the prompt (S-51), cut, shown as text only.
        const said = (text: string, max: number) => redactPatterns(text).text.slice(0, max);
        return answer.status === 'submitted'
            ? {
                  status: 'submitted',
                  recipe: answer.recipe,
                  ...(answer.notes ? { notes: said(answer.notes, 1_000) } : {}),
                  // Code the checks accepted, bounded by them (AUTHORED_FILES_LIMITS): never redacted, the cell builds it as is.
                  ...(answer.files?.length ? { files: answer.files } : {}),
                  usage,
              }
            : { status: 'no_recipe', reason: said(answer.reason, 500) || 'no reason given', usage };
    }

    /**
     * The submitted recipe and its files pass the authored checks again here,
     * on the same commit, whatever the agent's tool already decided: the
     * answer never carries a recipe or a file those checks refuse. The files
     * are laid over the commit (a compose file the recipe names may be one of
     * them). A Git failure while reading is thrown, never taken for a missing
     * file: it is no verdict on the repository.
     */
    private async checked(
        recipe: string,
        notes: string | undefined,
        files: AuthoredFile[] | undefined,
        reader: RepoReader,
    ): Promise<{ status: 'submitted'; recipe: string; notes?: string; files?: AuthoredFile[] } | { status: 'no_recipe'; reason: string }> {
        if (Buffer.byteLength(recipe) > RUNTIME_RECIPE_MAX_BYTES) return { status: 'no_recipe', reason: `the recipe is larger than ${RUNTIME_RECIPE_MAX_BYTES} bytes` };
        const read = (path: string) =>
            reader.read(path, READ_LIMITS.fileBytes).catch((e: unknown) => {
                if (e instanceof RepoPathError) return null;
                throw e;
            });
        const check = await checkAuthoredSubmission(recipe, files, (path) => fileExists(reader, path), read);
        if (!check.ok) return { status: 'no_recipe', reason: `the checks refused the recipe: ${check.errors.join('; ')}` };
        return { status: 'submitted', recipe, ...(notes ? { notes } : {}), ...(check.files?.length ? { files: check.files } : {}) };
    }
}
