import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { isForkPullRequestPolicy } from '@libs/runtime/contracts/enums';
import { isMachineSizePreset, type MachineSizePreset } from '@libs/runtime/contracts/machine-size';
import { PREVIEW_SECRETS } from '@libs/runtime/contracts/preview';

import { MachineSizeAbovePlanError, parseMachineSizeSetting } from '../../domain/machine-size-plan';
import { InvalidPoolPolicyError, InvalidPoolSizeError, parsePoolPolicy, parsePoolSetting, type PoolPolicy } from '../../domain/pool';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type ProductEnvironment,
    type ProductEnvironmentSettings,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
} from '../../domain/ports';
import { environmentRepositoryIds, RuntimeEnvironmentMembers } from '../environment-members.service';
import type { RuntimeAuthorization } from '../run-access.service';
import { RuntimePoolController } from '../pool-controller.service';
import { RuntimeSuiteSelection } from '../suite-selection.service';
import { orgOf, validId } from './environment-view';

/**
 * PATCH /runtime/environments/:id/settings — the org admin's settings of one
 * environment: the diagnostic hold (only ever a failed setup of
 * the default branch, never a PR), the machine size (a preset, or null for
 * the cell's default; it applies from the next setup), what a PR from a
 * fork does (skip, require_approval or run) and the warm pool size
 * (a whole number up to the plan's ceiling, or null for the plan's default).
 * A pool change goes to the Runtime through the outbox: the worker asks the
 * environment's cell.
 *
 * The e2e suite (docs/runtime/e2e-suites.md section 13): `suiteCi` (run on every
 * push as a CI check; null follows the deployment's default) is this
 * environment's own setting. `suiteSelection` (run only the specs the change
 * reaches) is the Runtime's state, so it goes through the outbox and is never a
 * product column. The suite's gate and shard ceiling are the recipe's
 * (`suite.gate`, `suite.shards`): read-only in Settings, edited in the file.
 */
const SETTINGS_KEYS: readonly string[] = ['diagnosticHold', 'machineSize', 'forkPullRequests', 'poolSize', 'poolPolicy', 'previewSecrets', 'suiteCi', 'suiteSelection'];

