import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { IOutboxMessageRepository, OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';
import { PARTLY_TESTED_CHECKS, type PartlyTestedCheck } from '@libs/runtime/contracts/enums';
import { DEFAULT_EXERCISED_LINES_THRESHOLD_PERCENT } from '@libs/runtime/contracts/limits';
import { DEFAULT_MACHINE_MINUTES_PER_ORG_DAY, MAX_ORG_MACHINE_MINUTES_PER_DAY } from '@libs/runtime/environment/machine-minutes';

import { machineMinutesToday, type RuntimeMachineMinutesToday } from '../../domain/machine-minutes-today';
import { MAX_USD_PER_HOST_HOUR } from '../../domain/run-cost';
import {
    type Clock,
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_MACHINE_USAGE_READER,
    RUNTIME_ORG_REPOSITORIES,
    RUNTIME_SETTINGS_STORE,
    type RuntimeApiConfig,
    type RuntimeMachineUsageReader,
    RUNTIME_WHO_CAN_ASK,
    type RuntimeOrgRepositories,
    type RuntimeSettingsStore,
    type RuntimeWhoCanAsk,
    type RuntimeRepositorySettingsRecord,
} from '../../domain/ports';
import { parseTriggerRules, RUNTIME_MODES, type RuntimeMode, type TriggerRule } from '../../domain/trigger-rules';
import type { RuntimeAuthorization } from '../run-access.service';
import { CreateRuntimeEnvironmentUseCase } from './environments.use-cases';
import type { RuntimeRepositorySettingsView, RuntimeSettingsView } from '@libs/runtime/contracts/views/settings';

// The views live in contracts/views/settings.ts (the web imports them too); re-exported for the callers that imported them from here.
export type { RuntimeRepositorySettingsView, RuntimeSettingsView };

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

export const DEFAULT_WHO_CAN_ASK: RuntimeWhoCanAsk = 'writers';
const MAX_TOKEN_BUDGET = 1_000_000_000_000;

const orgOf = (user: Partial<IUser>) => {
    const organizationId = user?.organization?.uuid;
    if (!organizationId) throw new NotFoundException('Organization not found');
    return organizationId;
};

/** GET /runtime/settings — the org budget, the exercised-lines threshold and every connected repo, with defaults. */
@Injectable()
export class GetRuntimeSettingsUseCase {
    constructor(
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings: RuntimeSettingsStore,
        @Inject(RUNTIME_ORG_REPOSITORIES)
        private readonly repositories: RuntimeOrgRepositories,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'exercisedLinesThresholdPercent'>,
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
            exercisedLinesThresholdPercent: org?.exercisedLinesThresholdPercent ?? null,
            exercisedLinesThresholdDefaultPercent: this.config.exercisedLinesThresholdPercent ?? DEFAULT_EXERCISED_LINES_THRESHOLD_PERCENT,
            machineUsdPerHostHour: org?.machineUsdPerHostHour ?? null,
            partlyTestedCheck: org?.partlyTestedCheck ?? null,
            // A repo that left the integration keeps its row but is not listed.
            repositories: connected.repositories.map((r) => repositorySettingsView(r, byId.get(r.repositoryId))),
        };
    }
}

/**
 * GET /runtime/settings/machine-minutes — the caller's org machine minutes of
 * the current UTC day, as the hub counts them (runtime_machine_usage). 503
 * without the Runtime's read-only URL: zero would read as "nothing used".
 */
@Injectable()
export class GetRuntimeMachineMinutesUseCase {
    constructor(
        @Inject(RUNTIME_MACHINE_USAGE_READER)
        private readonly usage: RuntimeMachineUsageReader,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly clock: Clock,
    ) {}

    async execute(input: { user: Partial<IUser> }): Promise<RuntimeMachineMinutesToday> {
        const organizationId = orgOf(input.user);
        const today = await this.usage.today(organizationId);
        if (!today) throw new ServiceUnavailableException('Runtime machine minutes are not readable on this deployment');
        return machineMinutesToday(today, this.config.machineMinutesPerOrgDay ?? DEFAULT_MACHINE_MINUTES_PER_ORG_DAY, this.clock());
    }
}

/**
 * PATCH /runtime/settings/machine-minutes { minutesPerDay: positive integer | null } — org admin (spec v18 PR 2).
 * The org's own daily machine minutes lower the deployment's RUNTIME_MACHINE_MINUTES_PER_ORG_DAY, never raise it;
 * null goes back to the deployment's. It reaches the hub as runtime.org.machine_minutes_changed (the Runtime
 * Postgres is the hub's; the API only reads it), so the hub applies it from the next claim round.
 */
