import { HttpException, Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';

import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { machineSizeOf, MACHINE_SIZES } from '@libs/runtime/contracts/machine-size';

import { parseRecipe } from '@libs/runtime/protocol/recipe';
import { resolveRecipeResources } from '@libs/runtime/run/recipe-resources';
import { effectivePoolSize } from '../domain/pool';
import { RuntimePoolController } from './pool-controller.service';
import {
    RUNTIME_RECIPE_MAX_BYTES,
    RUNTIME_RECIPE_PATH,
    RUNTIME_RECIPE_PATHS,
    RuntimeCommandName,
    runtimeCommandOutboxMessage,
    type RuntimeEnvironmentSetupRequested,
    type SetupRequestBlockerKind,
} from '../domain/runtime-commands';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_REPO_TOKEN_ISSUER,
    type Clock,
    type RuntimeApiConfig,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeGitPort,
    type RuntimeRepoTokenIssuer,
} from '../domain/ports';
import { RUN_TOKEN_DEFAULT_TTL_SECONDS, signSetupToken } from '../domain/run-token';
import { inferRecipeAtCommit } from './recipe-inference.reader';
import { sealForRuntime } from './secret-sealer';

type Resolved = Pick<RuntimeEnvironmentSetupRequested,
    | 'ref' | 'repoToken' | 'llmToken' | 'recipe' | 'blocker' | 'repositoryFullName'
    | 'machineSize'
>;

const blocked = (kind: SetupRequestBlockerKind, message: string, extra: Resolved = {}): Resolved => ({
    ...extra,
    blocker: { kind, message: message.slice(0, 500) },
});

/** Product-authored message of an HttpException; anything else stays generic (it may carry request details). */
const safeMessage = (e: unknown, fallback: string) => (e instanceof HttpException ? e.message : fallback);

/**
 * Builds `runtime.environment.setup_requested` the way "Run again" builds a
 * Run: the product reads the default-branch head and the recipe at that
 * commit from the Git API (ADR-057), mints the one-repo download token
 * (ADR-002) and writes the outbox row. What it cannot resolve travels as a
 * typed blocker the worker records; the worker never picks a commit itself.
 */
