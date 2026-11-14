import { BadRequestException, ConflictException, HttpException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { isRecipePrAction, KODY_FIX_PREFIX, type RecipeChange, type RecipePrAction } from '@libs/runtime/blockers/catalog';
import { applyRecipeChange } from '@libs/runtime/blockers/recipe-edit';

import { type ProductEnvironmentStore, RUNTIME_GIT_PORT, RUNTIME_PRODUCT_ENVIRONMENT_STORE, type RuntimeGitPort } from '../../domain/ports';
import type { RuntimeAuthorization } from '../run-access.service';
import { RuntimeSetupRequester } from '../runtime-setup-requester.service';
import { ApproveEgressUseCase } from './approve-egress.use-case';
import { blockerGroups, GetRuntimeEnvironmentUseCase } from './environments.use-cases';

const RECIPE_PATH = '.kodus/workspace.yaml';
const MAX_RECIPE_BYTES = 64 * 1024;

export type AppliedFix =
    | { action: 'approve_host'; host: string; setupRequested: true }
    | { action: 'retry_setup'; setupRequested: true }
    | {
          action: RecipePrAction;
          pullRequest: { number: number; url: string };
      };

/** A Git platform failure (bad credentials, rate limit, outage) is a 503 the dev can act on, never a 500. */
export const gitCall = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
        return await call();
    } catch (e) {
        if (e instanceof HttpException) throw e;
        throw new ServiceUnavailableException('Kodus could not reach the Git platform for this repository. Check the Git integration and try again.');
    }
};

export { KODY_FIX_PREFIX };
/** What a PR of a fix Kody's learn loop proved says about where it came from (S-40). */
export const KODY_FIX_ORIGIN =
    "Where it came from: Kody's learn loop. An LLM chose this change from a fixed list of recipe fields, Kodus checked it against the failure log and set the value itself, and the app booted from zero with it on two clean machines. Kody never changes the allowed hosts or the setup commands.";

const branchSlug = (fixId: string) =>
    fixId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);

/**
 * POST /runtime/environments/:id/blockers/fixes, { signature, fixId } (docs §5;
 * the signature goes in the body: it carries ':' and '/'),
 * ADR-015). Applies one fix the catalog offers for that blocker, read again
 * here so a stale screen cannot apply something the catalog no longer says.
 * A one-click fix runs now (approve the host, set up again); a recipe fix
 * opens a PR on the default branch with the one-field change, read from the
 * current recipe there (never the setup's copy, which may be older). A fix the
 * dev makes by hand is refused: there is nothing for Kodus to apply.
 */
@Injectable()
export class ApplyBlockerFixUseCase {
    constructor(
        private readonly environment: GetRuntimeEnvironmentUseCase,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly products: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        private readonly setups: RuntimeSetupRequester,
        private readonly approveEgress: ApproveEgressUseCase,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string; signature: string; fixId: string }): Promise<AppliedFix> {
        if (typeof input.signature !== 'string' || input.signature.length > 512 || typeof input.fixId !== 'string' || input.fixId.length > 300) {
            throw new NotFoundException('Fix not found');
        }
        const { env, runs } = await this.environment.load(input.user, input.environmentId);
        const product = await this.products.get(env.organizationId, env.environmentId);
        if (!product || product.organizationId !== env.organizationId) throw new NotFoundException('Environment not found');
        await this.authorization.ensure({
            user: input.user,
            action: Action.Update,
            resource: ResourceType.RuntimeEnvironment,
            repoIds: [product.repositoryId],
        });

        const setup = await this.environment.setup(env);
        const group = blockerGroups(setup, runs).find((g) => g.signature === input.signature);
        const fix = group?.fixes.find((f) => f.id === input.fixId);
        if (!group || !fix) throw new NotFoundException('Fix not found');

        if (fix.action === 'approve_host' && fix.host) {
            await this.approveEgress.execute({
                user: input.user,
                environmentId: env.environmentId,
                host: fix.host,
            });
            await this.setups.request(product, input.user);
            return {
                action: 'approve_host',
                host: fix.host,
                setupRequested: true,
            };
        }
        if (fix.action === 'retry_setup') {
            await this.setups.request(product, input.user);
            return { action: 'retry_setup', setupRequested: true };
        }
        const change = group.recipeChanges.get(fix.id);
        if (isRecipePrAction(fix.action) && change && fix.recipeDiff) {
            return {
                action: fix.action,
                pullRequest: await this.openRecipePullRequest(
                    product,
                    setup?.recipe?.path ?? RECIPE_PATH,
                    fix.id,
                    fix.label,
                    change,
                    fix.id.startsWith(KODY_FIX_PREFIX) ? KODY_FIX_ORIGIN : undefined,
                ),
            };
        }
        throw new BadRequestException('This fix is made by hand in the repository; Kodus has nothing to apply.');
    }

    /** Also the /mcp/env env_fix path, after its own team-key checks (RuntimeEnvToolsService). */
    async openRecipePullRequest(
        product: {
            organizationId: string;
            teamId: string;
            repositoryId: string;
            repositoryName: string;
        },
        path: string,
        fixId: string,
        label: string,
        change: RecipeChange,
        /** Where the fix came from, said in the PR (S-40), when it is not the catalog. */
        origin?: string,
    ) {
        if (!this.git.openPullRequestWithFiles) throw new ServiceUnavailableException('Opening a pull request is not available for this repository.');
        const repo = {
            organizationId: product.organizationId,
            teamId: product.teamId,
            repositoryId: product.repositoryId,
            repositoryName: product.repositoryName,
        };
        const head = await gitCall(() => this.git.getDefaultBranchHead(repo));
        if (head.status !== 'ok') throw new ServiceUnavailableException('Kodus cannot read the default branch of this repository.');
        const text = await gitCall(() =>
            this.git.readFileAtCommit({
                ...repo,
                path,
                sha: head.sha,
                maxBytes: MAX_RECIPE_BYTES,
            }),
        );
        if (text === 'unsupported_platform') throw new ServiceUnavailableException('Kodus cannot read files on this platform yet.');
        if (text === null) throw new ConflictException(`There is no ${path} on ${head.branch} any more.`);
        const edit = applyRecipeChange(text, change, path);
        if ('error' in edit) throw new ConflictException(`The recipe on ${head.branch} changed: ${edit.error}.`);
        if (edit.text === text) throw new ConflictException(`The recipe on ${head.branch} already has this change.`);

        const body = [
            `Kody Runtime could not boot this repository, and this is the fix it suggests: **${label}**.`,
            '',
            'It changes one field of the recipe; nothing else in the file moves.',
            ...(origin ? ['', origin] : []),
            '',
            '```diff',
            edit.diff,
            '```',
            '',
            'The next setup after this is merged reads the new recipe. Never put a real secret in the recipe: the value here is a test value for the machine only.',
        ].join('\n');
        const pr = await gitCall(() =>
            this.git.openPullRequestWithFiles!({
                ...repo,
                baseBranch: head.branch,
                branch: `kody-runtime/fix-${branchSlug(fixId)}-${head.sha.slice(0, 7)}`,
                title: `chore(kody-runtime): ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
                body,
                commitMessage: `chore(kody-runtime): ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
                files: [{ path, content: edit.text }],
            }),
        );
        if (!pr) throw new ServiceUnavailableException('The Git platform refused the pull request.');
        return pr;
    }
}
