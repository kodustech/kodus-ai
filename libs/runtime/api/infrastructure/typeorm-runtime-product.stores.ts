import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { createLogger } from '@libs/core/log/logger';
import { isMachineSizePreset, type MachineSizePreset } from '@libs/runtime/contracts/machine-size';

import {
    RUNTIME_WHO_CAN_ASK,
    type FindingFeedbackRecord,
    type FindingFeedbackStore,
    type FindingIntentRecord,
    type FindingIntentStore,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeRepositorySettingsRecord,
    type RuntimeSettingsStore,
    type RuntimeWhoCanAsk,
} from '../domain/ports';
import type { ForkPullRequestPolicy } from '@libs/runtime/contracts/enums';
import { forkPolicyOf } from '../domain/fork-policy';
import type { PoolPolicy, PoolUsage } from '../domain/pool';
import { parseTriggerRules, RUNTIME_MODES, type RuntimeMode } from '../domain/trigger-rules';
import {
    RuntimeEnvironmentModel,
    RuntimeFindingFeedbackModel,
    RuntimeFindingIntentModel,
    RuntimeRepositorySettingsModel,
    RuntimeSettingsModel,
} from './runtime-product.models';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toEnvironment = (m: RuntimeEnvironmentModel): ProductEnvironment => ({
    environmentId: m.uuid,
    organizationId: m.organizationId,
    teamId: m.teamId,
    repositoryId: m.repositoryId,
    repositoryName: m.repositoryName,
    state: m.state,
    ...(m.setupRequestedAt ? { setupRequestedAt: new Date(m.setupRequestedAt).toISOString() } : {}),
    diagnosticHold: m.diagnosticHold === true,
    poolSize: m.poolSize ?? null,
    // A value no preset names any more reads as the cell's default.
    machineSize: isMachineSizePreset(m.machineSize) ? m.machineSize : null,
    // A value no policy names any more reads as the safe default.
    forkPullRequests: forkPolicyOf(m.forkPullRequests),
    poolPolicy: m.poolPolicy ?? null,
    poolActivityAt: m.poolActivityAt ? new Date(m.poolActivityAt).toISOString() : null,
    poolAppliedSize: m.poolAppliedSize ?? null,
    poolUsage: m.poolUsage ?? null,
    createdAt: new Date(m.createdAt).toISOString(),
    updatedAt: new Date(m.updatedAt).toISOString(),
});

@Injectable()
export class TypeOrmProductEnvironmentStore implements ProductEnvironmentStore {
    constructor(
        @InjectRepository(RuntimeEnvironmentModel)
        private readonly repo: Repository<RuntimeEnvironmentModel>,
    ) {}

    async listByOrganization(organizationId: string) {
        return (await this.repo.find({ where: { organizationId }, order: { createdAt: 'DESC' }, take: 500 })).map(toEnvironment);
    }

    async get(organizationId: string, environmentId: string) {
        // Ids that only the Run projection knows are not uuids; do not hand them to Postgres.
        if (!UUID.test(environmentId)) return null;
        const m = await this.repo.findOne({ where: { uuid: environmentId, organizationId } });
        return m ? toEnvironment(m) : null;
    }

    async findByRepository(organizationId: string, repositoryId: string) {
        const m = await this.repo.findOne({ where: { organizationId, repositoryId } });
        return m ? toEnvironment(m) : null;
    }

    async create(input: Omit<ProductEnvironment, 'environmentId' | 'createdAt' | 'updatedAt' | 'state' | 'setupRequestedAt'>) {
        await this.repo
            .createQueryBuilder()
            .insert()
            // Not active until a setup says so: the requester marks it setup_requested next.
            .values({ ...input, state: 'setup_requested' })
            .orIgnore()
            .execute();
        return (await this.findByRepository(input.organizationId, input.repositoryId))!;
    }

    async markSetupRequested(organizationId: string, environmentId: string, at: Date) {
        await this.repo.update({ uuid: environmentId, organizationId }, { state: 'setup_requested', setupRequestedAt: at });
    }

    async setDiagnosticHold(organizationId: string, environmentId: string, on: boolean) {
        await this.repo.update({ uuid: environmentId, organizationId }, { diagnosticHold: on });
    }

    async setPoolSize(organizationId: string, environmentId: string, size: number | null) {
        await this.repo.update({ uuid: environmentId, organizationId }, { poolSize: size });
    }

    async setMachineSize(organizationId: string, environmentId: string, size: MachineSizePreset | null) {
        await this.repo.update({ uuid: environmentId, organizationId }, { machineSize: size });
    }

    async setForkPullRequests(organizationId: string, environmentId: string, policy: ForkPullRequestPolicy) {
        await this.repo.update({ uuid: environmentId, organizationId }, { forkPullRequests: policy });
    }

    async setPoolPolicy(organizationId: string, environmentId: string, policy: PoolPolicy | null) {
        await this.repo.update({ uuid: environmentId, organizationId }, { poolPolicy: policy });
    }

    async markPoolActivity(organizationId: string, environmentId: string, at: Date) {
        await this.repo.update({ uuid: environmentId, organizationId }, { poolActivityAt: at });
    }

    async setPoolApplied(organizationId: string, environmentId: string, size: number, usage: PoolUsage) {
        await this.repo.update({ uuid: environmentId, organizationId }, { poolAppliedSize: size, poolUsage: usage });
    }

