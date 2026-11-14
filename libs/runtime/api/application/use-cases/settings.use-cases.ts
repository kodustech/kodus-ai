import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import {
    RUNTIME_ORG_REPOSITORIES,
    RUNTIME_SETTINGS_STORE,
    RUNTIME_WHO_CAN_ASK,
    type RuntimeOrgRepositories,
    type RuntimeSettingsStore,
    type RuntimeWhoCanAsk,
    type RuntimeRepositorySettingsRecord,
} from '../../domain/ports';
import { parseTriggerRules, RUNTIME_MODES, type RuntimeMode, type TriggerRule } from '../../domain/trigger-rules';
import type { RuntimeAuthorization } from '../run-access.service';
import { CreateRuntimeEnvironmentUseCase } from './environments.use-cases';

export interface RuntimeRepositorySettingsView {
    repositoryId: string;
    repositoryName?: string;
    pilot: boolean;
    whoCanAsk: RuntimeWhoCanAsk;
    mode: RuntimeMode;
    rules: TriggerRule[];
    runOnAgentPullRequests: boolean;
    runOnNewPushes: boolean;
}

/** A row written before the mode existed: in the pilot = on request (doubt: the doc's pilot ran every PR). */
const modeOf = (s: RuntimeRepositorySettingsRecord | undefined): RuntimeMode => s?.mode ?? (s?.pilot ? 'on_request' : 'off');

export function repositorySettingsView(
    repo: { repositoryId: string; repositoryName?: string },
    stored: RuntimeRepositorySettingsRecord | undefined,
): RuntimeRepositorySettingsView {
    const mode = modeOf(stored);
    return {
        repositoryId: repo.repositoryId,
        ...(repo.repositoryName ? { repositoryName: repo.repositoryName } : {}),
        pilot: mode !== 'off',
        whoCanAsk: stored?.whoCanAsk ?? DEFAULT_WHO_CAN_ASK,
        mode,
        rules: stored?.rules ?? [],
        runOnAgentPullRequests: stored?.runOnAgentPullRequests ?? false,
        runOnNewPushes: stored?.runOnNewPushes ?? false,
    };
}

export interface RuntimeSettingsView {
    tokenBudgetPerDay: number | null;
    repositories: RuntimeRepositorySettingsView[];
}

export const DEFAULT_WHO_CAN_ASK: RuntimeWhoCanAsk = 'writers';
const MAX_TOKEN_BUDGET = 1_000_000_000_000;

const orgOf = (user: Partial<IUser>) => {
    const organizationId = user?.organization?.uuid;
    if (!organizationId) throw new NotFoundException('Organization not found');
    return organizationId;
};

/** GET /runtime/settings — the org budget and every connected repo, with defaults. */
@Injectable()
export class GetRuntimeSettingsUseCase {
    constructor(
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings: RuntimeSettingsStore,
        @Inject(RUNTIME_ORG_REPOSITORIES)
        private readonly repositories: RuntimeOrgRepositories,
    ) {}

    async execute(input: { user: Partial<IUser> }): Promise<RuntimeSettingsView> {
        const organizationId = orgOf(input.user);
        const [org, stored, connected] = await Promise.all([
            this.settings.getOrganization(organizationId),
            this.settings.listRepositories(organizationId),
            this.repositories.list(organizationId),
        ]);
        const byId = new Map(stored.map((s) => [s.repositoryId, s]));
        return {
            tokenBudgetPerDay: org?.tokenBudgetPerDay ?? null,
            // A repo that left the integration keeps its row but is not listed.
            repositories: connected.repositories.map((r) => repositorySettingsView(r, byId.get(r.repositoryId))),
        };
    }
}

/** PATCH /runtime/settings { tokenBudgetPerDay: positive integer | null } — org admin. */
@Injectable()
export class UpdateRuntimeOrgSettingsUseCase {
    constructor(
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings: RuntimeSettingsStore,
        private readonly read: GetRuntimeSettingsUseCase,
    ) {}

    async execute(input: { user: Partial<IUser>; body: unknown }): Promise<RuntimeSettingsView> {
        const organizationId = orgOf(input.user);
        const body = (input.body ?? {}) as Record<string, unknown>;
        if (!('tokenBudgetPerDay' in body)) throw new BadRequestException('tokenBudgetPerDay is required');
        const v = body.tokenBudgetPerDay;
        if (v !== null && !(typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MAX_TOKEN_BUDGET)) {
            throw new BadRequestException('tokenBudgetPerDay must be a positive integer or null');
        }
        await this.settings.setTokenBudget(organizationId, v as number | null);
        return this.read.execute({ user: input.user });
    }
}

