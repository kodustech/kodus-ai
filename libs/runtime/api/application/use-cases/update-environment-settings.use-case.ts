import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { isForkPullRequestPolicy } from '@libs/runtime/contracts/enums';
import { isMachineSizePreset, type MachineSizePreset } from '@libs/runtime/contracts/machine-size';

import { MachineSizeAbovePlanError, parseMachineSizeSetting } from '../../domain/machine-size-plan';
import { InvalidPoolPolicyError, InvalidPoolSizeError, parsePoolPolicy, parsePoolSetting, type PoolPolicy } from '../../domain/pool';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
} from '../../domain/ports';
import type { RuntimeAuthorization } from '../run-access.service';
import { RuntimePoolController } from '../pool-controller.service';
import { orgOf, validId } from './environment-view';

/**
 * PATCH /runtime/environments/:id/settings — the org admin's settings of one
 * environment: the diagnostic hold (§11 runbook; only ever a failed setup of
 * the default branch, never a PR), the machine size (a preset, or null for
 * the cell's default; it applies from the next setup), what a PR from a
 * fork does (ADR-030; skip, require_approval or run) and the warm pool size
 * (a whole number up to the plan's ceiling, or null for the plan's default).
 * A pool change goes to the Runtime through the outbox: the worker asks the
 * environment's cell.
 */
const SETTINGS_KEYS: readonly string[] = ['diagnosticHold', 'machineSize', 'forkPullRequests', 'poolSize', 'poolPolicy'];

@Injectable()
export class UpdateEnvironmentSettingsUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'pool' | 'machineSize'>,
        private readonly pool: RuntimePoolController,
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
        } | null;
        const keys = body ? Object.keys(body) : [];
        if (
            !keys.length ||
            keys.some((k) => !SETTINGS_KEYS.includes(k)) ||
            ('diagnosticHold' in body! && typeof body!.diagnosticHold !== 'boolean') ||
            ('machineSize' in body! && body!.machineSize !== null && !isMachineSizePreset(body!.machineSize)) ||
            ('forkPullRequests' in body! && !isForkPullRequestPolicy(body!.forkPullRequests))
        ) {
            throw new BadRequestException(
                "Body must be { diagnosticHold?: boolean, machineSize?: 'small' | 'medium' | 'large' | null, forkPullRequests?: 'skip' | 'require_approval' | 'run', poolSize?: number | null, poolPolicy?: object | null }",
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
        await this.authorization.ensure({ user: input.user, action: Action.Manage, resource: ResourceType.RuntimeEnvironment, repoIds: [env.repositoryId] });
        const out: ProductEnvironment = { ...env };
        if (typeof body!.diagnosticHold === 'boolean') {
            await this.environments.setDiagnosticHold(organizationId, env.environmentId, body!.diagnosticHold);
            out.diagnosticHold = body!.diagnosticHold;
        }
        if (machineSize !== undefined) {
            await this.environments.setMachineSize(organizationId, env.environmentId, machineSize);
            out.machineSize = machineSize;
        }
        if (isForkPullRequestPolicy(body!.forkPullRequests)) {
            await this.environments.setForkPullRequests(organizationId, env.environmentId, body!.forkPullRequests);
            out.forkPullRequests = body!.forkPullRequests;
        }
        if (poolSize !== undefined) {
            await this.environments.setPoolSize(organizationId, env.environmentId, poolSize);
            out.poolSize = poolSize;
        }
        if (poolPolicy !== undefined) {
            await this.environments.setPoolPolicy(organizationId, env.environmentId, poolPolicy);
            out.poolPolicy = poolPolicy;
        }
        if (poolSize !== undefined || poolPolicy !== undefined) {
            // The size the policy wants now goes to the cell; the scheduler keeps it there.
            const requestedBy = { userId: input.user.uuid!, ...(input.user.email ? { email: input.user.email } : {}) };
            const decision = await this.pool.apply(out, { force: true, requestedBy });
            out.poolAppliedSize = decision.size;
        }
        return out;
    }
}