    async listPoolManagedAcrossOrganizations(limit: number) {
        const rows = await this.repo
            .createQueryBuilder('e')
            .where('e.pool_policy IS NOT NULL OR e.pool_applied_size > 0')
            // updatedAt is CoreModel's camelCase column ("updatedAt"), unlike this model's snake_case ones: name the property.
            .orderBy('e.updatedAt', 'ASC')
            .limit(limit)
            .getMany();
        return rows.map(toEnvironment);
    }
}

@Injectable()
export class TypeOrmRuntimeSettingsStore implements RuntimeSettingsStore {
    private readonly logger = createLogger(TypeOrmRuntimeSettingsStore.name);

    constructor(
        @InjectRepository(RuntimeSettingsModel)
        private readonly org: Repository<RuntimeSettingsModel>,
        @InjectRepository(RuntimeRepositorySettingsModel)
        private readonly repos: Repository<RuntimeRepositorySettingsModel>,
    ) {}

    async getOrganization(organizationId: string) {
        const m = await this.org.findOne({ where: { organizationId } });
        return m ? { tokenBudgetPerDay: m.tokenBudgetPerDay === null ? null : Number(m.tokenBudgetPerDay) } : null;
    }

    async setTokenBudget(organizationId: string, tokenBudgetPerDay: number | null) {
        await this.org.upsert(
            { organizationId, tokenBudgetPerDay: tokenBudgetPerDay === null ? null : String(tokenBudgetPerDay) },
            { conflictPaths: ['organizationId'] },
        );
    }

    async listRepositories(organizationId: string): Promise<RuntimeRepositorySettingsRecord[]> {
        return (await this.repos.find({ where: { organizationId }, take: 5_000 })).map((m) => {
            // A stored rule that no longer parses is dropped rather than failing the settings page, and said.
            const rules = parseTriggerRules(m.rules ?? []);
            if (rules.ok === false) {
                this.logger.warn({
                    message: 'Runtime trigger rules no longer parse; the repository runs on no rule',
                    context: TypeOrmRuntimeSettingsStore.name,
                    metadata: { organizationId, repositoryId: m.repositoryId, error: rules.error },
                });
            }
            return {
                repositoryId: m.repositoryId,
                pilot: m.pilot,
                whoCanAsk: (RUNTIME_WHO_CAN_ASK as readonly string[]).includes(m.whoCanAsk) ? (m.whoCanAsk as RuntimeWhoCanAsk) : 'writers',
                ...((RUNTIME_MODES as readonly string[]).includes(m.mode ?? '') ? { mode: m.mode as RuntimeMode } : {}),
                rules: rules.ok ? rules.rules : [],
                runOnAgentPullRequests: m.runOnAgentPullRequests ?? false,
                runOnNewPushes: m.runOnNewPushes ?? false,
            };
        });
    }

    async upsertRepository(organizationId: string, s: RuntimeRepositorySettingsRecord) {
        await this.repos.upsert(
            {
                organizationId,
                repositoryId: s.repositoryId,
                pilot: s.pilot,
                whoCanAsk: s.whoCanAsk,
                ...(s.mode ? { mode: s.mode } : {}),
                ...(s.rules ? { rules: s.rules } : {}),
                ...(s.runOnAgentPullRequests !== undefined ? { runOnAgentPullRequests: s.runOnAgentPullRequests } : {}),
                ...(s.runOnNewPushes !== undefined ? { runOnNewPushes: s.runOnNewPushes } : {}),
            },
            { conflictPaths: ['organizationId', 'repositoryId'] },
        );
    }
}

@Injectable()
export class TypeOrmFindingFeedbackStore implements FindingFeedbackStore {
    constructor(
        @InjectRepository(RuntimeFindingFeedbackModel)
        private readonly repo: Repository<RuntimeFindingFeedbackModel>,
    ) {}

    async listForRun(organizationId: string, runId: string): Promise<FindingFeedbackRecord[]> {
        return (await this.repo.find({ where: { organizationId, runId }, take: 5_000 })).map((m) => ({
            organizationId: m.organizationId,
            runId: m.runId,
            probeId: m.probeId,
            userId: m.userId,
            value: m.value,
            updatedAt: (m.updatedAt instanceof Date ? m.updatedAt : new Date(m.updatedAt)).toISOString(),
        }));
    }

    async set(input: Parameters<FindingFeedbackStore['set']>[0]) {
        const where = { organizationId: input.organizationId, runId: input.runId, probeId: input.probeId, userId: input.userId };
        if (input.value === null) {
            await this.repo.delete(where);
            return;
        }
        await this.repo.upsert({ ...where, value: input.value }, { conflictPaths: ['runId', 'probeId', 'userId'] });
    }
}

export class TypeOrmFindingIntentStore implements FindingIntentStore {
    constructor(
        @InjectRepository(RuntimeFindingIntentModel)
        private readonly repo: Repository<RuntimeFindingIntentModel>,
    ) {}

    async listForRun(organizationId: string, runId: string): Promise<FindingIntentRecord[]> {
        return (await this.repo.find({ where: { organizationId, runId }, take: 1_000 })).map((m) => ({
            organizationId: m.organizationId,
            runId: m.runId,
            probeId: m.probeId,
            userId: m.userId,
            markedAt: (m.updatedAt instanceof Date ? m.updatedAt : new Date(m.updatedAt)).toISOString(),
        }));
    }

    async set(input: Parameters<FindingIntentStore['set']>[0]) {
        const where = { organizationId: input.organizationId, runId: input.runId, probeId: input.probeId };
        if (!input.intended) {
            await this.repo.delete(where);
            return;
        }
        await this.repo.upsert({ ...where, userId: input.userId, updatedAt: new Date() }, { conflictPaths: ['runId', 'probeId'] });
    }
}