@Injectable()
export class UpdateRuntimeMachineMinutesUseCase {
    constructor(
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
        @Inject(RUNTIME_CLOCK)
        private readonly clock: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; body: unknown }): Promise<{ minutesPerDay: number | null; changedAt: string }> {
        const organizationId = orgOf(input.user);
        const v = ((input.body ?? {}) as Record<string, unknown>).minutesPerDay;
        if (v !== null && !(typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MAX_ORG_MACHINE_MINUTES_PER_DAY)) {
            throw new BadRequestException(`minutesPerDay must be a whole number of minutes from 1 to ${MAX_ORG_MACHINE_MINUTES_PER_DAY}, or null`);
        }
        const changedAt = this.clock().toISOString();
        const key = `machine-minutes:${organizationId}:${changedAt}`;
        const changedBy = { userId: input.user.uuid!, ...(input.user.email ? { email: input.user.email } : {}) };
        await this.outbox.create(
            runtimeCommandOutboxMessage(RuntimeCommandName.MachineMinutesChanged, { organizationId, minutesPerDay: v as number | null, changedBy, changedAt, key }, key),
        );
        return { minutesPerDay: v as number | null, changedAt };
    }
}

/**
 * PATCH /runtime/settings { tokenBudgetPerDay?: positive integer | null, exercisedLinesThresholdPercent?: 0..100 | null,
 * machineUsdPerHostHour?: US$ above 0 up to MAX_USD_PER_HOST_HOUR | null, partlyTestedCheck?: action_required | neutral
 * | null } — org admin. A field left out is kept; at least one is required. The threshold and the partly tested check
 * reach a Run in its request (RuntimeRunRequestBuilder), so a Run already asked keeps the values it started with. The
 * host price is read when a cost is shown, so it prices past Runs too.
 */
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
        const hasBudget = 'tokenBudgetPerDay' in body;
        const hasThreshold = 'exercisedLinesThresholdPercent' in body;
        const hasHostPrice = 'machineUsdPerHostHour' in body;
        const hasPartlyTested = 'partlyTestedCheck' in body;
        if (!hasBudget && !hasThreshold && !hasHostPrice && !hasPartlyTested) {
            throw new BadRequestException('tokenBudgetPerDay, exercisedLinesThresholdPercent, machineUsdPerHostHour or partlyTestedCheck is required');
        }
        const budget = body.tokenBudgetPerDay;
        if (hasBudget && budget !== null && !(typeof budget === 'number' && Number.isInteger(budget) && budget > 0 && budget <= MAX_TOKEN_BUDGET)) {
            throw new BadRequestException('tokenBudgetPerDay must be a positive integer or null');
        }
        const threshold = body.exercisedLinesThresholdPercent;
        if (hasThreshold && threshold !== null && !(typeof threshold === 'number' && Number.isInteger(threshold) && threshold >= 0 && threshold <= 100)) {
            throw new BadRequestException('exercisedLinesThresholdPercent must be a whole number from 0 to 100, or null');
        }
        const hostPrice = body.machineUsdPerHostHour;
        if (hasHostPrice && hostPrice !== null && !(typeof hostPrice === 'number' && Number.isFinite(hostPrice) && hostPrice > 0 && hostPrice <= MAX_USD_PER_HOST_HOUR)) {
            throw new BadRequestException(`machineUsdPerHostHour must be a US$ amount above 0 and at most ${MAX_USD_PER_HOST_HOUR}, or null`);
        }
        const partlyTested = body.partlyTestedCheck;
        if (hasPartlyTested && partlyTested !== null && !(PARTLY_TESTED_CHECKS as readonly unknown[]).includes(partlyTested)) {
            throw new BadRequestException(`partlyTestedCheck must be one of ${PARTLY_TESTED_CHECKS.join(', ')}, or null`);
        }
        if (hasBudget) await this.settings.setTokenBudget(organizationId, budget as number | null);
        if (hasThreshold) await this.settings.setExercisedLinesThreshold(organizationId, threshold as number | null);
        if (hasHostPrice) await this.settings.setMachineUsdPerHostHour(organizationId, hostPrice as number | null);
        if (hasPartlyTested) await this.settings.setPartlyTestedCheck(organizationId, partlyTested as PartlyTestedCheck | null);
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
