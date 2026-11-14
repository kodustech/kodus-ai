import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { applyRecipeChange } from '@libs/runtime/blockers/recipe-edit';
import { recipeDigest } from '@libs/runtime/run/recipe';

import { RUNTIME_RECIPE_MAX_BYTES, RUNTIME_RECIPE_PATH, RUNTIME_RECIPE_PATHS } from '../../domain/runtime-commands';
import { type ProductEnvironmentStore, RUNTIME_GIT_PORT, RUNTIME_PRODUCT_ENVIRONMENT_STORE, type RuntimeGitPort } from '../../domain/ports';
import { inferRecipeAtCommit } from '../recipe-inference.reader';
import type { RuntimeAuthorization } from '../run-access.service';
import { gitCall, KODY_FIX_ORIGIN } from './apply-blocker-fix.use-case';
import { GetRuntimeEnvironmentUseCase } from './environments.use-cases';

/** ENV-06: the inferred (or authored) recipe is offered only once it booted from zero on this many clean machines. */
export const INFERRED_RECIPE_CLEAN_BOOTS = 2;

export interface ProposedRecipe {
    pullRequest: { number: number; url: string };
}

/**
 * POST /runtime/environments/:id/recipe/propose. The default branch had no
 * recipe, Kodus inferred one from the repository files, and it booted from
 * zero in two setups in a row with the same digest (ENV-06). This opens the PR
 * that adds that exact file (ADR-015: the recipe only changes by a PR). It is
 * refused when a recipe appeared on the default branch meanwhile, or when the
 * files moved so the inference no longer gives the proven recipe. A recipe
 * Kody wrote (origin `authored`) is offered the same way; its proof holds
 * only at the commit it booted on, since no inference can redo it.
 */