@Injectable()
export class RuntimeSetupRequester {
    private readonly logger = createLogger(RuntimeSetupRequester.name);

    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
        @Inject(RUNTIME_REPO_TOKEN_ISSUER)
        private readonly repoTokens: RuntimeRepoTokenIssuer,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Optional()
        private readonly pool?: RuntimePoolController,
    ) {}

    async request(env: ProductEnvironment, user: Partial<IUser>): Promise<ProductEnvironment> {
        const at = this.now();
        const requestedAt = at.toISOString();
        const key = `${env.environmentId}:${requestedAt}`;
        const resolved = await this.resolve(env, key);
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.EnvironmentSetupRequested,
                {
                    environmentId: env.environmentId,
                    organizationId: env.organizationId,
                    teamId: env.teamId,
                    repositoryId: env.repositoryId,
                    repositoryName: env.repositoryName,
                    requestedBy: { userId: user.uuid!, ...(user.email ? { email: user.email } : {}) },
                    requestedAt,
                    key,
                    ...resolved,
                    // The org admin's diagnostic hold (§11 runbook); the hub and the cell keep it to setup, never a PR.
                    ...(env.diagnosticHold ? { diagnosticHold: true } : {}),
                    // The warm pool the cell keeps once the bake is accepted: what the pool policy wants now
                    // (the size, the schedule, a pull request's warm-up, the budget), under the plan's ceiling.
                    poolSize: this.pool ? this.pool.status(env).size : effectivePoolSize(this.config.pool, env.poolSize),
                },
                key,
            ),
        );
        if (resolved.blocker) {
            this.logger.warn({
                message: 'Runtime environment setup requested with a blocker',
                context: RuntimeSetupRequester.name,
                metadata: { environmentId: env.environmentId, organizationId: env.organizationId, kind: resolved.blocker.kind },
            });
        }
        await this.environments.markSetupRequested(env.organizationId, env.environmentId, at);
        return { ...env, state: 'setup_requested', setupRequestedAt: requestedAt, updatedAt: requestedAt };
    }

    /** `sealFor`: the setup's idempotency key, which the download token is sealed to. */
    async resolve(env: ProductEnvironment, sealFor: string): Promise<Resolved> {
        const orgTeam = { organizationId: env.organizationId, teamId: env.teamId };
        const repo = { repositoryId: env.repositoryId, repositoryName: env.repositoryName };
        const base: Resolved = env.repositoryName.includes('/') ? { repositoryFullName: env.repositoryName } : {};

        let head;
        try {
            head = await this.git.getDefaultBranchHead({ ...orgTeam, ...repo });
        } catch (e) {
            this.warnGitFailure('default branch head', env, e);
            return blocked('git_unavailable', 'The Git API did not answer the default branch head; ask for the setup again.', base);
        }
        if (head.status === 'unsupported_platform') {
            return blocked(
                'unsupported_platform',
                `Environment setup reads the default branch from ${head.platform ?? 'the Git platform'}, which is not supported yet (GitHub only).`,
                base,
            );
        }
        if (head.status === 'not_found') {
            return blocked('no_ref', 'The repository has no default branch head to build (empty repository or no access).', base);
        }
        const ref = { sha: head.sha, branch: head.branch };

        // The Runtime-only recipe first, then the shared one (§6).
        let content: string | null | 'unsupported_platform' = null;
        let path: (typeof RUNTIME_RECIPE_PATHS)[number] = RUNTIME_RECIPE_PATH;
        for (const candidate of RUNTIME_RECIPE_PATHS) {
            try {
                content = await this.git.readFileAtCommit({ ...orgTeam, ...repo, path: candidate, sha: head.sha, maxBytes: RUNTIME_RECIPE_MAX_BYTES });
            } catch (e) {
                this.warnGitFailure('recipe', env, e);
                return blocked('recipe_unreadable', `${candidate} on ${head.branch} could not be read (larger than ${RUNTIME_RECIPE_MAX_BYTES} bytes or a Git API error).`, { ...base, ref });
            }
            if (content === 'unsupported_platform') {
                return blocked('unsupported_platform', 'This Git platform cannot read the recipe at a commit yet (GitHub only).', { ...base, ref });
            }
            path = candidate;
            if (content !== null) break;
        }
        // Not found anywhere: recorded as absent at the shared path.
        if (content === null) path = RUNTIME_RECIPE_PATH;
        let recipe: NonNullable<Resolved['recipe']> = { path, sha: head.sha, content };
        // No recipe: Kodus writes one from the repository files (deterministic, no LLM). The PR offering it comes after it boots (ENV-06).
        if (content === null) {
            const inferred = await inferRecipeAtCommit(this.git, { ...orgTeam, ...repo, sha: head.sha });
            if (inferred?.status === 'inferred') recipe = { path: RUNTIME_RECIPE_PATH, sha: head.sha, content: inferred.content, origin: 'inferred' };
            else if (inferred) recipe = { ...recipe, inference: { reason: inferred.reason, message: inferred.message.slice(0, 500) } };
            else this.warnGitFailure('recipe inference', env, undefined);
        }

        // Resolve from this trusted base recipe before outbox/admission and before issuing a token.
        const parsed =
            recipe.content === null ? undefined : parseRecipe(recipe.content);
        if (parsed && !parsed.ok)
            return blocked(
                'recipe_invalid',
                'The base recipe is invalid; correct it before requesting setup.',
                { ...base, ref, recipe },
            );
        const resources = resolveRecipeResources({
            ...(parsed?.ok && parsed.recipe.size
                ? { recipe: parsed.recipe.size }
                : {}),
            ...(env.machineSize
                ? { admin: machineSizeOf(env.machineSize) }
                : {}),
            ceiling: MACHINE_SIZES[this.config.machineSize.maxPreset],
        });
        if (resources.ok === false)
            return blocked('resources', resources.message, {
                ...base,
                ref,
                recipe,
            });
        const sized = resources.size ? { machineSize: resources.size } : {};

        // The token last: it lives 1 h and starts counting now. It travels sealed to this setup.
        let repoToken: string;
        try {
            repoToken = await this.repoTokens.issue({ ...orgTeam, ...repo });
        } catch (e) {
            return blocked('token_unavailable', safeMessage(e, 'The repository download token could not be issued.'), { ...base, ref, recipe });
        }
        if (!this.config.secretSealKey) {
            return blocked('token_unavailable', 'RUNTIME_SECRET_SEAL_KEY is not configured; the download token is not handed over plain.', { ...base, ref, recipe });
        }
        return { ...base, ref, recipe, ...sized, repoToken: sealForRuntime(this.config, repoToken, sealFor), ...this.llmTokenFor(env, sealFor) };
    }

    /**
     * The setup token Kody's learn loop calls the LLM gateway with (ADR-057),
     * budgeted like a Run: its ceiling is the per-Run limit. Without the run
     * token secret the loop is off and the deterministic cards stay.
     */
    private llmTokenFor(env: ProductEnvironment, setupKey: string): Pick<Resolved, 'llmToken'> {
        if (!this.config.runTokenSecret) return {};
        const token = signSetupToken(
            {
                setupKey,
                environmentId: env.environmentId,
                organizationId: env.organizationId,
                teamId: env.teamId,
                repositoryId: env.repositoryId,
                ...(this.config.llmBudget?.perRun ? { maxTokens: this.config.llmBudget.perRun } : {}),
                exp: Math.floor(this.now().getTime() / 1000) + RUN_TOKEN_DEFAULT_TTL_SECONDS,
            },
            this.config.runTokenSecret,
        );
        return { llmToken: sealForRuntime(this.config, token, setupKey) };
    }

    /** Logs a Git API failure by its kind only: the platform's message can carry request details. */
    private warnGitFailure(what: string, env: ProductEnvironment, e: unknown) {
        this.logger.warn({
            message: `Runtime environment setup: the Git API failed on the ${what}`,
            context: RuntimeSetupRequester.name,
            metadata: {
                environmentId: env.environmentId,
                repositoryId: env.repositoryId,
                errorName: e instanceof Error ? e.name : typeof e,
                status: (e as { status?: unknown })?.status,
            },
        });
    }
}
