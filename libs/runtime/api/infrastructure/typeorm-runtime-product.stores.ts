import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { createLogger } from '@libs/core/log/logger';
import { PARTLY_TESTED_CHECKS, type PartlyTestedCheck } from '@libs/runtime/contracts/enums';
import { isMachineSizePreset } from '@libs/runtime/contracts/machine-size';
import { type PreviewSettings, PreviewSettingsSchema, previewSettingsOf } from '@libs/runtime/contracts/preview';
import { MAX_WORKSPACE_REPOSITORIES, REPOSITORY_ALIAS_PATTERN } from '@libs/runtime/contracts/workspace';

import {
    EnvironmentRepositoryConflictError,
    RUNTIME_WHO_CAN_ASK,
    type AutomaticRepositoriesReader,
    type AutomaticRepositoryRow,
    type EnvironmentRepository,
    type EnvironmentRepositoryPatch,
    type EnvironmentRepositoryStore,
    type FindingFeedbackRecord,
    type FindingFeedbackStore,
    type FindingIntentRecord,
    type FindingIntentStore,
    type ProductEnvironment,
    type ProductEnvironmentSettings,
    type SubmittedRecipe,
    type ProductEnvironmentStore,
    type RuntimeRepositorySettingsRecord,
    type RuntimeSettingsStore,
    type RuntimeWhoCanAsk,
} from '../domain/ports';
import { forkPolicyOf } from '../domain/fork-policy';
import type { RuntimePreviewSettingsStore } from '../domain/previews';
import type { PoolUsage } from '../domain/pool';
import { MAX_USD_PER_HOST_HOUR } from '../domain/run-cost';
import { parseTriggerRules, RUNTIME_MODES, type RuntimeMode } from '../domain/trigger-rules';
import {
    RuntimeEnvironmentModel,
    RuntimeEnvironmentRepositoryModel,
    RuntimeFindingFeedbackModel,
    RuntimeFindingIntentModel,
    RuntimeRepositorySettingsModel,
    RuntimeSettingsModel,
} from './runtime-product.models';