@Injectable()
export class ProposeInferredRecipeUseCase {
    constructor(
        private readonly environment: GetRuntimeEnvironmentUseCase,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly products: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<ProposedRecipe> {
        const { env } = await this.environment.load(input.user, input.environmentId);
        const product = await this.products.get(env.organizationId, env.environmentId);
        if (!product || product.organizationId !== env.organizationId) throw new NotFoundException('Environment not found');
        await this.authorization.ensure({
            user: input.user,
            action: Action.Update,
            resource: ResourceType.RuntimeEnvironment,
            repoIds: [product.repositoryId],
        });

        const setup = await this.environment.setup(env);
        const recipe = setup?.recipe;
        if (!setup || (recipe?.origin !== 'inferred' && recipe?.origin !== 'authored') || recipe.state !== 'found' || !recipe.content || !recipe.digest) {
            throw new ConflictException('The latest setup did not boot with a recipe Kodus inferred or Kody wrote, so there is nothing to propose.');
        }
        const authored = recipe.origin === 'authored';
        const what = authored ? 'The recipe Kody wrote' : 'The inferred recipe';
        // Kody's build files go in the same PR: the recipe names them, and the digest that booted covers them.
        const files = authored ? (recipe.files ?? []) : [];
        if (recipeDigest(recipe.content, files) !== recipe.digest || recipe.content.length > RUNTIME_RECIPE_MAX_BYTES) {
            throw new ConflictException('The recorded recipe does not match what booted. Set up again.');
        }
        // The inferred recipe did not boot, but Kody's learn loop found the one-field change that boots it from zero twice (ENV-06).
        const learned = !authored && setup.state === 'blocked' && setup.learn?.proven?.origin === 'inferred' ? setup.learn.proven : undefined;
        let content = recipe.content;
        let boots = recipe.cleanBoots ?? INFERRED_RECIPE_CLEAN_BOOTS;
        if (learned) {
            if (learned.cleanBoots < INFERRED_RECIPE_CLEAN_BOOTS) throw new ConflictException("Kody's fix booted from zero once. Set up again.");
            // Rebuilt from the inferred recipe and the typed change, never taken as text: it must be exactly what booted.
            const edit = applyRecipeChange(recipe.content, learned.change);
            if ('error' in edit || recipeDigest(edit.text) !== learned.digest || edit.text.length > RUNTIME_RECIPE_MAX_BYTES) {
                throw new ConflictException('The recorded fix does not match what booted. Set up again.');
            }
            content = edit.text;
            boots = learned.cleanBoots;
        } else {
            if (setup.state !== 'active') throw new ConflictException(`${what} did not boot in the latest setup, so Kodus does not propose it.`);
            if ((recipe.cleanBoots ?? 0) < INFERRED_RECIPE_CLEAN_BOOTS) {
                throw new ConflictException(`${what} booted from zero once. Set up again: Kodus proposes it after it boots on a second clean machine.`);
            }
        }
        if (!this.git.openPullRequestWithFiles) throw new ServiceUnavailableException('Opening a pull request is not available for this repository.');

        const repo = {
            organizationId: product.organizationId,
            teamId: product.teamId,
            repositoryId: product.repositoryId,
            repositoryName: product.repositoryName,
        };
        const head = await gitCall(() => this.git.getDefaultBranchHead(repo));
        if (head.status !== 'ok') throw new ServiceUnavailableException('Kodus cannot read the default branch of this repository.');
        for (const path of RUNTIME_RECIPE_PATHS) {
            const text = await gitCall(() => this.git.readFileAtCommit({ ...repo, path, sha: head.sha, maxBytes: RUNTIME_RECIPE_MAX_BYTES }));
            if (text === 'unsupported_platform') throw new ServiceUnavailableException('Kodus cannot read files on this platform yet.');
            if (text !== null) throw new ConflictException(`${path} is on ${head.branch} now. Set up again to boot with it.`);
        }
        // The head moved since the setup. Kody's recipe was proven at that commit only; nothing can redo it without a new setup.
        if (head.sha !== setup.sha && authored) {
            throw new ConflictException(`${head.branch} moved since the setup. Set up again to prove the recipe Kody wrote at the new head.`);
        }
        // The proof of an inferred one holds only if the same files still give the same recipe.
        if (head.sha !== setup.sha) {
            const again = await gitCall(async () => {
                const out = await inferRecipeAtCommit(this.git, { ...repo, sha: head.sha });
                if (!out) throw new Error('git');
                return out;
            });
            if (again.status !== 'inferred' || recipeDigest(again.content) !== recipe.digest) {
                throw new ConflictException(`The repository files changed on ${head.branch} since the setup. Set up again to prove the new recipe.`);
            }
        }

        const proposed = recipeDigest(content, files)
            .replace(/^sha256:/, '')
            .slice(0, 12);
        const body = [
            learned
                ? `The default branch has no Kody Runtime recipe, so Kodus wrote one from the repository files. It did not boot as written; with one change (**${learned.fix.label}**) it booted from zero on ${boots} clean machines at \`${(setup.sha ?? head.sha).slice(0, 12)}\`, and each one answered the ready check.`
                : authored
                  ? `The default branch has no Kody Runtime recipe and Kodus could not infer one, so Kody read the repository and wrote this one. It booted from zero on ${boots} clean machines at \`${(setup.sha ?? head.sha).slice(0, 12)}\`, and each one answered the ready check.`
                  : `The default branch has no Kody Runtime recipe, so Kodus wrote this one from the repository files (no LLM) and booted it from zero on ${boots} clean machines at \`${(setup.sha ?? head.sha).slice(0, 12)}\`. Each one answered the ready check.`,
            ...(learned ? ['', KODY_FIX_ORIGIN] : []),
            '',
            '```yaml',
            content.trimEnd(),
            '```',
            '',
            ...(files.length ? [`It builds from ${files.length === 1 ? 'a file' : 'files'} Kody wrote next to it, added here too: ${files.map((f) => `\`${f.path}\``).join(', ')}.`, ''] : []),
            'Once merged, every setup and pull request Run boots from this file, and you change it like any recipe (docs §6). It holds no secret: env values are test values that name themselves.',
        ].join('\n');
        const title = authored ? 'chore(kody-runtime): add the environment recipe Kody wrote' : 'chore(kody-runtime): add the environment recipe Kodus inferred';
        const pr = await gitCall(() =>
            this.git.openPullRequestWithFiles!({
                ...repo,
                baseBranch: head.branch,
                branch: `kody-runtime/recipe-${proposed}`,
                title,
                body,
                commitMessage: title,
                files: [{ path: RUNTIME_RECIPE_PATH, content }, ...files.map((f) => ({ path: f.path, content: f.content }))],
            }),
        );
        if (!pr) throw new ServiceUnavailableException('The Git platform refused the pull request.');
        return { pullRequest: pr };
    }
}