@Injectable()
export class UpdateEnvironmentSettingsUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization & Partial<Pick<AuthorizationService, 'check'>>,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'pool' | 'machineSize'>,
        private readonly pool: RuntimePoolController,
        // Required by Nest; made without it (the older tests), only the environment's own repository is checked.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
        // Without it (the older tests) the selection switch is refused.
        @Optional() @Inject(RuntimeSuiteSelection)
        private readonly suiteSelection?: RuntimeSuiteSelection,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string; body: unknown }): Promise<ProductEnvironment> {
        const organizationId = orgOf(input.user);
        const env = validId(input.environmentId) ? await this.environments.get(organizationId, input.environmentId) : null;
        if (!env || env.organizationId !== organizationId) throw new NotFoundException('Environment not found');
        const raw = input.body as Record<string, unknown> | null;
        // A field set to undefined was not sent (a validated DTO carries every declared field).
        const body = (raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) : null) as {
            diagnosticHold?: unknown;
            machineSize?: unknown;
            forkPullRequests?: unknown;
            poolSize?: unknown;
            poolPolicy?: unknown;
            previewSecrets?: unknown;
            suiteCi?: unknown;
            suiteSelection?: unknown;
        } | null;
        const keys = body ? Object.keys(body) : [];
        if (
            !keys.length ||
            keys.some((k) => !SETTINGS_KEYS.includes(k)) ||
            ('diagnosticHold' in body! && typeof body!.diagnosticHold !== 'boolean') ||
            ('machineSize' in body! && body!.machineSize !== null && !isMachineSizePreset(body!.machineSize)) ||
            ('forkPullRequests' in body! && !isForkPullRequestPolicy(body!.forkPullRequests)) ||
            ('previewSecrets' in body! && !(PREVIEW_SECRETS as readonly unknown[]).includes(body!.previewSecrets)) ||
            ('suiteCi' in body! && body!.suiteCi !== null && typeof body!.suiteCi !== 'boolean') ||
            ('suiteSelection' in body! && typeof body!.suiteSelection !== 'boolean')
        ) {
            throw new BadRequestException(
                "Body must be { diagnosticHold?: boolean, machineSize?: 'small' | 'medium' | 'large' | null, forkPullRequests?: 'skip' | 'require_approval' | 'run', poolSize?: number | null, poolPolicy?: object | null, previewSecrets?: 'none' | 'run', suiteCi?: boolean | null, suiteSelection?: boolean }",
            );
        }
        let poolPolicy: PoolPolicy | null | undefined;
        if ('poolPolicy' in body!) {
            try {
                poolPolicy = parsePoolPolicy(body!.poolPolicy);
            } catch (e) {
                if (e instanceof InvalidPoolPolicyError) throw new BadRequestException(e.message);
                throw e;
            }
        }
        let machineSize: MachineSizePreset | null | undefined;
        if ('machineSize' in body!) {
            try {
                machineSize = parseMachineSizeSetting(this.config.machineSize, (body!.machineSize ?? null) as MachineSizePreset | null);
            } catch (e) {
                // A 400 like the pool's ceiling: the web shows the API's sentence (a 403 it replaces with its own).
                if (e instanceof MachineSizeAbovePlanError) throw new BadRequestException(e.message);
                throw e;
            }
        }
        let poolSize: number | null | undefined;
        if ('poolSize' in body!) {
            try {
                poolSize = parsePoolSetting(this.config.pool, body!.poolSize);
            } catch (e) {
                if (e instanceof InvalidPoolSizeError) throw new BadRequestException(e.message);
                throw e;
            }
        }
        await this.authorization.ensure({ user: input.user, action: Action.Manage, resource: ResourceType.RuntimeEnvironment, repoIds: await environmentRepositoryIds(this.members, env) });
        // The org's secrets in previews: an owner's call (Manage on RuntimePreview), never a repo admin's (decision 4).
        if ('previewSecrets' in body! && !(await this.authorization.check?.({ user: input.user, action: Action.Manage, resource: ResourceType.RuntimePreview }))) {
            throw new ForbiddenException("Only an owner can let this environment's previews use the organization's secrets.");
        }
        const settings: ProductEnvironmentSettings = {
            ...(typeof body!.diagnosticHold === 'boolean' ? { diagnosticHold: body!.diagnosticHold } : {}),
            ...(machineSize !== undefined ? { machineSize } : {}),
            ...(isForkPullRequestPolicy(body!.forkPullRequests) ? { forkPullRequests: body!.forkPullRequests } : {}),
            ...(poolSize !== undefined ? { poolSize } : {}),
            ...(poolPolicy !== undefined ? { poolPolicy } : {}),
            ...(body!.previewSecrets === 'none' || body!.previewSecrets === 'run' ? { previewSecrets: body!.previewSecrets } : {}),
            ...('suiteCi' in body! ? { suiteCi: body!.suiteCi as boolean | null } : {}),
        };
        if (typeof body!.suiteSelection === 'boolean' && !this.suiteSelection) throw new BadRequestException('Spec selection cannot be changed here');
        await this.environments.updateSettings(organizationId, env.environmentId, settings);
        if (typeof body!.suiteSelection === 'boolean') {
            // The Runtime's state: asked through the outbox, never written from here.
            await this.suiteSelection!.set({ user: input.user, organizationId, environmentId: env.environmentId, selection: body!.suiteSelection ? 'on' : 'off' });
        }
        const out: ProductEnvironment = { ...env, ...settings };
        if (poolSize !== undefined || poolPolicy !== undefined) {
            // The size the policy wants now goes to the cell; the scheduler keeps it there.
            const requestedBy = { userId: input.user.uuid!, ...(input.user.email ? { email: input.user.email } : {}) };
            const decision = await this.pool.apply(out, { force: true, requestedBy });
            out.poolAppliedSize = decision.size;
        }
        return out;
    }
}