/** The ON CONFLICT guard of an upsert keyed without the org: the existing row is updated only when it is the same org's. */
const SAME_ORG = (alias: string) => `"${alias}"."organization_id" = EXCLUDED."organization_id"`;

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
    previewSecrets: m.previewSecrets === 'run' ? 'run' : 'none',
    suiteCi: typeof m.suiteCi === 'boolean' ? m.suiteCi : null,
    submittedRecipe: m.submittedRecipe ?? null,
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

    async getMany(organizationId: string, environmentIds: readonly string[]) {
        const ids = [...new Set(environmentIds.filter((id) => UUID.test(id)))];
        if (!ids.length) return [];
        return (await this.repo.find({ where: { uuid: In(ids), organizationId } })).map(toEnvironment);
    }

    async findByRepositories(organizationId: string, repositoryIds: readonly string[]) {
        const ids = [...new Set(repositoryIds)];
        if (!ids.length) return [];
        const rows = await this.repo.find({ where: { organizationId, repositoryId: In(ids) }, order: { createdAt: 'ASC' } });
        // One environment per repository, as findByRepository answers.
        const seen = new Set<string>();
        return rows.filter((m) => !seen.has(m.repositoryId) && seen.add(m.repositoryId)).map(toEnvironment);
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

    async setSubmittedRecipe(organizationId: string, environmentId: string, recipe: SubmittedRecipe) {
        await this.repo.update({ uuid: environmentId, organizationId }, { submittedRecipe: recipe });
    }

    async updateSettings(organizationId: string, environmentId: string, settings: ProductEnvironmentSettings) {
        // One UPDATE: a PATCH of several fields is never half applied.
        const set = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) as ProductEnvironmentSettings;
        if (!Object.keys(set).length) return;
        await this.repo.update({ uuid: environmentId, organizationId }, set);
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

const UNIQUE_VIOLATION = '23505';

/** The unique index a Postgres insert or update broke, when it broke one. */
const brokenUnique = (error: unknown): string | undefined => {
    const e = error as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
    const code = e?.code ?? e?.driverError?.code;
    return code === UNIQUE_VIOLATION ? (e?.constraint ?? e?.driverError?.constraint ?? '') : undefined;
};

const conflictOf = (constraint: string | undefined): EnvironmentRepositoryConflictError | undefined => {
    if (constraint === 'UQ_runtime_environment_repositories_primary') return new EnvironmentRepositoryConflictError('primary');
    if (constraint === 'UQ_runtime_environment_repositories_env_alias') return new EnvironmentRepositoryConflictError('alias');
    return undefined;
};

const toEnvironmentRepository = (m: RuntimeEnvironmentRepositoryModel): EnvironmentRepository => ({
    environmentId: m.environmentId,
    organizationId: m.organizationId,
    repositoryId: m.repositoryId,
    repositoryName: m.repositoryName,
    fullName: m.fullName,
    role: m.role,
    alias: m.alias,
    triggers: m.triggers,
    pairBranches: m.pairBranches,
    createdAt: new Date(m.createdAt).toISOString(),
    updatedAt: new Date(m.updatedAt).toISOString(),
});

/** The repositories of each environment (`runtime_environment_repositories`): org-scoped in every query. */
@Injectable()
export class TypeOrmEnvironmentRepositoryStore implements EnvironmentRepositoryStore {
    constructor(
        @InjectRepository(RuntimeEnvironmentRepositoryModel)
        private readonly repo: Repository<RuntimeEnvironmentRepositoryModel>,
        @InjectRepository(RuntimeEnvironmentModel)
        private readonly environments: Repository<RuntimeEnvironmentModel>,
    ) {}

    async listByEnvironment(organizationId: string, environmentId: string) {
        if (!UUID.test(environmentId)) return [];
        // 'primary' sorts after 'member': descending puts the primary first.
        const rows = await this.repo.find({ where: { organizationId, environmentId }, order: { role: 'DESC', alias: 'ASC' }, take: 100 });
        return rows.map(toEnvironmentRepository);
    }

    async listByRepository(organizationId: string, repositoryId: string) {
        const rows = await this.repo.find({ where: { organizationId, repositoryId }, order: { createdAt: 'ASC' }, take: 100 });
        return rows.map(toEnvironmentRepository);
    }

    async listByEnvironments(organizationId: string, environmentIds: readonly string[]) {
        const ids = [...new Set(environmentIds.filter((id) => UUID.test(id)))];
        if (!ids.length) return [];
        const rows = await this.repo.find({ where: { organizationId, environmentId: In(ids) }, order: { environmentId: 'ASC', role: 'DESC', alias: 'ASC' }, take: 100 * ids.length });
        return rows.map(toEnvironmentRepository);
    }

    async listByRepositories(organizationId: string, repositoryIds: readonly string[]) {
        const ids = [...new Set(repositoryIds)];
        if (!ids.length) return [];
        const rows = await this.repo.find({ where: { organizationId, repositoryId: In(ids) }, order: { createdAt: 'ASC' }, take: 100 * ids.length });
        return rows.map(toEnvironmentRepository);
    }

    async add(input: Omit<EnvironmentRepository, 'createdAt' | 'updatedAt'>) {
        if (!REPOSITORY_ALIAS_PATTERN.test(input.alias)) throw new Error('invalid repository alias');
        if (!UUID.test(input.environmentId)) return null;
        const { organizationId, environmentId, repositoryId } = input;
        try {
            // One transaction holding the environment's row (SELECT … FOR UPDATE): adds to one environment run one
            // after the other, so the count a member is checked against is the count it is inserted beside.
            const added = await this.repo.manager.transaction(async (tx) => {
                // The environment must be the org's: a row is never attached to another org's environment.
                const env = await tx.withRepository(this.environments).findOne({ where: { uuid: environmentId, organizationId }, select: { uuid: true }, lock: { mode: 'pessimistic_write' } });
                if (!env) return null;
                const rows = tx.withRepository(this.repo);
                const existing = await rows.findOne({ where: { organizationId, environmentId, repositoryId } });
                if (existing) return existing;
                // The primary always counts, its row written or not.
                if (input.role === 'member' && (await rows.count({ where: { environmentId, role: 'member' } })) >= MAX_WORKSPACE_REPOSITORIES - 1) {
                    throw new EnvironmentRepositoryConflictError('limit');
                }
                await rows.insert({
                    environmentId,
                    organizationId,
                    repositoryId,
                    repositoryName: input.repositoryName,
                    fullName: input.fullName,
                    role: input.role,
                    alias: input.alias,
                    triggers: input.triggers,
                    pairBranches: input.pairBranches,
                });
                return rows.findOne({ where: { organizationId, environmentId, repositoryId } });
            });
            return added ? toEnvironmentRepository(added) : null;
        } catch (error) {
            if (error instanceof EnvironmentRepositoryConflictError) throw error;
            const constraint = brokenUnique(error);
            if (constraint === undefined) throw error;
            const conflict = conflictOf(constraint);
            // The same repository added at the same time: the first one wins, as for a redelivered add.
            const raced = conflict ? null : await this.find(organizationId, environmentId, repositoryId);
            if (raced) return toEnvironmentRepository(raced);
            throw conflict ?? error;
        }
    }

    async remove(organizationId: string, environmentId: string, repositoryId: string) {
        if (!UUID.test(environmentId)) return false;
        const r = await this.repo.delete({ organizationId, environmentId, repositoryId, role: 'member' });
        return (r.affected ?? 0) > 0;
    }

    async update(organizationId: string, environmentId: string, repositoryId: string, patch: EnvironmentRepositoryPatch) {
        if (patch.alias !== undefined && !REPOSITORY_ALIAS_PATTERN.test(patch.alias)) throw new Error('invalid repository alias');
        if (!UUID.test(environmentId)) return null;
        const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as EnvironmentRepositoryPatch;
        if (Object.keys(set).length) {
            try {
                // One UPDATE: a patch of several fields is never half applied.
                await this.repo.update({ organizationId, environmentId, repositoryId }, set);
            } catch (error) {
                throw conflictOf(brokenUnique(error)) ?? error;
            }
        }
        const row = await this.find(organizationId, environmentId, repositoryId);
        return row ? toEnvironmentRepository(row) : null;
    }

    private find(organizationId: string, environmentId: string, repositoryId: string) {
        return this.repo.findOne({ where: { organizationId, environmentId, repositoryId } });
    }
}

@Injectable()
export class TypeOrmRuntimeSettingsStore implements RuntimeSettingsStore, RuntimePreviewSettingsStore, AutomaticRepositoriesReader {
    private readonly logger = createLogger(TypeOrmRuntimeSettingsStore.name);

    constructor(
        @InjectRepository(RuntimeSettingsModel)
        private readonly org: Repository<RuntimeSettingsModel>,
        @InjectRepository(RuntimeRepositorySettingsModel)
        private readonly repos: Repository<RuntimeRepositorySettingsModel>,
    ) {}

    async getOrganization(organizationId: string) {
        const m = await this.org.findOne({ where: { organizationId } });
        if (!m) return null;
        const percent = m.exercisedLinesThresholdPercent;
        const hostPrice = m.machineUsdPerHostHour === null || m.machineUsdPerHostHour === undefined ? NaN : Number(m.machineUsdPerHostHour);
        return {
            tokenBudgetPerDay: m.tokenBudgetPerDay === null ? null : Number(m.tokenBudgetPerDay),
            // A value outside 0..100 (written by hand) reads as unset: the deployment's applies.
            exercisedLinesThresholdPercent: typeof percent === 'number' && percent >= 0 && percent <= 100 ? percent : null,
            // A price of 0 or less, or above the most the API takes (written by hand), reads as unset: never a guessed cost.
            machineUsdPerHostHour: Number.isFinite(hostPrice) && hostPrice > 0 && hostPrice <= MAX_USD_PER_HOST_HOUR ? hostPrice : null,
            // Anything but a known value (written by hand) reads as unset: the default, which blocks.
            partlyTestedCheck: (PARTLY_TESTED_CHECKS as readonly string[]).includes(m.partlyTestedCheck ?? '') ? (m.partlyTestedCheck as PartlyTestedCheck) : null,
        };
    }

    async setTokenBudget(organizationId: string, tokenBudgetPerDay: number | null) {
        await this.org.upsert(
            { organizationId, tokenBudgetPerDay: tokenBudgetPerDay === null ? null : String(tokenBudgetPerDay) },
            { conflictPaths: ['organizationId'] },
        );
    }

    async setExercisedLinesThreshold(organizationId: string, percent: number | null) {
        // Only this column: the token budget and the preview settings of an existing row are kept.
        await this.org.upsert({ organizationId, exercisedLinesThresholdPercent: percent }, { conflictPaths: ['organizationId'] });
    }

    async setMachineUsdPerHostHour(organizationId: string, usdPerHour: number | null) {
        // Only this column: the other settings of an existing row are kept.
        await this.org.upsert({ organizationId, machineUsdPerHostHour: usdPerHour === null ? null : String(usdPerHour) }, { conflictPaths: ['organizationId'] });
    }

    async setPartlyTestedCheck(organizationId: string, check: PartlyTestedCheck | null) {
        // Only this column: the other settings of an existing row are kept.
        await this.org.upsert({ organizationId, partlyTestedCheck: check }, { conflictPaths: ['organizationId'] });
    }

    async getPreviewSettings(organizationId: string): Promise<PreviewSettings> {
        const m = await this.org.findOne({ where: { organizationId } });
        return previewSettingsOf(m?.preview);
    }

    async setPreviewSettings(organizationId: string, settings: PreviewSettings) {
        // Only the preview column: the token budget of an existing row is kept.
        await this.org.upsert({ organizationId, preview: PreviewSettingsSchema.parse(settings) }, { conflictPaths: ['organizationId'] });
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

    async listAutomaticAcrossOrganizations(limit: number): Promise<AutomaticRepositoryRow[]> {
        const rows = await this.repos.find({ where: { mode: 'rules' }, order: { organizationId: 'ASC', repositoryId: 'ASC' }, take: limit });
        return rows.map((m) => ({ organizationId: m.organizationId, repositoryId: m.repositoryId, updatedAt: new Date(m.updatedAt).toISOString() }));
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
        // The vote is keyed by Run, probe and user; a row of another org under the same key is never overwritten.
        await this.repo
            .createQueryBuilder('f')
            .insert()
            .values({ ...where, value: input.value })
            .orUpdate(['run_id', 'probe_id', 'user_id', 'organization_id', 'value'], ['run_id', 'probe_id', 'user_id'], { overwriteCondition: { where: SAME_ORG('f') } })
            .execute();
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
        // The mark is keyed by Run and probe; a row of another org under the same key is never overwritten.
        await this.repo
            .createQueryBuilder('i')
            .insert()
            .values({ ...where, userId: input.userId, updatedAt: new Date() })
            .orUpdate(['run_id', 'probe_id', 'organization_id', 'user_id', 'updatedAt'], ['run_id', 'probe_id'], { overwriteCondition: { where: SAME_ORG('i') } })
            .execute();
    }
}