/**
 * PUT /runtime/settings/repositories/:repositoryId { mode?, rules?,
 * runOnAgentPullRequests?, runOnNewPushes?, whoCanAsk?, pilot? } — the repo
 * must be connected to the org (another org's repo is 404). Leaving `off`
 * (or `pilot: true`) creates the repo's environment and asks for its setup.
 * `pilot` is the old switch: true keeps the mode (or `on_request`), false is `off`.
 */
@Injectable()
export class UpdateRuntimeRepositorySettingsUseCase {
    constructor(
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings: RuntimeSettingsStore,
        @Inject(RUNTIME_ORG_REPOSITORIES)
        private readonly repositories: RuntimeOrgRepositories,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        private readonly createEnvironment: CreateRuntimeEnvironmentUseCase,
    ) {}

    async execute(input: { user: Partial<IUser>; repositoryId: string; body: unknown }): Promise<RuntimeRepositorySettingsView> {
        const organizationId = orgOf(input.user);
        const body = (input.body ?? {}) as Record<string, unknown>;
        const { pilot, whoCanAsk, mode, rules, runOnAgentPullRequests, runOnNewPushes } = body;
        if (pilot !== undefined && typeof pilot !== 'boolean') throw new BadRequestException('pilot must be a boolean');
        if (whoCanAsk !== undefined && !(RUNTIME_WHO_CAN_ASK as readonly unknown[]).includes(whoCanAsk)) {
            throw new BadRequestException(`whoCanAsk must be one of: ${RUNTIME_WHO_CAN_ASK.join(', ')}`);
        }
        if (mode !== undefined && !(RUNTIME_MODES as readonly unknown[]).includes(mode)) {
            throw new BadRequestException(`mode must be one of: ${RUNTIME_MODES.join(', ')}`);
        }
        if (mode !== undefined && pilot !== undefined) throw new BadRequestException('send mode or pilot, not both');
        for (const [name, v] of Object.entries({ runOnAgentPullRequests, runOnNewPushes })) {
            if (v !== undefined && typeof v !== 'boolean') throw new BadRequestException(`${name} must be a boolean`);
        }
        let parsedRules: TriggerRule[] | undefined;
        if (rules !== undefined) {
            const parsed = parseTriggerRules(rules);
            if (parsed.ok === false) throw new BadRequestException(parsed.error);
            parsedRules = parsed.rules;
        }
        if ([pilot, whoCanAsk, mode, rules, runOnAgentPullRequests, runOnNewPushes].every((v) => v === undefined)) {
            throw new BadRequestException('nothing to update');
        }

        const { repositories } = await this.repositories.list(organizationId);
        const repo = repositories.find((r) => r.repositoryId === input.repositoryId);
        if (!repo) throw new NotFoundException('Repository not found');
        await this.authorization.ensure({
            user: input.user,
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
            repoIds: [repo.repositoryId],
        });

        const current = (await this.settings.listRepositories(organizationId)).find((s) => s.repositoryId === repo.repositoryId);
        const was = repositorySettingsView(repo, current);
        const nextMode: RuntimeMode =
            (mode as RuntimeMode | undefined) ?? (pilot === undefined ? was.mode : pilot ? (was.mode === 'off' ? 'on_request' : was.mode) : 'off');
        const next: RuntimeRepositorySettingsRecord = {
            repositoryId: repo.repositoryId,
            pilot: nextMode !== 'off',
            whoCanAsk: (whoCanAsk as RuntimeWhoCanAsk | undefined) ?? was.whoCanAsk,
            mode: nextMode,
            rules: parsedRules ?? was.rules,
            runOnAgentPullRequests: (runOnAgentPullRequests as boolean | undefined) ?? was.runOnAgentPullRequests,
            runOnNewPushes: (runOnNewPushes as boolean | undefined) ?? was.runOnNewPushes,
        };
        await this.settings.upsertRepository(organizationId, next);
        if (next.pilot && !was.pilot) {
            await this.createEnvironment.execute({ user: input.user, repositoryId: repo.repositoryId });
        }
        return repositorySettingsView(repo, next);
    }
}
